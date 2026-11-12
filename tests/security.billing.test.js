// Google Play billing: forged, reused and stolen purchases, every store state, outages, notifications (forged,
// replayed, reordered, refunds) and real concurrency. The store is the fake verifier; everything else is real.
import { SKIP, startTestApp, PACKAGE_NAME } from "./support/harness.js";
import { describe, it, before, after, beforeEach, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";

describe("billing", { skip: SKIP ?? false }, () => {
  let t;
  let verifier;
  let FakePurchaseVerifier;
  let obfuscatedAccountId;

  before(async () => {
    t = await startTestApp();
    verifier = t.services().billing.verifier;
    ({ FakePurchaseVerifier } = await import("../configs/googlePlay.js"));
    ({ obfuscatedAccountId } = await import("../services/billing.service.js"));
  });
  after(async () => t?.close());
  beforeEach(() => verifier.failWith(null));

  /** A purchase token unique to this test run, in the fake store's format. */
  const token = (product = "pro_monthly", state = "active", days = 30, account = "") =>
    `fake:${product}:${state}:${days}:${account}:${randomBytes(6).toString("hex")}`;
  const verify = (user, productId, purchaseToken) => t.call("POST", "/v1/billing/google-play/verify", { token: user.token, body: { productId, purchaseToken } });
  const plan = async (user) => (await t.get("/v1/me", { token: user.token })).body.data.user.plan.key;
  const counts = async (purchaseToken) =>
    (
      await t.db.execute(t.sql`
        select (select count(*)::int from purchases where purchase_token = ${purchaseToken}) as purchases,
               (select count(*)::int from subscriptions where provider_subscription_id = ${purchaseToken}) as subscriptions,
               (select count(distinct user_id)::int from subscriptions where provider_subscription_id = ${purchaseToken}) as owners`)
    ).rows[0];

  it("a token the store does not recognise is rejected and leaves nothing behind", async () => {
    const u = await t.newUser("forger");
    for (const forged of ["GPA.forged-token-value-1234", "fake:", "fake:pro_monthly", "' OR 1=1 --".padEnd(12, "x")]) {
      const res = await verify(u, "pro_monthly", forged);
      expect(res.status).toBe(400);
      expect((await counts(forged)).purchases).toBe(0);
    }
    expect(await plan(u)).toBe("free");
  });

  it("product id manipulation: unknown products, mismatched products and injection strings are rejected", async () => {
    const u = await t.newUser("product");
    const tk = token("pro_monthly");
    expect((await verify(u, "pro_annual", tk)).status).toBe(400); // token is for a different product
    expect((await verify(u, "lifetime_free_pro", token("lifetime_free_pro"))).status).toBe(400);
    expect((await verify(u, "pro_monthly'; drop table purchases;--", tk)).status).toBe(400);
    expect((await verify(u, "PRO_MONTHLY", tk)).status).toBe(400);
    expect(await plan(u)).toBe("free");
  });

  it("the purchase's state comes from the store, never from the client", async () => {
    const u = await t.newUser("clientstate");
    const tk = token("pro_monthly", "expired");
    const res = await t.call("POST", "/v1/billing/google-play/verify", {
      token: u.token,
      body: { productId: "pro_monthly", purchaseToken: tk, state: "active", expiresAt: "2099-01-01" },
    });
    expect(res.status).toBe(400); // unknown fields are refused outright
    const ok = await verify(u, "pro_monthly", tk);
    expect(ok.body.data.purchase).toMatchObject({ state: "expired", entitled: false });
    expect(await plan(u)).toBe("free");
  });

  it("a purchase made for another account (obfuscated id) is refused", async () => {
    const owner = await t.newUser("acctowner");
    const thief = await t.newUser("acctthief");
    const tk = token("pro_monthly", "active", 30, obfuscatedAccountId(owner.id));
    const res = await verify(thief, "pro_monthly", tk);
    expect(res.status).toBe(403);
    expect(res.body.data.code).toBe("PURCHASE_ACCOUNT_MISMATCH");
    expect(await plan(thief)).toBe("free");
    expect((await verify(owner, "pro_monthly", tk)).status).toBe(200);
    expect(await plan(owner)).toBe("pro_monthly");
  });

  it("a token already linked to one account cannot be claimed by another", async () => {
    const a = await t.newUser("linkA");
    const b = await t.newUser("linkB");
    const tk = token("pro_annual", "active", 300);
    expect((await verify(a, "pro_annual", tk)).status).toBe(200);
    expect((await verify(b, "pro_annual", tk)).status).toBe(409);
    expect(await plan(b)).toBe("free");
    expect(await counts(tk)).toEqual({ purchases: 1, subscriptions: 1, owners: 1 });
  });

  it("REGRESSION F-01: two accounts verifying one token at the same moment yield exactly one Pro account", async () => {
    for (let round = 0; round < 5; round++) {
      const users = await Promise.all(Array.from({ length: 4 }, () => t.newUser("race")));
      const tk = token("pro_monthly");
      const results = await Promise.all(users.map((u) => verify(u, "pro_monthly", tk)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      const plans = await Promise.all(users.map(plan));
      expect(plans.filter((p) => p === "pro_monthly")).toHaveLength(1);
      expect(await counts(tk)).toEqual({ purchases: 1, subscriptions: 1, owners: 1 });
      // The winner owns the purchase row.
      const winner = users[results.findIndex((r) => r.status === 200)];
      const { rows } = await t.db.execute(t.sql`select user_id from purchases where purchase_token = ${tk}`);
      expect(rows[0].user_id).toBe(winner.id);
    }
  });

  it("the same account verifying the same token concurrently creates one subscription", async () => {
    const u = await t.newUser("samerace");
    const tk = token("pro_monthly");
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(u, "pro_monthly", tk)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await counts(tk)).toEqual({ purchases: 1, subscriptions: 1, owners: 1 });
    const grants = (await t.db.execute(t.sql`select count(*)::int as n from entitlements where user_id = ${u.id} and source_plan = 'pro_monthly' and feature_key = 'ads.enabled'`)).rows[0].n;
    expect(grants).toBe(1);
  });

  it("the purchase is acknowledged with the store exactly when it grants access", async () => {
    const u = await t.newUser("ack");
    const paid = token("pro_monthly");
    await verify(u, "pro_monthly", paid);
    expect(verifier.acknowledged.has(paid)).toBe(true);
    const pending = token("pro_monthly", "pending");
    await verify(u, "pro_monthly", pending);
    expect(verifier.acknowledged.has(pending)).toBe(false);
  });

  it("every store state maps to the right access, and restore is idempotent", async () => {
    const u = await t.newUser("states");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    // The restore route is limited to 10 calls a minute (enforced even without Redis), so the state cycle goes
    // through the same service the route calls; the route itself is exercised once at the end.
    const after = async (state, days = 30) => {
      verifier.setState(tk, state, days);
      return (await t.services().billing.restore(u.id)).plan.key;
    };
    for (const [state, days, expected] of [
      ["pending", 30, "free"],
      ["active", 30, "pro_monthly"],
      ["grace", 3, "pro_monthly"],
      ["on_hold", 30, "free"],
      ["active", 30, "pro_monthly"],
      ["paused", 30, "free"],
      ["cancelled", 5, "pro_monthly"],
      ["cancelled", -1, "free"],
      ["expired", -1, "free"],
      ["revoked", 30, "free"],
    ]) {
      expect(await after(state, days)).toBe(expected);
    }
    expect(await after("active")).toBe("pro_monthly");
    expect(await after("active")).toBe("pro_monthly");
    expect((await counts(tk)).subscriptions).toBe(1);
    const viaRoute = await t.call("POST", "/v1/billing/restore", { token: u.token });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.data.plan.key).toBe("pro_monthly");
  });

  it("a Pro grant past its paid-through date stops working immediately, before any job runs", async () => {
    const u = await t.newUser("lapsed");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    await t.db.execute(t.sql`update entitlements set valid_until = now() - interval '1 second' where user_id = ${u.id} and source_plan = 'pro_monthly'`);
    await t.services().entitlements.invalidate(u.id);
    const res = await t.get(`/v1/matches/${t.matchIds["3869685"]}/events?type=shot`, { token: u.token });
    expect(res.status).toBe(403);
  });

  it("switching monthly → annual ends the old purchase and keeps exactly one active plan", async () => {
    const u = await t.newUser("upgrade");
    const monthly = token("pro_monthly");
    await verify(u, "pro_monthly", monthly);
    const annual = token("pro_annual", "active", 365);
    verifier.setState(annual, "active", 365, { linkedPurchaseToken: monthly });
    expect((await verify(u, "pro_annual", annual)).status).toBe(200);
    expect(await plan(u)).toBe("pro_annual");
    const { rows } = await t.db.execute(t.sql`
      select p.state, (select count(*)::int from entitlements e where e.source_subscription_id = p.subscription_id and e.status = 'active') as active
        from purchases p where p.purchase_token = ${monthly}`);
    expect(rows[0]).toEqual({ state: "expired", active: 0 });
    // The linked token of another user is never touched.
    const other = await t.newUser("upgradeother");
    const otherTk = token("pro_monthly");
    await verify(other, "pro_monthly", otherTk);
    const hijack = token("pro_annual", "active", 365);
    verifier.setState(hijack, "active", 365, { linkedPurchaseToken: otherTk });
    await verify(u, "pro_annual", hijack);
    expect(await plan(other)).toBe("pro_monthly");
  });

  it("a store outage fails safely: 503, no purchase row, no access granted, nothing charged", async () => {
    const u = await t.newUser("outage");
    const tk = token("pro_monthly");
    verifier.failWith(new Error("ECONNRESET"));
    const res = await verify(u, "pro_monthly", tk);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("ECONNRESET");
    expect((await counts(tk)).purchases).toBe(0);
    expect(await plan(u)).toBe("free");
    const restore = await t.call("POST", "/v1/billing/restore", { token: u.token });
    expect(restore.status).toBe(200); // nothing to restore yet
    verifier.failWith(null);
    await verify(u, "pro_monthly", tk);
    verifier.failWith(new Error("ETIMEDOUT"));
    const restoreDown = await t.call("POST", "/v1/billing/restore", { token: u.token });
    expect(restoreDown.status).toBe(503);
    verifier.failWith(null);
    expect(await plan(u)).toBe("pro_monthly"); // an outage never removes access either
  });

  describe("real-time developer notifications", () => {
    const sub = (purchaseToken, notificationType) => ({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId: "pro_monthly" } });
    const msg = () => `msg-${randomBytes(8).toString("hex")}`;

    it("are refused without the shared token, with a wrong token, for another app, or when malformed", async () => {
      const u = await t.newUser("rtdnauth");
      const tk = token("pro_monthly");
      await verify(u, "pro_monthly", tk);
      expect((await t.rtdn(msg(), sub(tk, 12), "")).status).toBe(401);
      expect((await t.rtdn(msg(), sub(tk, 12), "wrong-token")).status).toBe(401);
      expect((await t.rtdn(msg(), sub(tk, 12), "rtdn-test-token ")).status).toBe(401);
      const otherApp = await t.call("POST", `/v1/webhooks/google-play-rtdn?token=rtdn-test-token`, {
        body: { message: { messageId: msg(), data: Buffer.from(JSON.stringify({ packageName: "com.evil.app", ...sub(tk, 12) })).toString("base64") } },
      });
      expect(otherApp.status).toBe(400);
      const noPackage = await t.call("POST", `/v1/webhooks/google-play-rtdn?token=rtdn-test-token`, {
        body: { message: { messageId: msg(), data: Buffer.from(JSON.stringify(sub(tk, 12))).toString("base64") } },
      });
      expect(noPackage.status).toBe(400);
      for (const body of ["not json", "{}", JSON.stringify({ message: { messageId: "m" } }), JSON.stringify({ message: { messageId: "m", data: "%%%" } })]) {
        expect((await t.call("POST", `/v1/webhooks/google-play-rtdn?token=rtdn-test-token`, { body, headers: { "content-type": "application/json" }, raw: true })).status).toBe(400);
      }
      expect(await plan(u)).toBe("pro_monthly"); // none of them changed anything
    });

    it("are processed once: a replayed message id is a no-op", async () => {
      const u = await t.newUser("rtdnreplay");
      const tk = token("pro_monthly");
      await verify(u, "pro_monthly", tk);
      const id = msg();
      expect((await t.rtdn(id, sub(tk, 2))).body.data.status).toBe("processed");
      const before = verifier.calls;
      expect((await t.rtdn(id, sub(tk, 2))).body.data.status).toBe("duplicate");
      expect(verifier.calls).toBe(before); // the store was not even asked again
      expect((await t.db.execute(t.sql`select count(*)::int as n from billing_notifications where message_id = ${id}`)).rows[0].n).toBe(1);
    });

    it("concurrent duplicate deliveries leave one notification row and a consistent plan", async () => {
      const u = await t.newUser("rtdnconc");
      const tk = token("pro_monthly");
      await verify(u, "pro_monthly", tk);
      verifier.setState(tk, "on_hold", 30);
      const id = msg();
      const res = await Promise.all(Array.from({ length: 6 }, () => t.rtdn(id, sub(tk, 5))));
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect((await t.db.execute(t.sql`select count(*)::int as n from billing_notifications where message_id = ${id}`)).rows[0].n).toBe(1);
      expect(await plan(u)).toBe("free");
    });

    it("the notification is only a hint: order and content cannot grant access the store does not confirm", async () => {
      const u = await t.newUser("rtdnorder");
      const tk = token("pro_monthly");
      await verify(u, "pro_monthly", tk);
      verifier.setState(tk, "expired", -1);
      // A late "PURCHASED" and "RENEWED" arrive after the subscription actually ended.
      await t.rtdn(msg(), sub(tk, 4));
      await t.rtdn(msg(), sub(tk, 2));
      expect(await plan(u)).toBe("free");
      // A "REVOKED" always ends access, whatever the store currently says.
      verifier.setState(tk, "active", 30);
      await t.rtdn(msg(), sub(tk, 2));
      expect(await plan(u)).toBe("pro_monthly");
      await t.rtdn(msg(), sub(tk, 12));
      expect(await plan(u)).toBe("free");
    });

    it("REGRESSION F-02: a refund of an older renewal does not end a running subscription; a refund of the current order does", async () => {
      const u = await t.newUser("refund");
      const tk = token("pro_annual", "active", 300);
      await verify(u, "pro_annual", tk);
      await t.rtdn(msg(), { voidedPurchaseNotification: { purchaseToken: tk, orderId: "GPA.1111-older-renewal..3", productType: 1, refundType: 1 } });
      expect(await plan(u)).toBe("pro_annual");
      await t.rtdn(msg(), { voidedPurchaseNotification: { purchaseToken: tk, orderId: FakePurchaseVerifier.orderIdFor(tk), productType: 1, refundType: 1 } });
      expect(await plan(u)).toBe("free");
    });

    it("a token nobody has verified is recorded and ignored, never attached to an account", async () => {
      const tk = token("pro_monthly");
      expect((await t.rtdn(msg(), sub(tk, 4))).body.data.status).toBe("ignored");
      expect((await counts(tk)).purchases).toBe(0);
    });

    it("a store outage during a notification returns 503 so Pub/Sub retries, and the retry succeeds", async () => {
      const u = await t.newUser("rtdnretry");
      const tk = token("pro_monthly");
      await verify(u, "pro_monthly", tk);
      verifier.setState(tk, "on_hold", 30);
      const id = msg();
      verifier.failWith(new Error("ECONNRESET"));
      expect((await t.rtdn(id, sub(tk, 5))).status).toBe(503);
      expect(await plan(u)).toBe("pro_monthly");
      verifier.failWith(null);
      expect((await t.rtdn(id, sub(tk, 5))).body.data.status).toBe("processed");
      expect(await plan(u)).toBe("free");
    });
  });

  it("reconciliation re-reads due purchases and catches changes no notification reported", async () => {
    const u = await t.newUser("reconcile");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    verifier.setState(tk, "expired", -1);
    await t.db.execute(t.sql`update purchases set last_verified_at = now() - interval '1 day' where purchase_token = ${tk}`);
    const result = await t.services().billing.reconcile();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(await plan(u)).toBe("free");
  });

  it("a purchase the store no longer recognises is treated as expired, not left active", async () => {
    const u = await t.newUser("vanished");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    const { PurchaseNotFoundError } = await import("../configs/googlePlay.js");
    verifier.failWith(new PurchaseNotFoundError());
    expect((await t.services().billing.restore(u.id)).plan.key).toBe("free");
    verifier.failWith(null);
    expect((await t.db.execute(t.sql`select state from purchases where purchase_token = ${tk}`)).rows[0].state).toBe("expired");
  });

  it("a failed acknowledgement does not fail the purchase; reconciliation retries it", async () => {
    const u = await t.newUser("ackfail");
    const tk = token("pro_monthly");
    const original = verifier.acknowledge.bind(verifier);
    verifier.acknowledge = async () => {
      throw new Error("ack endpoint down");
    };
    try {
      expect((await verify(u, "pro_monthly", tk)).status).toBe(200);
      expect(await plan(u)).toBe("pro_monthly");
      expect((await t.db.execute(t.sql`select acknowledged from purchases where purchase_token = ${tk}`)).rows[0].acknowledged).toBe(false);
    } finally {
      verifier.acknowledge = original;
    }
    await t.services().billing.reconcile();
    expect((await t.db.execute(t.sql`select acknowledged from purchases where purchase_token = ${tk}`)).rows[0].acknowledged).toBe(true);
  });

  it("a notification without a purchase token (e.g. Google's test notification) is recorded and ignored", async () => {
    const res = await t.rtdn(`msg-test-${randomBytes(4).toString("hex")}`, { testNotification: { version: "1.0" } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ignored");
  });

  it("reconciliation counts store failures per purchase and keeps going", async () => {
    const u = await t.newUser("reconfail");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    await t.db.execute(t.sql`update purchases set last_verified_at = now() - interval '1 day' where purchase_token = ${tk}`);
    verifier.failWith(new Error("ETIMEDOUT"));
    try {
      const result = await t.services().billing.reconcile();
      expect(result.failed).toBeGreaterThanOrEqual(1);
    } finally {
      verifier.failWith(null);
    }
    expect(await plan(u)).toBe("pro_monthly");
  });

  it("the subscription view exposes only the caller's own billing data", async () => {
    const u = await t.newUser("subview");
    const tk = token("pro_monthly");
    await verify(u, "pro_monthly", tk);
    const view = (await t.get("/v1/billing/subscription", { token: u.token })).body.data.subscription;
    expect(view.purchase.productId).toBe("pro_monthly");
    expect(JSON.stringify(view)).not.toContain(tk); // the purchase token is never echoed back
    expect(view.manageUrl).toContain(`package=${PACKAGE_NAME}`);
  });
});
