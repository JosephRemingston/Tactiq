// Payment integrity: idempotency, real concurrency, out-of-order and duplicated store answers, refunds, plan
// changes, acknowledgement, crash points, reconciliation, cache consistency and database constraints.
// The store is the fake verifier (no real purchase, refund or financial operation ever happens); everything
// else is real: Express, Postgres transactions, advisory locks and unique indexes.
import { SKIP, startTestApp } from "./support/harness.js";
import { describe, it, before, after, beforeEach, afterEach, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";

describe("payments", { skip: SKIP ?? false }, () => {
  let t;
  let billing;
  let verifier;
  let featureCount;

  before(async () => {
    t = await startTestApp();
    billing = t.services().billing;
    verifier = billing.verifier;
    featureCount = Object.keys(await t.services().entitlements.planFeatures("pro_monthly")).length;
  });
  after(async () => t?.close());
  beforeEach(() => verifier.failWith(null));
  afterEach(() => {
    billing.faultInjector = null;
  });

  const token = (product = "pro_monthly", state = "active", days = 30, account = "") =>
    `fake:${product}:${state}:${days}:${account}:${randomBytes(6).toString("hex")}`;
  const verifyHttp = (user, productId, purchaseToken) =>
    t.call("POST", "/v1/billing/google-play/verify", { token: user.token, body: { productId, purchaseToken } });
  const verifySvc = (user, productId, purchaseToken) => billing.verifyPurchase(user.id, { productId, purchaseToken }, {});
  const plan = async (user) => (await t.get("/v1/me", { token: user.token })).body.data.user.plan.key;
  const msg = () => `m-${randomBytes(8).toString("hex")}`;
  const sub = (purchaseToken, notificationType, subscriptionId = "pro_monthly") => ({
    subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId },
  });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms = 5000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("condition not reached");
      await pause(2);
    }
  };
  const rows = async (q) => (await t.db.execute(q)).rows;
  /** Everything a purchase token produced, for idempotency assertions. */
  const ledger = async (purchaseToken, userId) =>
    (
      await rows(t.sql`
        select (select count(*)::int from purchases where purchase_token = ${purchaseToken}) as purchases,
               (select count(*)::int from subscriptions where provider_subscription_id = ${purchaseToken}) as subscriptions,
               (select count(distinct user_id)::int from subscriptions where provider_subscription_id = ${purchaseToken}) as owners,
               (select count(*)::int from entitlements e join subscriptions s on s.id = e.source_subscription_id
                 where s.provider_subscription_id = ${purchaseToken}) as grants,
               (select count(*)::int from entitlements e join subscriptions s on s.id = e.source_subscription_id
                 where s.provider_subscription_id = ${purchaseToken} and e.status = 'active') as active_grants,
               (select count(*)::int from entitlement_audit where user_id = ${userId}) as audit,
               (select count(*)::int from entitlement_audit where user_id = ${userId} and action = 'grant') as grant_audit`)
    )[0];
  const purchaseRow = async (purchaseToken) => (await rows(t.sql`select * from purchases where purchase_token = ${purchaseToken}`))[0];
  const pgCode = async (q) => {
    try {
      await t.db.execute(q);
      return null;
    } catch (err) {
      return err.code ?? err.cause?.code ?? "unknown";
    }
  };
  /** Captures everything written to the console while `fn` runs. */
  const captureLogs = async (fn) => {
    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
    try {
      await fn();
    } finally {
      Object.assign(console, orig);
    }
    return lines.join("\n");
  };
  const crashAt = (point) => {
    billing.faultInjector = async (p) => {
      if (p === point) throw new Error(`simulated crash at ${p}`);
    };
  };

  describe("idempotent verification", () => {
    it("the same token verified 10 times in a row grants once and writes one grant audit row", async () => {
      const u = await t.newUser("seq10");
      const tk = token();
      const baseline = (await ledger(tk, u.id)).audit; // the Free plan granted at sign-up
      for (let i = 0; i < 10; i++) expect((await verifyHttp(u, "pro_monthly", tk)).status).toBe(200);
      expect(await ledger(tk, u.id)).toMatchObject({ purchases: 1, subscriptions: 1, grants: featureCount, active_grants: featureCount, audit: baseline + 1, grant_audit: 1 });
      expect(await plan(u)).toBe("pro_monthly");
    });

    for (const n of [2, 10, 50, 100]) {
      it(`${n} parallel verifications of one token by its owner produce one subscription and one set of grants`, async () => {
        const u = await t.newUser(`par${n}`);
        const tk = token();
        // Through the service: the HTTP route is limited to 20 verifications a minute per user.
        const results = await Promise.allSettled(Array.from({ length: n }, () => verifySvc(u, "pro_monthly", tk)));
        expect(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)).toEqual([]);
        expect(await ledger(tk, u.id)).toMatchObject({ purchases: 1, subscriptions: 1, grants: featureCount, active_grants: featureCount, grant_audit: 1 });
        expect(verifier.acknowledged.has(tk)).toBe(true);
        expect(await plan(u)).toBe("pro_monthly");
      });
    }

    it("10 accounts racing for one token: exactly one wins, the other nine get 409 and nothing", async () => {
      const users = await Promise.all(Array.from({ length: 10 }, (_, i) => t.newUser(`race${i}`)));
      const tk = token();
      const res = await Promise.all(users.map((u) => verifyHttp(u, "pro_monthly", tk)));
      const codes = res.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(9);
      const winner = users[res.findIndex((r) => r.status === 200)];
      expect(await ledger(tk, winner.id)).toMatchObject({ purchases: 1, subscriptions: 1, owners: 1, grants: featureCount });
      const plans = await Promise.all(users.map(plan));
      expect(plans.filter((p) => p === "pro_monthly")).toHaveLength(1);
    });

    it("a token bound to one account can never be moved or shared later, through any path", async () => {
      const a = await t.newUser("ownerA");
      const b = await t.newUser("ownerB");
      const tk = token();
      expect((await verifyHttp(a, "pro_monthly", tk)).status).toBe(200);
      expect((await verifyHttp(b, "pro_monthly", tk)).status).toBe(409);
      // The service's own guard (behind the lock), reached directly.
      await expect(billing.applyState(b.id, tk, { productId: "pro_monthly", planKey: "pro_monthly" }, await verifier.getSubscription(tk), "test")).rejects.toThrow();
      expect((await billing.restore(b.id)).purchases).toEqual([]);
      expect(await plan(b)).toBe("free");
      expect((await purchaseRow(tk)).user_id).toBe(a.id);
    });

    it("the verify route is rate limited per user (21st call in a minute is refused)", async () => {
      const u = await t.newUser("ratelim");
      const tk = token();
      const res = [];
      for (let i = 0; i < 21; i++) res.push((await verifyHttp(u, "pro_monthly", tk)).status);
      expect(res.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(res[20]).toBe(429);
    });
  });

  describe("store answers that must not grant", () => {
    it("an active answer without an expiry is refused (503) and grants nothing: never 'Pro forever'", async () => {
      const u = await t.newUser("noexpiry");
      const tk = token();
      verifier.setState(tk, "active", 30, { expiresAt: null });
      const res = await verifyHttp(u, "pro_monthly", tk);
      expect(res.status).toBe(503);
      expect(await ledger(tk, u.id)).toMatchObject({ purchases: 0, subscriptions: 0, grants: 0 });
      expect(verifier.acknowledged.has(tk)).toBe(false);
      expect(await plan(u)).toBe("free");
    });

    it("an unverified purchase is never acknowledged: unknown, pending, wrong product, other account, outage", async () => {
      const u = await t.newUser("noack");
      const other = await t.newUser("noackother");
      const { obfuscatedAccountId } = await import("../services/billing.service.js");
      const cases = [
        ["GPA.unknown-token-123456", "pro_monthly", 400],
        [token("pro_monthly", "pending"), "pro_monthly", 200],
        [token("pro_annual"), "pro_monthly", 400],
        [token("pro_monthly", "active", 30, obfuscatedAccountId(other.id)), "pro_monthly", 403],
      ];
      for (const [tk, product, status] of cases) {
        expect((await verifyHttp(u, product, tk)).status).toBe(status);
        expect(verifier.acknowledged.has(tk)).toBe(false);
      }
      const down = token();
      verifier.failWith(new Error("store down"));
      expect((await verifyHttp(u, "pro_monthly", down)).status).toBe(503);
      verifier.failWith(null);
      expect(verifier.acknowledged.has(down)).toBe(false);
      expect(await plan(u)).toBe("free");
    });

    it("a grace-period purchase keeps access even when its reported expiry has passed", async () => {
      const u = await t.newUser("grace");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      verifier.setState(tk, "grace", -1);
      await billing.restore(u.id);
      expect(await plan(u)).toBe("pro_monthly");
      const before = await ledger(tk, u.id);
      await billing.restore(u.id); // same day, same answer: nothing rewritten
      expect((await ledger(tk, u.id)).audit).toBe(before.audit);
      verifier.setState(tk, "on_hold", -1);
      await billing.restore(u.id);
      expect(await plan(u)).toBe("free");
    });
  });

  describe("notifications", () => {
    it("the same message delivered 20 times is processed once", async () => {
      const u = await t.newUser("dup20");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const id = msg();
      const statuses = [];
      for (let i = 0; i < 20; i++) statuses.push((await t.rtdn(id, sub(tk, 2))).body.data.status);
      expect(statuses[0]).toBe("processed");
      expect(statuses.slice(1).every((s) => s === "duplicate")).toBe(true);
      expect((await rows(t.sql`select count(*)::int n from billing_notifications where message_id = ${id}`))[0].n).toBe(1);
    });

    it("20 different notifications that report an unchanged state write nothing (no updates, no audit rows)", async () => {
      const u = await t.newUser("same20");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const before = await ledger(tk, u.id);
      const [subBefore] = await rows(t.sql`select updated_at from subscriptions where provider_subscription_id = ${tk}`);
      const grantsBefore = await rows(t.sql`select id, updated_at from entitlements where user_id = ${u.id} order by id`);
      for (let i = 0; i < 10; i++) expect((await t.rtdn(msg(), sub(tk, 2))).status).toBe(200);
      await Promise.all(Array.from({ length: 10 }, () => t.rtdn(msg(), sub(tk, 2))));
      expect(await ledger(tk, u.id)).toEqual(before);
      const [subAfter] = await rows(t.sql`select updated_at from subscriptions where provider_subscription_id = ${tk}`);
      expect(String(subAfter.updated_at)).toBe(String(subBefore.updated_at));
      expect(await rows(t.sql`select id, updated_at from entitlements where user_id = ${u.id} order by id`)).toEqual(grantsBefore);
    });

    it("a revoked purchase stays revoked: a late RENEWED or a store answer saying 'active' never restores Pro", async () => {
      const u = await t.newUser("revokedfinal");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      expect((await t.rtdn(msg(), sub(tk, 12))).body.data.status).toBe("processed");
      expect(await plan(u)).toBe("free");
      verifier.setState(tk, "active", 30);
      await t.rtdn(msg(), sub(tk, 2)); // late RENEWED
      await billing.restore(u.id);
      await billing.reconcile();
      expect((await verifyHttp(u, "pro_monthly", tk)).body.data.purchase).toMatchObject({ state: "revoked", entitled: false });
      expect(await plan(u)).toBe("free");
      expect((await ledger(tk, u.id)).active_grants).toBe(0);
    });

    it("a refund wins over a slower, older store answer that arrives after it (refund before delayed renewal)", async () => {
      const u = await t.newUser("delayed");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const release = verifier.holdNext();
      const calls = verifier.calls;
      const slow = billing.restore(u.id); // reads "active" now, answers later
      await until(() => verifier.calls > calls);
      await pause(5);
      expect((await t.rtdn(msg(), sub(tk, 12))).body.data.status).toBe("processed");
      expect(await plan(u)).toBe("free");
      release();
      await slow;
      expect(await plan(u)).toBe("free");
      expect((await purchaseRow(tk)).state).toBe("revoked");
    });

    it("an older answer arriving late never overwrites a newer non-terminal state either (monotonic reads)", async () => {
      const u = await t.newUser("monotonic");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const release = verifier.holdNext();
      const calls = verifier.calls;
      const slow = billing.restore(u.id); // reads "active"
      await until(() => verifier.calls > calls);
      await pause(5);
      verifier.setState(tk, "expired", -1);
      await t.rtdn(msg(), sub(tk, 13)); // EXPIRED, read later, applied first
      const auditAfterExpiry = (await ledger(tk, u.id)).audit;
      release();
      await slow;
      expect((await purchaseRow(tk)).state).toBe("expired");
      expect(await plan(u)).toBe("free");
      expect((await ledger(tk, u.id)).audit).toBe(auditAfterExpiry);
    });

    it("a refund is applied even when a newer ordinary read was applied while it was in flight", async () => {
      const u = await t.newUser("refundlate");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const release = verifier.holdNext();
      const calls = verifier.calls;
      const refund = t.rtdn(msg(), sub(tk, 12)); // its store read is delayed
      await until(() => verifier.calls > calls);
      await pause(5);
      await billing.restore(u.id); // a newer read ("active") lands first
      expect(await plan(u)).toBe("pro_monthly");
      release();
      expect((await refund).body.data.status).toBe("processed");
      expect((await purchaseRow(tk)).state).toBe("revoked");
      expect(await plan(u)).toBe("free");
    });

    it("writers for one token are serialized: an older answer cannot slip in while a newer one is mid-transaction", async () => {
      const u = await t.newUser("serial");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      // A: an older read of "active", whose answer is delayed by the network.
      const release = verifier.holdNext();
      const calls = verifier.calls;
      const older = billing.restore(u.id);
      await until(() => verifier.calls > calls);
      await pause(5);
      // B: a newer read of "expired" that pauses inside its transaction, just before committing.
      let resumeB;
      let bPaused = false;
      const bGate = new Promise((r) => (resumeB = r));
      billing.faultInjector = async (point) => {
        if (point === "beforeCommit" && !bPaused) {
          bPaused = true;
          await bGate;
        }
      };
      verifier.setState(tk, "expired", -1);
      const newer = t.rtdn(msg(), sub(tk, 13));
      await until(() => bPaused);
      release(); // A now tries to apply its older answer while B holds the token
      await pause(50);
      resumeB();
      await Promise.all([older, newer]);
      expect((await purchaseRow(tk)).state).toBe("expired");
      expect(await plan(u)).toBe("free");
    });

    it("a voided refund of the current order revokes; concurrent duplicate refunds leave one consistent result", async () => {
      const u = await t.newUser("voided");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const { FakePurchaseVerifier } = await import("../configs/googlePlay.js");
      const body = { voidedPurchaseNotification: { purchaseToken: tk, orderId: FakePurchaseVerifier.orderIdFor(tk), productType: 1, refundType: 1 } };
      const res = await Promise.all(Array.from({ length: 10 }, () => t.rtdn(msg(), body)));
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(await plan(u)).toBe("free");
      const audit = await rows(t.sql`select action from entitlement_audit where user_id = ${u.id} and action = 'revoke'`);
      expect(audit).toHaveLength(1);
    });
  });

  describe("plan changes", () => {
    it("monthly → annual: a pending replacement keeps the paid monthly; the granted annual ends it; a late monthly renewal cannot bring it back", async () => {
      const u = await t.newUser("upgrade");
      const m = token("pro_monthly");
      await verifySvc(u, "pro_monthly", m);
      const a = token("pro_annual", "pending", 365);
      verifier.setState(a, "pending", 365, { linkedPurchaseToken: m });
      await verifySvc(u, "pro_annual", a);
      expect(await plan(u)).toBe("pro_monthly");
      expect((await purchaseRow(m)).state).toBe("active");

      verifier.setState(a, "active", 365, { linkedPurchaseToken: m });
      await t.rtdn(msg(), sub(a, 4, "pro_annual"));
      expect(await plan(u)).toBe("pro_annual");
      expect((await purchaseRow(m)).state).toBe("expired");
      expect((await rows(t.sql`select status from subscriptions where provider_subscription_id = ${m}`))[0].status).toBe("expired");
      expect((await ledger(m, u.id)).active_grants).toBe(0);

      // The store (wrongly or late) still reports the old monthly token as renewed.
      verifier.setState(m, "active", 30);
      await t.rtdn(msg(), sub(m, 2));
      await billing.restore(u.id);
      expect((await purchaseRow(m)).state).toBe("expired");
      expect((await ledger(m, u.id)).active_grants).toBe(0);
      expect(await plan(u)).toBe("pro_annual");
      const active = await rows(t.sql`select plan_key from subscriptions where user_id = ${u.id} and status = 'active'`);
      expect(active.map((r) => r.plan_key)).toEqual(["pro_annual"]);
    });

    it("a replacement token naming another user's purchase cannot end that purchase", async () => {
      const victim = await t.newUser("victim");
      const attacker = await t.newUser("attacker");
      const vt = token();
      await verifySvc(victim, "pro_monthly", vt);
      const at = token("pro_annual", "active", 365);
      verifier.setState(at, "active", 365, { linkedPurchaseToken: vt });
      await verifySvc(attacker, "pro_annual", at);
      expect(await plan(victim)).toBe("pro_monthly");
      expect((await purchaseRow(vt)).state).toBe("active");
    });
  });

  describe("acknowledgement and crash points", () => {
    it("acknowledgement succeeded at the store but the response was lost: the retry records it without acknowledging twice", async () => {
      const u = await t.newUser("acklost");
      const tk = token();
      const orig = verifier.acknowledge.bind(verifier);
      let ackCalls = 0;
      verifier.acknowledge = async (p, x) => {
        ackCalls += 1;
        await orig(p, x);
        if (ackCalls === 1) throw new Error("socket hang up");
      };
      try {
        expect((await verifyHttp(u, "pro_monthly", tk)).status).toBe(200);
        expect((await purchaseRow(tk)).acknowledged).toBe(false);
        expect((await verifyHttp(u, "pro_monthly", tk)).status).toBe(200);
        expect((await purchaseRow(tk)).acknowledged).toBe(true);
        expect(ackCalls).toBe(1);
      } finally {
        verifier.acknowledge = orig;
      }
      expect(await ledger(tk, u.id)).toMatchObject({ subscriptions: 1, grant_audit: 1 });
    });

    it("crash before commit: nothing is granted or acknowledged; the retry grants once", async () => {
      const u = await t.newUser("crashpre");
      const tk = token();
      const baseline = (await ledger(tk, u.id)).audit;
      crashAt("beforeCommit");
      await expect(verifySvc(u, "pro_monthly", tk)).rejects.toThrow();
      expect(await ledger(tk, u.id)).toMatchObject({ purchases: 0, subscriptions: 0, grants: 0, audit: baseline });
      expect(verifier.acknowledged.has(tk)).toBe(false);
      expect(await plan(u)).toBe("free");
      billing.faultInjector = null;
      await verifySvc(u, "pro_monthly", tk);
      expect(await ledger(tk, u.id)).toMatchObject({ purchases: 1, subscriptions: 1, grants: featureCount, grant_audit: 1 });
    });

    it("store verified, grant committed, then the server dies before answering: the client's retry does not grant twice", async () => {
      const u = await t.newUser("crashpost");
      const tk = token();
      crashAt("afterCommit");
      await expect(verifySvc(u, "pro_monthly", tk)).rejects.toThrow();
      expect(await plan(u)).toBe("pro_monthly"); // committed: the user paid and has access
      expect(verifier.acknowledged.has(tk)).toBe(false);
      billing.faultInjector = null;
      for (let i = 0; i < 3; i++) await verifySvc(u, "pro_monthly", tk);
      expect(verifier.acknowledged.has(tk)).toBe(true);
      expect(await ledger(tk, u.id)).toMatchObject({ purchases: 1, subscriptions: 1, grants: featureCount, grant_audit: 1 });
    });

    it("if the client never retries, reconciliation acknowledges the committed purchase (no 3-day auto-refund)", async () => {
      const u = await t.newUser("crashrecon");
      const tk = token();
      crashAt("afterCommit");
      await expect(verifySvc(u, "pro_monthly", tk)).rejects.toThrow();
      billing.faultInjector = null;
      await billing.reconcile();
      expect(verifier.acknowledged.has(tk)).toBe(true);
      expect((await purchaseRow(tk)).acknowledged).toBe(true);
      expect((await ledger(tk, u.id)).grant_audit).toBe(1);
    });

    it("crash after acknowledging: the retry is a no-op", async () => {
      const u = await t.newUser("crashack");
      const tk = token();
      crashAt("afterAcknowledge");
      await expect(verifySvc(u, "pro_monthly", tk)).rejects.toThrow();
      billing.faultInjector = null;
      const before = await ledger(tk, u.id);
      await verifySvc(u, "pro_monthly", tk);
      expect(await ledger(tk, u.id)).toEqual(before);
    });

    it("a notification that fails mid-transaction is rolled back and redelivery succeeds", async () => {
      const u = await t.newUser("rtdncrash");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      verifier.setState(tk, "expired", -1);
      crashAt("beforeCommit");
      const id = msg();
      expect((await t.rtdn(id, sub(tk, 13))).status).toBe(503); // Pub/Sub will redeliver
      expect(await plan(u)).toBe("pro_monthly"); // nothing half-applied
      billing.faultInjector = null;
      expect((await t.rtdn(id, sub(tk, 13))).body.data.status).toBe("processed");
      expect(await plan(u)).toBe("free");
    });
  });

  describe("reconciliation", () => {
    it("two reconciliation runs and an expiry notification at the same time leave one consistent result", async () => {
      const u = await t.newUser("reconrace");
      const tk = token("pro_monthly", "active", 0.5); // expires within a day: due for reconciliation
      await verifySvc(u, "pro_monthly", tk);
      verifier.setState(tk, "expired", -1);
      await Promise.all([billing.reconcile(), billing.reconcile(), t.rtdn(msg(), sub(tk, 13))]);
      expect(await plan(u)).toBe("free");
      const l = await ledger(tk, u.id);
      expect(l).toMatchObject({ subscriptions: 1, grants: featureCount, active_grants: 0 });
      const expires = await rows(t.sql`select count(*)::int n from entitlement_audit where user_id = ${u.id} and action = 'expire'`);
      expect(expires[0].n).toBe(1);
    });

    it("a missed renewal is picked up, and a renewal and an expiry racing end in the store's latest state", async () => {
      const u = await t.newUser("reconrenew");
      const tk = token("pro_monthly", "active", 0.5);
      await verifySvc(u, "pro_monthly", tk);
      verifier.setState(tk, "active", 30); // renewed, but the notification was lost
      await billing.reconcile();
      const p = await purchaseRow(tk);
      expect(new Date(p.expires_at).getTime() > Date.now() + 20 * 86_400_000).toBe(true);
      expect(await plan(u)).toBe("pro_monthly");
      await Promise.all([t.rtdn(msg(), sub(tk, 2)), billing.reconcile(), t.rtdn(msg(), sub(tk, 2))]);
      expect(await ledger(tk, u.id)).toMatchObject({ subscriptions: 1, active_grants: featureCount });
    });
  });

  describe("cache and database consistency", () => {
    it("after a refund the plan is free at once; if Redis cannot be cleared, cached grants outlive it by at most the 60 s TTL", async () => {
      const { setRedisClientForTests } = await import("../configs/redis.js");
      const store = new Map();
      const ttls = [];
      setRedisClientForTests({
        get: async (k) => store.get(k) ?? null,
        set: async (k, v, o) => {
          if (k.startsWith("ent:")) ttls.push(o?.ex);
          store.set(k, v);
          return "OK";
        },
        del: async () => {
          throw new Error("redis unavailable");
        },
      });
      try {
        const u = await t.newUser("cache");
        const tk = token();
        await verifySvc(u, "pro_monthly", tk);
        store.clear();
        const ent = t.services().entitlements;
        expect((await ent.activeRows(u.id)).some((r) => r.sourcePlan === "pro_monthly")).toBe(true); // now cached
        await t.rtdn(msg(), sub(tk, 12));
        expect(await plan(u)).toBe("free"); // the plan reads the database
        // The stale window: still cached as Pro until the entry expires.
        expect((await ent.activeRows(u.id)).some((r) => r.sourcePlan === "pro_monthly")).toBe(true);
        expect(Math.max(...ttls.filter(Boolean))).toBe(60);
        store.clear(); // TTL elapsed
        expect((await ent.activeRows(u.id)).some((r) => r.sourcePlan === "pro_monthly")).toBe(false);
      } finally {
        setRedisClientForTests(null);
      }
    });

    it("the database itself refuses a second subscription per token, a duplicate grant, and unknown states", async () => {
      const u = await t.newUser("constraints");
      const tk = token();
      await verifySvc(u, "pro_monthly", tk);
      const [s] = await rows(t.sql`select id from subscriptions where provider_subscription_id = ${tk}`);
      expect(
        await pgCode(t.sql`insert into subscriptions (id, user_id, plan_key, status, source, provider_subscription_id, started_at, current_period_end)
                           select gen_random_uuid(), user_id, plan_key, status, source, provider_subscription_id, started_at, current_period_end
                             from subscriptions where id = ${s.id}`),
      ).toBe("23505");
      expect(
        await pgCode(t.sql`insert into entitlements (id, user_id, feature_key, limit_value, usage_period, source_plan, source_subscription_id, valid_until)
                           select gen_random_uuid(), user_id, feature_key, limit_value, usage_period, source_plan, source_subscription_id, valid_until
                             from entitlements where source_subscription_id = ${s.id} limit 1`),
      ).toBe("23505");
      expect(await pgCode(t.sql`update subscriptions set status = 'lifetime' where id = ${s.id}`)).toBe("23514");
      expect(await pgCode(t.sql`update entitlements set status = 'forever' where source_subscription_id = ${s.id}`)).toBe("23514");
      expect(await pgCode(t.sql`update purchases set state = 'paid' where purchase_token = ${tk}`)).toBe("23514");
      expect(await pgCode(t.sql`update billing_notifications set status = 'done' where purchase_token = ${tk}`)).toBe(null); // no rows: fine
      expect(await pgCode(t.sql`insert into billing_notifications (id, store, message_id, status, payload) values (gen_random_uuid(), 'google_play', ${msg()}, 'done', '{}')`)).toBe("23514");
      expect(await ledger(tk, u.id)).toMatchObject({ subscriptions: 1, grants: featureCount });
    });
  });

  it("purchase tokens never reach logs or security events, including on failure paths", async () => {
    const u = await t.newUser("nolog");
    const tk = token();
    const logs = await captureLogs(async () => {
      verifier.failWith(new Error("store down"));
      await verifyHttp(u, "pro_monthly", tk);
      verifier.failWith(null);
      const orig = verifier.acknowledge.bind(verifier);
      verifier.acknowledge = async () => {
        throw new Error("ack failed");
      };
      try {
        await verifyHttp(u, "pro_monthly", tk);
      } finally {
        verifier.acknowledge = orig;
      }
      verifier.failWith(new Error("store down"));
      await billing.reconcile();
      await t.rtdn(msg(), sub(tk, 2));
      verifier.failWith(null);
      await verifyHttp(await t.newUser("nologthief"), "pro_monthly", tk);
      await t.rtdn(msg(), sub(tk, 2), "wrong-secret");
    });
    expect(logs.length > 0).toBe(true);
    expect(logs).not.toContain(tk);
    expect(logs).not.toContain(tk.split(":").at(-1));
    expect(logs).not.toContain("rtdn-test-token");
    const events = await rows(t.sql`select metadata::text m from security_events where metadata::text like ${"%" + tk.split(":").at(-1) + "%"}`);
    expect(events).toEqual([]);
  });
});
