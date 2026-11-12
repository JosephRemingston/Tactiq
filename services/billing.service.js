import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import ApiError from "../utils/ApiError.js";
import { Logger } from "../utils/logger.js";
import PLANS from "../data/plans.json" with { type: "json" };
import { billingNotifications, entitlementAudit, entitlements, purchases, subscriptions } from "../models/index.js";
import { PurchaseNotFoundError } from "../configs/googlePlay.js";

const PRODUCTS = new Map(PLANS.products.map((p) => [p.productId, p]));

/** Thrown inside the purchase transaction when the token belongs to a different account; rolls everything back. */
class PurchaseOwnershipError extends Error {
  constructor() {
    super("purchase token belongs to another account");
    this.name = "PurchaseOwnershipError";
  }
}

/** States in which the user keeps Pro access (cancelled: until the paid-through date). */
const ENTITLED_STATES = new Set(["active", "grace", "cancelled"]);

/** Terminal states: a refunded (revoked) purchase token never grants access again; Google issues a new token instead. */
const TERMINAL_STATES = new Set(["revoked"]);

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

/**
 * How long a grace-period subscription keeps access beyond its reported expiry before the next store read must
 * confirm it again. Google keeps the user entitled during grace while it retries payment; reconciliation (daily) and
 * notifications refresh the state, so this is a rolling backstop rather than a fixed period.
 */
export const GRACE_BACKSTOP_MS = 3 * 86_400_000;

const validDate = (d) => d instanceof Date && Number.isFinite(d.getTime());

/**
 * Until when a store state grants Pro, or null for no access.
 *   active, cancelled: until the paid-through date, which must be a real future date
 *   grace:             still entitled (Google is retrying payment): the later of expiry and now + backstop
 *   anything else:     no access
 */
export function accessUntil(state, expiresAt, now = new Date()) {
  const expiry = expiresAt == null ? null : new Date(expiresAt);
  if (state === "grace") {
    // Anchored to the next UTC midnight so repeated reads on the same day give the same answer (no rewrites).
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const backstop = new Date(day + GRACE_BACKSTOP_MS);
    return validDate(expiry) && expiry > backstop ? expiry : backstop;
  }
  if (!ENTITLED_STATES.has(state) || !validDate(expiry) || expiry <= now) return null;
  return expiry;
}

export function isEntitled(state, expiresAt, now = new Date()) {
  return accessUntil(state, expiresAt, now) !== null;
}

/** A store answer that cannot be applied safely (e.g. an active subscription with no expiry). Never grants access. */
export class StoreResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreResponseError";
  }
}

const KNOWN_STATES = new Set(["pending", "active", "grace", "on_hold", "paused", "cancelled", "expired", "revoked"]);

/** Rejects store answers that would otherwise be applied with missing or impossible data. */
export function assertStoreResponse(v) {
  if (!v || typeof v.productId !== "string" || !v.productId) throw new StoreResponseError("store response has no product");
  if (!KNOWN_STATES.has(v.state)) throw new StoreResponseError("store response has an unknown state");
  const needsExpiry = ["active", "grace", "cancelled", "on_hold", "paused"].includes(v.state);
  if (needsExpiry && !validDate(v.expiresAt == null ? null : new Date(v.expiresAt))) {
    throw new StoreResponseError("store response has no valid expiry");
  }
}

/**
 * The account id the app passes to Google Play (BillingFlowParams.setObfuscatedAccountId).
 * Google returns it with the purchase, so a token cannot be redeemed by a different account.
 */
export function obfuscatedAccountId(userId) {
  return createHash("sha256").update(`tactiq:${userId}`).digest("hex");
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
    if (!product) throw ApiError.badRequest("Unknown product", [{ path: "productId", message: "Not a Tactiq product" }]);

    const [existing] = await this.db.select().from(purchases).where(and(eq(purchases.store, "google_play"), eq(purchases.purchaseToken, purchaseToken)));
    if (existing && existing.userId !== userId) {
      await this.security.record("purchase_token_reuse", { userId, ip: meta.ip, metadata: { productId, ownerUserId: existing.userId } });
      throw ApiError.conflict("This purchase is linked to another account");
    }

    let verified;
    const fetchedAt = new Date(); // taken before asking the store: newer reads always win, whatever order replies arrive in
    try {
      verified = { ...(await this.verifier.getSubscription(purchaseToken)), fetchedAt };
    } catch (err) {
      if (err instanceof PurchaseNotFoundError) throw ApiError.badRequest("The store does not recognise this purchase");
      throw ApiError.unavailable("Could not reach the store to verify the purchase");
    }
    if (verified.productId !== productId) throw ApiError.badRequest("The purchase is for a different product");
    try {
      assertStoreResponse(verified);
    } catch {
      // Never grant on an incomplete answer; the app can retry and reconciliation will re-read it.
      throw ApiError.unavailable("The store returned an incomplete answer; try again shortly");
    }
    if (verified.obfuscatedAccountId && verified.obfuscatedAccountId !== obfuscatedAccountId(userId)) {
      await this.security.record("purchase_account_mismatch", { userId, ip: meta.ip, metadata: { productId } });
      throw ApiError.forbidden("This purchase was made for a different account", "PURCHASE_ACCOUNT_MISMATCH");
    }

    let purchase;
    try {
      purchase = await this.applyState(userId, purchaseToken, product, verified, "verify");
    } catch (err) {
      if (!(err instanceof PurchaseOwnershipError)) throw err;
      await this.security.record("purchase_token_reuse", { userId, ip: meta.ip, metadata: { productId, concurrent: true } });
      throw ApiError.conflict("This purchase is linked to another account");
    }
    await this.fault("afterCommit");
    await this.acknowledgeIfNeeded(purchase, verified);
    await this.fault("afterAcknowledge");
    await this.security.record("purchase_verified", { userId, ip: meta.ip, metadata: { productId, state: purchase.state } });
    const [fresh] = await this.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    return { purchase: this.purchaseView(fresh), plan: await this.entitlements.currentPlan(userId) };
  }

  /** POST /v1/billing/restore: re-reads every known purchase of the user (new device, reinstall). */
  async restore(userId, meta = {}) {
    this.requireConfigured();
    const rows = await this.db.select().from(purchases).where(eq(purchases.userId, userId));
    const results = [];
    try {
      for (const row of rows) results.push(await this.refreshPurchase(row, "restore"));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Google unreachable: nothing was changed for the purchases not yet re-read; the app can simply retry.
      throw ApiError.unavailable("Could not reach the store to restore purchases");
    }
    await this.security.record("purchases_restored", { userId, ip: meta.ip, metadata: { count: rows.length } });
    return { purchases: results.filter(Boolean).map((p) => this.purchaseView(p)), plan: await this.entitlements.currentPlan(userId) };
  }

  /** Test hook: called at named points of the purchase flow so tests can simulate a crash there. */
  async fault(point) {
    if (this.faultInjector) await this.faultInjector(point);
  }

  /** Re-reads one stored purchase from the store and applies it. Returns the updated row (or null if gone). */
  async refreshPurchase(row, reason, forcedState = null) {
    const fetchedAt = new Date();
    let verified;
    try {
      verified = await this.verifier.getSubscription(row.purchaseToken);
    } catch (err) {
      if (!(err instanceof PurchaseNotFoundError)) throw err;
      verified = { ...this.fromRow(row), state: "expired" };
    }
    verified = { ...verified, fetchedAt };
    if (forcedState) verified = { ...verified, state: forcedState };
    const product = PRODUCTS.get(verified.productId) ?? PRODUCTS.get(row.productId);
    if (!product) return null;
    if (!forcedState) assertStoreResponse(verified);
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

  /**
   * Google refunds purchases that are not acknowledged within three days, so every purchase that grants access is
   * acknowledged, only after it has been verified and committed. Acknowledging is safe to repeat: if Google already
   * has it (for example our earlier call succeeded but its response was lost), the store read reports it and we
   * simply record it.
   */
  async acknowledgeIfNeeded(purchase, verified) {
    if (purchase.stale) return;
    if (verified.acknowledged || purchase.acknowledged || !isEntitled(purchase.state, purchase.expiresAt)) return;
    try {
      await this.verifier.acknowledge(purchase.productId, purchase.purchaseToken);
      await this.db.update(purchases).set({ acknowledged: true }).where(eq(purchases.id, purchase.id));
    } catch (err) {
      // Not fatal: reconciliation re-reads the purchase (which reports Google's acknowledgement state) and retries.
      this.logger.warn(`acknowledge failed for purchase ${purchase.id}: ${err.message}`);
    }
  }

  /**
   * Applies one store answer to a purchase, its subscription and its grants. The only writer of billing state:
   * verification, restore, notifications and reconciliation all go through here.
   *
   * Guarantees:
   *   - serialized per purchase token (transaction-scoped advisory lock), so concurrent writers cannot interleave;
   *   - monotonic: an answer requested before the one already applied is discarded (out-of-order replies);
   *   - terminal states stay terminal (a revoked purchase never grants again);
   *   - idempotent: rows are written only when the answer changes them, so repeats leave no trace;
   *   - one subscription per token and one grant per feature, also enforced by unique indexes.
   */
  async applyState(userId, purchaseToken, product, v, reason) {
    const now = new Date();
    const fetchedAt = v.fetchedAt instanceof Date ? v.fetchedAt : now;
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"purchase:" + purchaseToken}, 0))`);
      const [existing] = await tx.select().from(purchases).where(and(eq(purchases.store, "google_play"), eq(purchases.purchaseToken, purchaseToken)));

      // A token that already belongs to another account is never re-pointed or granted twice.
      if (existing && existing.userId !== userId) throw new PurchaseOwnershipError();
      // Out of order: newer information has already been applied; this older answer changes nothing.
      // A refund (terminal state) is never discarded as stale: a newer read cannot un-refund a purchase.
      if (existing && existing.lastVerifiedAt > fetchedAt && !TERMINAL_STATES.has(v.state)) return { ...existing, stale: true };

      let state = v.state;
      let expiresAt = v.expiresAt ?? null;
      if (existing && TERMINAL_STATES.has(existing.state) && state !== existing.state) {
        state = existing.state;
        expiresAt = existing.expiresAt;
      }
      // A token that a granted replacement (upgrade, downgrade, resubscribe) superseded is finished: a late or stale
      // answer for the old token must never bring it back next to the new one.
      if (existing && state !== "expired" && !TERMINAL_STATES.has(state)) {
        const [successor] = await tx
          .select({ id: purchases.id })
          .from(purchases)
          .where(and(eq(purchases.linkedPurchaseToken, purchaseToken), eq(purchases.userId, userId), sql`${purchases.subscriptionId} is not null`))
          .limit(1);
        if (successor) {
          state = "expired";
          expiresAt = existing.expiresAt;
        }
      }
      const until = accessUntil(state, expiresAt, now);

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
          state,
          autoRenewing: Boolean(v.autoRenewing),
          acknowledged: Boolean(v.acknowledged),
          startedAt: v.startedAt ?? null,
          expiresAt,
          lastVerifiedAt: fetchedAt,
          raw: v.raw ?? null,
        })
        .onConflictDoUpdate({
          target: [purchases.store, purchases.purchaseToken],
          set: {
            state,
            orderId: v.orderId ?? sql`${purchases.orderId}`,
            autoRenewing: Boolean(v.autoRenewing),
            acknowledged: sql`${purchases.acknowledged} or ${Boolean(v.acknowledged)}`,
            expiresAt,
            linkedPurchaseToken: v.linkedPurchaseToken ?? sql`${purchases.linkedPurchaseToken}`,
            lastVerifiedAt: sql`greatest(${purchases.lastVerifiedAt}, ${fetchedAt})`,
            raw: v.raw ?? sql`${purchases.raw}`,
            updatedAt: now,
          },
        })
        .returning();
      // Defence in depth: the lock above already guarantees this.
      if (purchase.userId !== userId) throw new PurchaseOwnershipError();

      // A replacement purchase (upgrade, downgrade, resubscribe) ends the token it replaces, but only once the
      // replacement itself grants access: a pending or failed replacement must not cut off paid access.
      if (v.linkedPurchaseToken && until) await this.endReplaced(tx, userId, v.linkedPurchaseToken, purchaseToken, now, reason);

      let subscriptionId = purchase.subscriptionId;
      if (!subscriptionId && until) {
        const [created] = await tx
          .insert(subscriptions)
          .values({
            userId,
            planKey: product.planKey,
            status: state,
            source: "google_play",
            providerSubscriptionId: purchaseToken,
            startedAt: v.startedAt ?? now,
            currentPeriodEnd: until,
          })
          .onConflictDoNothing()
          .returning();
        const sub =
          created ??
          (await tx.select().from(subscriptions).where(and(eq(subscriptions.source, "google_play"), eq(subscriptions.providerSubscriptionId, purchaseToken))))[0];
        subscriptionId = sub.id;
        const features = await this.entitlements.planFeatures(product.planKey);
        const granted = await tx
          .insert(entitlements)
          .values(
            Object.entries(features).map(([featureKey, f]) => ({
              userId,
              featureKey,
              limitValue: f.limitValue,
              usagePeriod: f.usagePeriod,
              sourcePlan: product.planKey,
              sourceSubscriptionId: sub.id,
              validUntil: until,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: entitlements.id });
        await tx.update(purchases).set({ subscriptionId }).where(eq(purchases.id, purchase.id));
        if (granted.length) {
          await tx.insert(entitlementAudit).values({
            userId,
            action: "grant",
            after: { planKey: product.planKey, subscriptionId, state, until, reason },
            actor: `google_play:${reason}`,
          });
        }
      } else if (subscriptionId) {
        await this.syncSubscription(tx, { userId, subscriptionId, planKey: product.planKey, state, periodEnd: until ?? expiresAt, until, reason, now });
      }
      await this.fault("beforeCommit");
      return { ...purchase, subscriptionId };
    });
    // After commit only: never invalidate for a rolled-back change. A failed invalidation leaves at most one cache
    // TTL (60 s) of stale access, never indefinite access: resolution also checks valid_until itself.
    if (!result.stale) await this.entitlements.invalidate(userId);
    return result;
  }

  /**
   * Makes a subscription row and its grants match a state. Only rows that actually differ are written, and an
   * audit row is added only when grants change, so replaying the same state is a no-op.
   */
  async syncSubscription(tx, { userId, subscriptionId, planKey, state, periodEnd, until, reason, now }) {
    await tx
      .update(subscriptions)
      .set({
        status: state,
        currentPeriodEnd: periodEnd,
        cancelledAt: ["cancelled", "revoked"].includes(state) ? sql`coalesce(${subscriptions.cancelledAt}, now())` : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          sql`(${subscriptions.status} is distinct from ${state} or ${subscriptions.currentPeriodEnd} is distinct from ${periodEnd})`,
        ),
      );
    const grantStatus = until ? "active" : state === "expired" ? "expired" : "revoked";
    const changed = await tx
      .update(entitlements)
      .set({
        status: grantStatus,
        validUntil: until ?? sql`${entitlements.validUntil}`,
        revokedAt: until ? null : sql`coalesce(${entitlements.revokedAt}, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(entitlements.sourceSubscriptionId, subscriptionId),
          until
            ? sql`(${entitlements.status} is distinct from ${grantStatus} or ${entitlements.validUntil} is distinct from ${until})`
            : sql`${entitlements.status} is distinct from ${grantStatus}`,
        ),
      )
      .returning({ id: entitlements.id });
    if (changed.length) {
      await tx.insert(entitlementAudit).values({
        userId,
        action: until ? "plan_change" : state === "expired" ? "expire" : "revoke",
        after: { planKey, subscriptionId, state, until, reason },
        actor: `google_play:${reason}`,
      });
    }
    return changed.length;
  }

  /** Ends the purchase a replacement supersedes (same account only); its records stay for audit. */
  async endReplaced(tx, userId, oldToken, newToken, now, reason) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"purchase:" + oldToken}, 0))`);
    const [old] = await tx
      .update(purchases)
      .set({ state: "expired", updatedAt: now })
      .where(and(eq(purchases.purchaseToken, oldToken), eq(purchases.userId, userId), sql`${purchases.state} <> 'revoked'`))
      .returning();
    if (old?.subscriptionId) {
      await this.syncSubscription(tx, {
        userId,
        subscriptionId: old.subscriptionId,
        planKey: old.planKey,
        state: "expired",
        periodEnd: old.expiresAt,
        until: null,
        reason: `${reason}:replaced`,
        now,
      });
    }
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
    if (this.config.GOOGLE_PLAY_PACKAGE_NAME && data.packageName !== this.config.GOOGLE_PLAY_PACKAGE_NAME) {
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
      // SUBSCRIPTION_REVOKED always ends access. A voided purchase does only when it refunds the current order:
      // a refund of an older renewal leaves the running subscription alone (its state is re-read from Google).
      const voidsCurrentOrder = voided && voided.orderId && purchase.orderId && voided.orderId === purchase.orderId;
      const forced = sub?.notificationType === 12 || voidsCurrentOrder ? "revoked" : null;
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
      .orderBy(purchases.lastVerifiedAt)
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
