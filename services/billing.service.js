import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import ApiError from "../utils/ApiError.js";
import { Logger } from "../utils/logger.js";
import PLANS from "../data/plans.json" with { type: "json" };
import { billingNotifications, entitlementAudit, entitlements, purchases, subscriptions } from "../models/index.js";
import { PurchaseNotFoundError } from "../configs/googlePlay.js";

const PRODUCTS = new Map(PLANS.products.map((p) => [p.productId, p]));

/** States in which the user keeps Pro access (cancelled: until the paid-through date). */
const ENTITLED_STATES = new Set(["active", "grace", "cancelled"]);

/** Google Play RTDN subscription notification types (PDF section 8). */
const RTDN_TYPES = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isEntitled(state, expiresAt, now = new Date()) {
  return ENTITLED_STATES.has(state) && (!expiresAt || new Date(expiresAt) > now);
}

/**
 * The account id the app passes to Google Play (BillingFlowParams.setObfuscatedAccountId).
 * Google returns it with the purchase, so a token cannot be redeemed by a different account.
 */
export function obfuscatedAccountId(userId) {
  return createHash("sha256").update(`touchline:${userId}`).digest("hex");
}

/**
 * Google Play subscriptions (PDF section 8). The client's "purchase succeeded" is never trusted: every change
 * is read back from the store, recorded in `purchases`, and turned into subscription and entitlement rows.
 * All writes are idempotent, so the same token can be verified, restored or notified any number of times.
 */
export class BillingService {
  constructor(db, entitlementsService, security, verifier, config) {
    this.db = db;
    this.entitlements = entitlementsService;
    this.security = security;
    this.verifier = verifier;
    this.config = config;
    this.logger = new Logger("Billing");
  }

  configured() {
    return this.verifier !== null;
  }

  requireConfigured() {
    if (!this.configured()) throw ApiError.unavailable("Billing is not configured yet", "BILLING_NOT_CONFIGURED");
  }

  /** Plan catalogue for the paywall screen: store products and the Free vs Pro comparison. */
  async products() {
    const plans = await Promise.all(
      PLANS.plans.map(async (p) => ({
        planKey: p.planKey,
        name: p.name,
        features: await this.entitlements.planFeatures(p.planKey),
        products: PLANS.products.filter((x) => x.planKey === p.planKey).map(({ productId, store, billingPeriod }) => ({ productId, store, billingPeriod })),
      })),
    );
    return { billingAvailable: this.configured(), plans, comparison: PLANS.catalogue };
  }

  /** Current plan plus the store purchase behind it, if any. */
  async subscription(userId) {
    const plan = await this.entitlements.currentPlan(userId);
    const [latest] = await this.db
      .select()
      .from(purchases)
      .where(eq(purchases.userId, userId))
      .orderBy(sql`${purchases.updatedAt} desc`)
      .limit(1);
    const packageName = this.config.GOOGLE_PLAY_PACKAGE_NAME;
    return {
      plan,
      billingAvailable: this.configured(),
      billingProvider: latest ? latest.store : null,
      obfuscatedAccountId: obfuscatedAccountId(userId),
      purchase: latest ? this.purchaseView(latest) : null,
      manageUrl:
        latest && packageName
          ? `https://play.google.com/store/account/subscriptions?sku=${encodeURIComponent(latest.productId)}&package=${encodeURIComponent(packageName)}`
          : null,
    };
  }

  purchaseView(p) {
    return {
      productId: p.productId,
      planKey: p.planKey,
      state: p.state,
      entitled: isEntitled(p.state, p.expiresAt),
      autoRenewing: p.autoRenewing,
      expiresAt: p.expiresAt?.toISOString?.() ?? p.expiresAt ?? null,
      lastVerifiedAt: p.lastVerifiedAt?.toISOString?.() ?? p.lastVerifiedAt ?? null,
    };
  }

  /** POST /v1/billing/google-play/verify: called by the app after the Play purchase flow returns a token. */
  async verifyPurchase(userId, { productId, purchaseToken }, meta = {}) {
    this.requireConfigured();
    const product = PRODUCTS.get(productId);
    if (!product) throw ApiError.badRequest("Unknown product", [{ path: "productId", message: "Not a Touchline product" }]);

    const [existing] = await this.db.select().from(purchases).where(and(eq(purchases.store, "google_play"), eq(purchases.purchaseToken, purchaseToken)));
    if (existing && existing.userId !== userId) {
      await this.security.record("purchase_token_reuse", { userId, ip: meta.ip, metadata: { productId, ownerUserId: existing.userId } });
      throw ApiError.conflict("This purchase is linked to another account");
    }

    let verified;
    try {
      verified = await this.verifier.getSubscription(purchaseToken);
    } catch (err) {
      if (err instanceof PurchaseNotFoundError) throw ApiError.badRequest("The store does not recognise this purchase");
      throw ApiError.unavailable("Could not reach the store to verify the purchase");
    }
    if (verified.productId !== productId) throw ApiError.badRequest("The purchase is for a different product");
    if (verified.obfuscatedAccountId && verified.obfuscatedAccountId !== obfuscatedAccountId(userId)) {
      await this.security.record("purchase_account_mismatch", { userId, ip: meta.ip, metadata: { productId } });
      throw ApiError.forbidden("This purchase was made for a different account", "PURCHASE_ACCOUNT_MISMATCH");
    }

    const purchase = await this.applyState(userId, purchaseToken, product, verified, "verify");
    await this.acknowledgeIfNeeded(purchase, verified);
    await this.security.record("purchase_verified", { userId, ip: meta.ip, metadata: { productId, state: purchase.state } });
    const [fresh] = await this.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    return { purchase: this.purchaseView(fresh), plan: await this.entitlements.currentPlan(userId) };
  }

  /** POST /v1/billing/restore: re-reads every known purchase of the user (new device, reinstall). */
  async restore(userId, meta = {}) {
    this.requireConfigured();
    const rows = await this.db.select().from(purchases).where(eq(purchases.userId, userId));
    const results = [];
    for (const row of rows) results.push(await this.refreshPurchase(row, "restore"));
    await this.security.record("purchases_restored", { userId, ip: meta.ip, metadata: { count: rows.length } });
    return { purchases: results.filter(Boolean).map((p) => this.purchaseView(p)), plan: await this.entitlements.currentPlan(userId) };
  }

  /** Re-reads one stored purchase from the store and applies it. Returns the updated row (or null if gone). */
  async refreshPurchase(row, reason, forcedState = null) {
    const product = PRODUCTS.get(row.productId);
    if (!product) return null;
    let verified;
    try {
      verified = await this.verifier.getSubscription(row.purchaseToken);
    } catch (err) {
      if (!(err instanceof PurchaseNotFoundError)) throw err;
      verified = { ...this.fromRow(row), state: "expired" };
    }
    if (forcedState) verified = { ...verified, state: forcedState };
    const updated = await this.applyState(row.userId, row.purchaseToken, product, verified, reason);
    await this.acknowledgeIfNeeded(updated, verified);
    return updated;
  }

  fromRow(row) {
    return {
      productId: row.productId,
      state: row.state,
      startedAt: row.startedAt,
      expiresAt: row.expiresAt,
      orderId: row.orderId,
      autoRenewing: row.autoRenewing,
      acknowledged: row.acknowledged,
      linkedPurchaseToken: row.linkedPurchaseToken,
      raw: row.raw,
    };
  }

  /** Google refunds unacknowledged purchases after three days, so every paid purchase is acknowledged once. */
  async acknowledgeIfNeeded(purchase, verified) {
    if (verified.acknowledged || purchase.acknowledged || purchase.state === "pending" || !isEntitled(purchase.state, purchase.expiresAt)) return;
    try {
      await this.verifier.acknowledge(purchase.productId, purchase.purchaseToken);
      await this.db.update(purchases).set({ acknowledged: true }).where(eq(purchases.id, purchase.id));
    } catch (err) {
      // Not fatal: the reconcile job retries acknowledgement.
      this.logger.warn(`acknowledge failed for purchase ${purchase.id}: ${err.message}`);
    }
  }

  /**
   * Records the store state of a purchase and makes subscriptions and entitlements match it, in one transaction.
   * Entitled states keep one active grant set valid until the paid-through date; any other state deactivates it.
   */
  async applyState(userId, purchaseToken, product, v, reason) {
    const now = new Date();
    const entitled = isEntitled(v.state, v.expiresAt, now);
    const result = await this.db.transaction(async (tx) => {
      const [purchase] = await tx
        .insert(purchases)
        .values({
          userId,
          store: "google_play",
          productId: product.productId,
          planKey: product.planKey,
          purchaseToken,
          linkedPurchaseToken: v.linkedPurchaseToken ?? null,
          orderId: v.orderId ?? null,
          state: v.state,
          autoRenewing: Boolean(v.autoRenewing),
          acknowledged: Boolean(v.acknowledged),
          startedAt: v.startedAt ?? null,
          expiresAt: v.expiresAt ?? null,
          lastVerifiedAt: now,
          raw: v.raw ?? null,
        })
        .onConflictDoUpdate({
          target: [purchases.store, purchases.purchaseToken],
          set: {
            state: v.state,
            orderId: v.orderId ?? null,
            autoRenewing: Boolean(v.autoRenewing),
            acknowledged: sql`${purchases.acknowledged} or ${Boolean(v.acknowledged)}`,
            expiresAt: v.expiresAt ?? null,
            linkedPurchaseToken: v.linkedPurchaseToken ?? null,
            lastVerifiedAt: now,
            raw: v.raw ?? null,
            updatedAt: now,
          },
        })
        .returning();

      // An upgrade, downgrade or resubscribe replaces the old token: its access ends now.
      if (v.linkedPurchaseToken) {
        const [old] = await tx
          .update(purchases)
          .set({ state: "expired", updatedAt: now })
          .where(and(eq(purchases.purchaseToken, v.linkedPurchaseToken), eq(purchases.userId, userId)))
          .returning();
        if (old?.subscriptionId) await this.setGrants(tx, old.subscriptionId, "expired", null, now);
      }

      let subscriptionId = purchase.subscriptionId;
      if (!subscriptionId && entitled) {
        const [sub] = await tx
          .insert(subscriptions)
          .values({
            userId,
            planKey: product.planKey,
            status: v.state,
            source: "google_play",
            providerSubscriptionId: purchaseToken,
            startedAt: v.startedAt ?? now,
            currentPeriodEnd: v.expiresAt ?? null,
          })
          .returning();
        subscriptionId = sub.id;
        const features = await this.entitlements.planFeatures(product.planKey);
        await tx.insert(entitlements).values(
          Object.entries(features).map(([featureKey, f]) => ({
            userId,
            featureKey,
            limitValue: f.limitValue,
            usagePeriod: f.usagePeriod,
            sourcePlan: product.planKey,
            sourceSubscriptionId: sub.id,
            validUntil: v.expiresAt ?? null,
          })),
        );
        await tx.update(purchases).set({ subscriptionId }).where(eq(purchases.id, purchase.id));
        await tx.insert(entitlementAudit).values({
          userId,
          action: "grant",
          after: { planKey: product.planKey, subscriptionId, state: v.state, until: v.expiresAt, reason },
          actor: `google_play:${reason}`,
        });
      } else if (subscriptionId) {
        await tx
          .update(subscriptions)
          .set({
            status: v.state,
            currentPeriodEnd: v.expiresAt ?? null,
            cancelledAt: ["cancelled", "revoked"].includes(v.state) ? sql`coalesce(${subscriptions.cancelledAt}, now())` : null,
            updatedAt: now,
          })
          .where(eq(subscriptions.id, subscriptionId));
        const changed = await this.setGrants(tx, subscriptionId, entitled ? "active" : v.state === "expired" ? "expired" : "revoked", v.expiresAt, now);
        if (changed) {
          await tx.insert(entitlementAudit).values({
            userId,
            action: entitled ? "plan_change" : v.state === "expired" ? "expire" : "revoke",
            after: { planKey: product.planKey, subscriptionId, state: v.state, until: v.expiresAt, reason },
            actor: `google_play:${reason}`,
          });
        }
      }
      return { ...purchase, subscriptionId };
    });
    await this.entitlements.invalidate(userId);
    return result;
  }

  /** Sets the status (and validity) of every grant of one subscription. Returns the number of rows changed. */
  async setGrants(tx, subscriptionId, status, validUntil, now) {
    const rows = await tx
      .update(entitlements)
      .set({
        status,
        validUntil: validUntil ?? sql`${entitlements.validUntil}`,
        revokedAt: status === "active" ? null : now,
        updatedAt: now,
      })
      .where(eq(entitlements.sourceSubscriptionId, subscriptionId))
      .returning({ id: entitlements.id });
    return rows.length;
  }

  /**
   * Google Play Real-time Developer Notifications, pushed by Pub/Sub. The push URL carries a shared token;
   * the notification itself is only a hint, so the full state is always read back from the store.
   * Returns { status } for logging; throws ApiError for responses Pub/Sub should see.
   */
  async handleRtdn(body, presentedToken) {
    const expected = this.config.GOOGLE_PLAY_RTDN_TOKEN;
    if (!expected) throw ApiError.unavailable("Billing notifications are not configured", "BILLING_NOT_CONFIGURED");
    if (!safeEqual(presentedToken, expected)) throw ApiError.unauthorized("Invalid notification token");
    this.requireConfigured();

    const message = body?.message;
    if (!message?.messageId || typeof message.data !== "string") throw ApiError.badRequest("Not a Pub/Sub push message");
    let data;
    try {
      data = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
    } catch {
      throw ApiError.badRequest("Notification data is not valid JSON");
    }
    if (this.config.GOOGLE_PLAY_PACKAGE_NAME && data.packageName && data.packageName !== this.config.GOOGLE_PLAY_PACKAGE_NAME) {
      throw ApiError.badRequest("Notification is for a different app");
    }

    const sub = data.subscriptionNotification;
    const voided = data.voidedPurchaseNotification;
    const purchaseToken = sub?.purchaseToken ?? voided?.purchaseToken ?? null;
    const type = sub ? (RTDN_TYPES[sub.notificationType] ?? `SUBSCRIPTION_${sub.notificationType}`) : voided ? "VOIDED_PURCHASE" : data.testNotification ? "TEST" : "OTHER";

    // Idempotency: one row per Pub/Sub message id. A message already processed or ignored is not re-run.
    const [row] = await this.db
      .insert(billingNotifications)
      .values({ store: "google_play", messageId: message.messageId, notificationType: type, purchaseToken, payload: data })
      .onConflictDoUpdate({ target: [billingNotifications.store, billingNotifications.messageId], set: { receivedAt: sql`${billingNotifications.receivedAt}` } })
      .returning();
    if (row.status === "processed" || row.status === "ignored") return { status: "duplicate" };

    const finish = (status, error = null) =>
      this.db.update(billingNotifications).set({ status, error, processedAt: new Date() }).where(eq(billingNotifications.id, row.id));

    if (!purchaseToken) {
      await finish("ignored");
      return { status: "ignored" };
    }
    const [purchase] = await this.db.select().from(purchases).where(and(eq(purchases.store, "google_play"), eq(purchases.purchaseToken, purchaseToken)));
    if (!purchase) {
      // Not linked to an account yet: the app verifies it right after the purchase flow.
      await finish("ignored");
      return { status: "ignored" };
    }
    try {
      const forced = voided || sub?.notificationType === 12 ? "revoked" : null;
      await this.refreshPurchase(purchase, `rtdn:${type}`, forced);
      await finish("processed");
      return { status: "processed" };
    } catch (err) {
      await finish("failed", err.message?.slice(0, 500) ?? "error");
      // A 5xx makes Pub/Sub redeliver the message.
      throw ApiError.unavailable("Notification could not be processed yet");
    }
  }

  /**
   * Daily job: re-reads purchases that may have changed without a notification reaching us
   * (missed RTDN, renewals, expiries) and retries pending acknowledgements.
   */
  async reconcile(now = new Date()) {
    if (!this.configured()) return { skipped: true, reason: "billing not configured" };
    const due = await this.db
      .select()
      .from(purchases)
      .where(
        and(
          inArray(purchases.state, ["pending", "active", "grace", "on_hold", "paused", "cancelled"]),
          or(
            lt(purchases.lastVerifiedAt, sql`now() - interval '12 hours'`),
            lt(purchases.expiresAt, sql`now() + interval '1 day'`),
            eq(purchases.acknowledged, false),
          ),
        ),
      )
      .limit(500);
    let refreshed = 0;
    let failed = 0;
    for (const row of due) {
      try {
        await this.refreshPurchase(row, "reconcile");
        refreshed += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(`reconcile failed for purchase ${row.id}: ${err.message}`);
      }
    }
    return { checked: due.length, refreshed, failed, at: now.toISOString() };
  }
}
