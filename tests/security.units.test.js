// Unit tests for security-critical building blocks. No database, no network: everything external is either a
// pure function or replaced by an in-process fake whose behaviour the test controls.
import "./support/unitEnv.js";
import { generateKeyPairSync, sign as rsaSign, createHmac, createVerify } from "node:crypto";
import { describe, it, expect, beforeEach } from "./support/expect.js";
import { rng, randomString, NASTY_STRINGS } from "./support/random.js";
import { TEST_JWT_PUBLIC_KEY, TEST_AUTHORIZED_PARTY, signSessionToken } from "./support/tokens.js";
import ApiError, { unlockedBy, assertFound } from "../utils/ApiError.js";
import { describeForLog, sendError } from "../utils/asyncHandler.js";
import { decodeCursor, encodeCursor, toPage } from "../utils/pagination.js";
import { uuidv5, uuidv7, isUuid } from "../utils/ids.js";
import { escapeLike } from "../services/football.service.js";
import { getEnv, resetEnv } from "../configs/env.js";
import { restCredentials, setRedisClientForTests, cacheGet, cacheSet, cached, locks } from "../configs/redis.js";
import { toProfile, verifySessionToken } from "../configs/clerk.js";
import { fromSubscriptionV2, GooglePlayVerifier, FakePurchaseVerifier, PurchaseNotFoundError, getPurchaseVerifier, resetPurchaseVerifier } from "../configs/googlePlay.js";
import { JobRegistry, JobRunner, describeError } from "../workers/runner.js";
import { JobsService } from "../services/jobs.service.js";
import { isEntitled, accessUntil, assertStoreResponse, StoreResponseError, GRACE_BACKSTOP_MS, obfuscatedAccountId, BillingService } from "../services/billing.service.js";
import { memoryHit, resetMemoryLimits, clientIp } from "../middlewares/rateLimit.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";
import { periodKeyFor } from "../services/entitlements.service.js";
import { AdsService } from "../services/ads.service.js";
import { z } from "zod";

/** Minimal Express-like response capturing what sendError writes. */
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), (res.headersSent = true), res);
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  return res;
}

describe("error envelope and logging", () => {
  it("paywall errors name the plans that unlock the feature", () => {
    expect(unlockedBy("analysis.matches_per_month")).toEqual(["pro_monthly", "pro_annual"]);
    expect(unlockedBy("analysis.advanced_filters")).toEqual(["pro_monthly", "pro_annual"]);
    expect(unlockedBy("ads.enabled")).toEqual([]); // removing ads is not an "unlock" of more ads
    expect(unlockedBy("no.such.feature")).toEqual([]);
    const e = ApiError.entitlementExceeded({ featureKey: "comparisons.per_month", limit: 5 });
    expect(e.statusCode).toBe(403);
    expect(e.details).toMatchObject({ paywall: true, featureKey: "comparisons.per_month", unlockedBy: ["pro_monthly", "pro_annual"] });
  });

  it("assertFound turns a missing row into a non-disclosing 404", () => {
    expect(() => assertFound(null, "Note")).toThrow(ApiError);
    expect(() => assertFound(undefined)).toThrow(/not found/);
    expect(assertFound({ id: 1 })).toEqual({ id: 1 });
  });

  it("unknown errors become a generic 500 with no internals", () => {
    const res = fakeRes();
    const logs = [];
    const orig = console.error;
    console.error = (l) => logs.push(l);
    try {
      const err = new Error("Failed query: select * from users where email = $1\nparams: victim@example.com");
      err.cause = Object.assign(new Error('duplicate key value violates unique constraint "users_email"'), { code: "23505" });
      sendError(err, { id: "req-1", method: "GET", originalUrl: "/v1/me?token=abc" }, res);
    } finally {
      console.error = orig;
    }
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: "Internal server error", data: { code: "INTERNAL", requestId: "req-1" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("victim@example.com");
    expect(logs[0]).not.toContain("token=abc");
    expect(logs[0]).not.toContain("select *");
    expect(JSON.parse(logs[0])).toMatchObject({ code: "23505", route: "/v1/me" });
  });

  it("describeForLog strips bound parameters and quoted values from every message shape", () => {
    const r = rng();
    for (let i = 0; i < 300; i++) {
      const secret = `S3CRET-${i}-${randomString(r, 10)}`.replace(/["'\n]/g, "x");
      const variants = [
        new Error(`Failed query: insert into user_notes (body) values ($1)\nparams: ${secret}`),
        Object.assign(new Error("wrapper"), { cause: new Error(`invalid input syntax for type uuid: "${secret}"`) }),
        Object.assign(new Error("wrapper"), { cause: new Error(`value too long: '${secret}'`) }),
      ];
      for (const v of variants) expect(JSON.stringify(describeForLog(v))).not.toContain(secret);
    }
  });

  it("body-parser errors map to 400 / 413, not 500", () => {
    const tooBig = fakeRes();
    sendError(Object.assign(new Error("request entity too large"), { status: 413 }), { id: "r" }, tooBig);
    expect(tooBig.statusCode).toBe(413);
    const badJson = fakeRes();
    sendError(Object.assign(new SyntaxError("Unexpected token"), { status: 400 }), { id: "r" }, badJson);
    expect(badJson.statusCode).toBe(400);
  });
});

describe("pagination cursors (property-based)", () => {
  it("round-trips valid cursors for every shape", () => {
    const id = uuidv7();
    expect(decodeCursor(encodeCursor("2022-12-18T17:00:00.000Z", id), ["date", "uuid"])).toEqual(["2022-12-18T17:00:00.000Z", id]);
    expect(decodeCursor(encodeCursor(42, id), ["int", "uuid"])).toEqual([42, id]);
    expect(decodeCursor(encodeCursor("Argentina", id), ["string", "uuid"])).toEqual(["Argentina", id]);
    expect(decodeCursor(undefined, ["int", "uuid"])).toBe(null);
  });

  it("any random or tampered cursor either decodes to the declared types or is a 400 validation error", () => {
    const r = rng();
    const shapes = [
      ["date", "uuid"],
      ["int", "uuid"],
      ["string", "uuid"],
      ["int", "string"],
    ];
    const candidates = [
      () => randomString(r, 40),
      () => Buffer.from(randomString(r, 40)).toString("base64url"),
      () => encodeCursor(r.pick([NaN, Infinity, -1, 1.5, 2 ** 60, "abc", "2022-13-45", "", null]), r.pick([uuidv7(), "x", "", "' OR 1=1"])),
      () => Buffer.from(JSON.stringify(r.pick([[], [1], [1, 2, 3], {}, null, "s", [[1], "x"], [{ a: 1 }, uuidv7()]]))).toString("base64url"),
    ];
    for (let i = 0; i < 2000; i++) {
      const shape = r.pick(shapes);
      const cursor = r.pick(candidates)();
      let decoded;
      try {
        decoded = decodeCursor(cursor, shape);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(400);
        continue;
      }
      if (decoded === null) continue;
      const [a, b] = decoded;
      if (shape[0] === "int") expect(Number.isSafeInteger(Number(a)) && Number(a) >= 0).toBe(true);
      if (shape[0] === "date") expect(Number.isFinite(Date.parse(a))).toBe(true);
      if (shape[1] === "uuid") expect(isUuid(b)).toBe(true);
    }
  });

  it("toPage only emits a next cursor when there are more rows", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ k: i, id: uuidv7() }));
    expect(toPage(rows.slice(0, 5), 5, (x) => [x.k, x.id]).page.nextCursor).toBe(null);
    const p = toPage(rows, 5, (x) => [x.k, x.id]);
    expect(p.data).toHaveLength(5);
    expect(decodeCursor(p.page.nextCursor, ["int", "uuid"])).toEqual([4, rows[4].id]);
  });
});

describe("LIKE escaping", () => {
  it("escapes %, _ and the escape character so user text matches literally", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    const r = rng();
    for (let i = 0; i < 500; i++) {
      const s = randomString(r, 30);
      const escaped = escapeLike(s);
      // Every unescaped wildcard has been neutralised: removing escape pairs leaves no bare % or _.
      expect(/(^|[^\\])(\\\\)*[%_]/.test(escaped.replace(/\\[\\%_]/g, ""))).toBe(false);
    }
  });
});

describe("identifiers", () => {
  it("uuidv5 is deterministic and well-formed; uuidv7 is unique and time-ordered", () => {
    expect(uuidv5("statsbomb:event:1")).toBe(uuidv5("statsbomb:event:1"));
    expect(uuidv5("statsbomb:event:1")).not.toBe(uuidv5("statsbomb:event:2"));
    const ids = Array.from({ length: 1000 }, (_, i) => uuidv7(1_800_000_000_000 + i));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids.slice(0, 20)) expect(isUuid(id)).toBe(true);
    expect(isUuid("01a1cec4-dae6-7985-9949-b5979b1ddee5' OR '1'='1")).toBe(false);
  });
});

describe("configuration", () => {
  beforeEach(() => resetEnv());

  it("rejects swapped Clerk keys and incomplete storage credentials without echoing values", () => {
    // A publishable-key-shaped placeholder pasted where the secret key belongs (not a real credential).
    const wrongValue = ["pk", "live", "PLACEHOLDER_NOT_A_KEY"].join("_");
    let message = "";
    try {
      getEnv({ CLERK_SECRET_KEY: wrongValue });
    } catch (err) {
      message = err.message;
    }
    expect(message).toContain("CLERK_SECRET_KEY");
    expect(message).not.toContain(wrongValue);
    expect(() => getEnv({ STORAGE_DRIVER: "neon", S3_ENDPOINT: "" })).toThrow(/S3_ENDPOINT/);
    expect(() => getEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("never loads .env files in a test process", () => {
    // unitEnv set DATABASE_URL to a local placeholder; a loaded .env would not override it, but would add keys.
    const env = getEnv();
    expect(env.DATABASE_URL).toBe("postgres://unit:unit@127.0.0.1:1/unit");
    expect(env.S3_ACCESS_KEY_ID).toBe(undefined);
  });

  it("derives Upstash REST credentials only from a real Upstash URL", () => {
    expect(restCredentials("rediss://default:p%40ss@eu1-x.upstash.io:6379")).toEqual({ url: "https://eu1-x.upstash.io", token: "p@ss" });
    expect(restCredentials("rediss://default:pw@evil.example.com:6379")).toBe(null);
    expect(restCredentials("rediss://default:pw@x.upstash.io.evil.com:6379")).toBe(null);
    expect(restCredentials("rediss://default@x.upstash.io:6379")).toBe(null);
    expect(restCredentials("not a url")).toBe(null);
    expect(restCredentials(undefined)).toBe(null);
  });
});

describe("Redis cache and locks degrade safely", () => {
  const failing = {
    get: async () => {
      throw new Error("ETIMEDOUT");
    },
    set: async () => {
      throw new Error("ETIMEDOUT");
    },
    del: async () => {
      throw new Error("ETIMEDOUT");
    },
    eval: async () => {
      throw new Error("ETIMEDOUT");
    },
  };

  it("a failing Redis never fails a read: the loader runs and its value is returned", async () => {
    setRedisClientForTests(failing);
    expect(await cacheGet("k")).toBe(null);
    await cacheSet("k", { a: 1 }, 10);
    expect(await cached("k", 10, async () => ({ fresh: true }))).toEqual({ fresh: true });
    setRedisClientForTests(null);
  });

  it("a lock held elsewhere skips the work; a free lock runs it and releases with the owner token", async () => {
    const store = new Map();
    const evals = [];
    const fake = {
      set: async (k, v, opts) => {
        if (opts?.nx && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      },
      eval: async (script, keys, args) => {
        evals.push([keys[0], args[0]]);
        if (store.get(keys[0]) === args[0]) store.delete(keys[0]);
        return 1;
      },
    };
    setRedisClientForTests(fake);
    const first = locks.withLock("sync", 1000, async () => {
      expect(await locks.withLock("sync", 1000, async () => "second ran")).toBe(null);
      return "first ran";
    });
    expect(await first).toBe("first ran");
    expect(store.has("lock:sync")).toBe(false);
    expect(evals).toHaveLength(1);
    setRedisClientForTests(null);
  });
});

describe("Clerk session token verification", () => {
  beforeEach(() => {
    resetEnv();
    process.env.CLERK_JWT_KEY = TEST_JWT_PUBLIC_KEY;
    process.env.CLERK_AUTHORIZED_PARTIES = TEST_AUTHORIZED_PARTY;
  });

  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claims = (extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { sub: "user_x", sid: "sess_x", azp: TEST_AUTHORIZED_PARTY, iat: now, nbf: now - 5, exp: now + 600, ...extra };
  };

  it("accepts a valid RS256 token and returns only the subject and session", async () => {
    expect(await verifySessionToken(signSessionToken("user_ok"))).toEqual({ clerkUserId: "user_ok", sessionId: "sess_user_ok" });
  });

  it("rejects expired, not-yet-valid, wrong-party, pending and subject-less tokens", async () => {
    expect(await verifySessionToken(signSessionToken("u", { expiresInSec: -120 }))).toBe(null);
    expect(await verifySessionToken(signSessionToken("u", { azp: "https://evil.example" }))).toBe(null);
    expect(await verifySessionToken(signSessionToken("u", { sts: "pending" }))).toBe(null);
    expect(await verifySessionToken(signSessionToken(""))).toBe(null);
  });

  it("rejects tokens whose payload or header was changed after signing", async () => {
    const [h, , s] = signSessionToken("victim").split(".");
    expect(await verifySessionToken(`${h}.${b64(claims({ sub: "attacker" }))}.${s}`)).toBe(null);
    const [, p2, s2] = signSessionToken("victim").split(".");
    expect(await verifySessionToken(`${b64({ alg: "RS512", typ: "JWT", kid: "other" })}.${p2}.${s2}`)).toBe(null);
  });

  it("rejects alg=none and HS256 signed with the public key (algorithm confusion)", async () => {
    expect(await verifySessionToken(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.`)).toBe(null);
    const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims())}`;
    const hmac = createHmac("sha256", TEST_JWT_PUBLIC_KEY).update(input).digest("base64url");
    expect(await verifySessionToken(`${input}.${hmac}`)).toBe(null);
  });

  it("rejects a correctly formed token signed by a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = `${b64({ alg: "RS256", typ: "JWT", kid: "ins_test" })}.${b64(claims())}`;
    const sig = rsaSign("RSA-SHA256", Buffer.from(input), other.privateKey).toString("base64url");
    expect(await verifySessionToken(`${input}.${sig}`)).toBe(null);
  });

  it("rejects garbage without throwing", async () => {
    for (const t of ["", "a", "a.b", "a.b.c", "....", "Bearer x", "\u0000", "x".repeat(10000), ...NASTY_STRINGS]) {
      expect(await verifySessionToken(t)).toBe(null);
    }
  });

  it("fails closed when Clerk is not configured", async () => {
    resetEnv();
    process.env.CLERK_JWT_KEY = "";
    process.env.CLERK_SECRET_KEY = "";
    expect(await verifySessionToken(signSessionToken("u"))).toBe(null);
  });
});

describe("Clerk profile mapping", () => {
  it("stores only verified email addresses and maps both payload shapes", () => {
    const hook = toProfile({
      id: "user_1",
      first_name: "Ada",
      last_name: null,
      primary_email_address_id: "e2",
      email_addresses: [
        { id: "e1", email_address: "unverified@example.com", verification: { status: "unverified" } },
        { id: "e2", email_address: "ok@example.com", verification: { status: "verified" } },
      ],
      external_accounts: [{ provider: "oauth_google", provider_user_id: "123", email_address: "ok@example.com" }],
    });
    expect(hook).toMatchObject({ clerkUserId: "user_1", email: "ok@example.com", displayName: "Ada" });
    expect(hook.identities).toEqual([{ provider: "google", subject: "123", email: "ok@example.com" }]);
    const onlyUnverified = toProfile({ id: "u", email_addresses: [{ id: "e1", email_address: "x@example.com", verification: { status: "unverified" } }] });
    expect(onlyUnverified.email).toBe(null);
  });
});

describe("Google Play verification", () => {
  it("maps every subscriptionsv2 state, defaulting unknown states to pending (no access)", () => {
    const map = {
      SUBSCRIPTION_STATE_ACTIVE: "active",
      SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
      SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
      SUBSCRIPTION_STATE_PAUSED: "paused",
      SUBSCRIPTION_STATE_CANCELED: "cancelled",
      SUBSCRIPTION_STATE_EXPIRED: "expired",
      SUBSCRIPTION_STATE_PENDING: "pending",
      SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
      SOMETHING_NEW: "pending",
    };
    for (const [g, ours] of Object.entries(map)) expect(fromSubscriptionV2({ subscriptionState: g }).state).toBe(ours);
    const v = fromSubscriptionV2({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "GPA.1",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      linkedPurchaseToken: "old",
      externalAccountIdentifiers: { obfuscatedExternalAccountId: "acct" },
      lineItems: [{ productId: "pro_monthly", expiryTime: "2030-01-01T00:00:00Z", autoRenewingPlan: { autoRenewEnabled: true } }],
    });
    expect(v).toMatchObject({ productId: "pro_monthly", orderId: "GPA.1", acknowledged: true, linkedPurchaseToken: "old", obfuscatedAccountId: "acct", autoRenewing: true });
  });

  it("access follows state and the paid-through date; a missing expiry never means forever (property-based)", () => {
    const r = rng();
    const now = new Date("2026-06-15T12:00:00Z");
    for (let i = 0; i < 1000; i++) {
      const state = r.pick(["pending", "active", "grace", "on_hold", "paused", "cancelled", "expired", "revoked", "weird"]);
      const roll = r.next();
      const expires =
        roll < 0.1 ? null : roll < 0.15 ? new Date("not a date") : new Date(now.getTime() + r.int(-30, 30) * 86_400_000 + r.int(-1000, 1000));
      const until = accessUntil(state, expires, now);
      if (state === "grace") {
        // Google keeps grace-period users entitled while it retries payment: access never ends before the backstop.
        expect(until.getTime() >= now.getTime() + GRACE_BACKSTOP_MS).toBe(true);
        expect(until.getTime() >= (expires instanceof Date && Number.isFinite(expires.getTime()) ? expires.getTime() : 0)).toBe(true);
      } else {
        const ok = ["active", "cancelled"].includes(state) && expires instanceof Date && Number.isFinite(expires.getTime()) && expires > now;
        expect(until === null ? null : until.getTime()).toBe(ok ? expires.getTime() : null);
      }
      expect(isEntitled(state, expires, now)).toBe(until !== null);
    }
  });

  it("the grace backstop is stable within a UTC day, so replays do not rewrite grants", () => {
    const a = accessUntil("grace", null, new Date("2026-06-15T00:00:01Z"));
    const b = accessUntil("grace", null, new Date("2026-06-15T23:59:59Z"));
    expect(a.getTime()).toBe(b.getTime());
    expect(accessUntil("grace", null, new Date("2026-06-16T00:00:01Z")).getTime() > a.getTime()).toBe(true);
  });

  it("store answers without a product, with an unknown state, or without a usable expiry are rejected", () => {
    const future = new Date(Date.now() + 86_400_000);
    for (const bad of [
      null,
      { state: "active", expiresAt: future },
      { productId: "pro_monthly", state: "weird", expiresAt: future },
      { productId: "pro_monthly", state: "active", expiresAt: null },
      { productId: "pro_monthly", state: "cancelled", expiresAt: "garbage" },
      { productId: "pro_monthly", state: "grace" },
    ]) {
      expect(() => assertStoreResponse(bad)).toThrow(StoreResponseError);
    }
    for (const ok of [
      { productId: "pro_monthly", state: "active", expiresAt: future },
      { productId: "pro_monthly", state: "pending", expiresAt: null },
      { productId: "pro_monthly", state: "revoked", expiresAt: null },
      { productId: "pro_monthly", state: "expired" },
    ]) {
      assertStoreResponse(ok);
    }
  });

  it("the obfuscated account id is stable, 64 hex chars and does not reveal the user id", () => {
    const id = uuidv7();
    expect(obfuscatedAccountId(id)).toBe(obfuscatedAccountId(id));
    expect(obfuscatedAccountId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(obfuscatedAccountId(id)).not.toContain(id.replace(/-/g, ""));
    expect(obfuscatedAccountId(id)).not.toBe(obfuscatedAccountId(uuidv7()));
  });

  it("GooglePlayVerifier signs a correct service-account assertion, caches the token and maps errors", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = { client_email: "sa@test.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
    const calls = [];
    let mode = "ok";
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      if (mode === "missing") return new Response("", { status: 410 });
      if (mode === "down") return new Response("upstream", { status: 503 });
      if (url.endsWith(":acknowledge")) return new Response("");
      return new Response(JSON.stringify({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [{ productId: "pro_monthly" }] }));
    };
    const v = new GooglePlayVerifier({ packageName: "app.tactiq", serviceAccount, fetchImpl });
    expect((await v.getSubscription("tok/../../x?y")).state).toBe("active");
    await v.getSubscription("t2");
    await v.acknowledge("pro_monthly", "t2");

    const tokenCalls = calls.filter((c) => c.url.startsWith("https://oauth2"));
    expect(tokenCalls).toHaveLength(1); // cached
    const assertion = new URLSearchParams(tokenCalls[0].init.body).get("assertion");
    const [h, p, s] = assertion.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    expect(payload).toMatchObject({ iss: serviceAccount.client_email, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/androidpublisher" });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(keys.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    // The purchase token is path-encoded, so it cannot change the API path.
    expect(calls.find((c) => c.url.includes("tokens/tok")).url).toContain("tokens/tok%2F..%2F..%2Fx%3Fy");
    expect(calls.find((c) => c.url.endsWith(":acknowledge")).init.method).toBe("POST");

    mode = "missing";
    await expect(v.getSubscription("gone")).rejects.toBeInstanceOf(PurchaseNotFoundError);
    mode = "down";
    let err;
    try {
      await v.getSubscription("x");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof PurchaseNotFoundError).toBe(false);
    expect(err.message).not.toContain("tok");
  });

  it("the fake verifier only accepts its own token format and can simulate outages", async () => {
    const f = new FakePurchaseVerifier();
    await expect(f.getSubscription("real-looking-google-token")).rejects.toBeInstanceOf(PurchaseNotFoundError);
    expect((await f.getSubscription("fake:pro_monthly:active:30")).orderId).toBe(FakePurchaseVerifier.orderIdFor("fake:pro_monthly:active:30"));
    f.failWith(new Error("ECONNRESET"));
    await expect(f.getSubscription("fake:pro_monthly:active:30")).rejects.toThrow(/ECONNRESET/);
  });

  it("billing refuses to run without a configured verifier", async () => {
    const billing = new BillingService(null, null, null, null, {});
    expect(billing.configured()).toBe(false);
    let err;
    try {
      await billing.verifyPurchase("u", { productId: "pro_monthly", purchaseToken: "x" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ statusCode: 503, code: "BILLING_NOT_CONFIGURED" });
    await expect(billing.reconcile()).resolves.toEqual({ skipped: true, reason: "billing not configured" });
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetMemoryLimits());

  it("the in-memory fallback never allows more than the limit in a window (property-based)", () => {
    const r = rng();
    for (let round = 0; round < 200; round++) {
      const limit = r.int(1, 20);
      const t0 = 1_800_000_000_000 + round * 1_000_000;
      let ok = 0;
      for (let i = 0; i < limit * 3; i++) if (memoryHit("p", `id${round}`, limit, 60, t0 + i).success) ok++;
      expect(ok).toBe(limit);
      expect(memoryHit("p", `id${round}`, limit, 60, t0 + 61_000).success).toBe(true); // new window
    }
  });

  it("limits are separate per name and per id", () => {
    expect(memoryHit("a", "1", 1, 60).success).toBe(true);
    expect(memoryHit("a", "1", 1, 60).success).toBe(false);
    expect(memoryHit("a", "2", 1, 60).success).toBe(true);
    expect(memoryHit("b", "1", 1, 60).success).toBe(true);
  });

  it("ignores client-supplied forwarding headers outside Netlify and Cloudflare", () => {
    const req = { ip: "10.0.0.5", headers: { "x-forwarded-for": "1.2.3.4", "x-nf-client-connection-ip": "5.6.7.8", "cf-connecting-ip": "9.9.9.9" } };
    expect(clientIp(req)).toBe("10.0.0.5");
    expect(clientIp({ ...req, edgeVerified: true })).toBe("9.9.9.9");
  });
});

describe("request validation middleware", () => {
  const run = (schemas, req) => {
    const res = fakeRes();
    let nextCalled = false;
    validate(schemas)({ headers: {}, params: {}, query: {}, body: {}, id: "r", ...req }, res, () => (nextCalled = true));
    return { res, nextCalled };
  };
  const body = z.object({ name: z.string().max(10) }).strict();

  it("rejects NUL bytes anywhere: values, nested values and keys", () => {
    for (const b of [{ name: "a\u0000b" }, { name: "x", nested: { deep: ["ok", "b\u0000"] } }, { ["k\u0000"]: 1 }]) {
      const { res, nextCalled } = run({ body }, { body: b });
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
    }
    expect(run({ query: z.object({ q: z.string() }) }, { query: { q: "a\u0000" } }).res.statusCode).toBe(400);
  });

  it("rejects hostile nesting without recursion, and unknown fields", () => {
    let deep = "x";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const r1 = run({ body }, { body: { name: "ok", deep } });
    expect(r1.res.statusCode).toBe(400);
    expect(r1.res.body.data.details[0].message).toMatch(/nested too deeply/);
    expect(run({ body }, { body: { name: "ok", isAdmin: true } }).res.statusCode).toBe(400);
    expect(run({ body }, { body: { name: "ok" } }).nextCalled).toBe(true);
  });

  it("random input never throws past the middleware: it either passes or is a 400", () => {
    const r = rng();
    const schema = z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(25).default(8) });
    for (let i = 0; i < 2000; i++) {
      const query = { q: r.pick([randomString(r, 100), ...NASTY_STRINGS]), limit: r.pick([undefined, "0", "-1", "1.5", "NaN", "Infinity", "25", "26", "1e3", String(r.int(-50, 50))]) };
      const { res, nextCalled } = run({ query: schema }, { query });
      expect(nextCalled || res.statusCode === 400).toBe(true);
    }
  });
});

describe("plans and periods", () => {
  it("usage periods are UTC calendar months, including year ends and leap days", () => {
    expect(periodKeyFor("month", new Date("2026-01-31T23:59:59.999Z"))).toBe("2026-01");
    expect(periodKeyFor("month", new Date("2026-02-01T00:00:00.000Z"))).toBe("2026-02");
    expect(periodKeyFor("month", new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12");
    expect(periodKeyFor("month", new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01");
    expect(periodKeyFor("month", new Date("2028-02-29T12:00:00.000Z"))).toBe("2028-02");
    // A local midnight in a far-east timezone is still the previous UTC month.
    expect(periodKeyFor("month", new Date("2026-03-01T00:30:00+05:30"))).toBe("2026-02");
    expect(periodKeyFor("none", new Date())).toBe("all");
  });
});

describe("ads", () => {
  const ent = (enabled) => ({ isEnabled: async () => enabled });

  it("Pro users and unconfigured production get no ads; free users get bounded slots with test units", async () => {
    const dev = new AdsService(ent(true), { NODE_ENV: "development" });
    const slots = await dev.slotsFor("u", "home", 100);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    expect(slots.every((s) => s.adUnitId.startsWith("ca-app-pub-3940256099942544/"))).toBe(true);
    expect(await new AdsService(ent(false), { NODE_ENV: "development" }).slotsFor("u", "home", 100)).toEqual([]);
    expect(await new AdsService(ent(true), { NODE_ENV: "production" }).slotsFor("u", "home", 100)).toEqual([]);
    expect(await dev.slotsFor("u", "home", 0)).toEqual([]);
    const cfg = await new AdsService(ent(false), { NODE_ENV: "development" }).getConfig("u");
    expect(cfg).toMatchObject({ enabled: false, reason: "plan", placements: [] });
    expect(cfg.adFreeScreens).toContain("payment");
  });
});

describe("purchase verifier selection", () => {
  const KEYS = ["NODE_ENV", "NETLIFY", "BILLING_FAKE_VERIFIER", "GOOGLE_PLAY_PACKAGE_NAME", "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"];
  const set = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnv();
    resetPurchaseVerifier();
  };

  it("uses the fake only outside production, the real one when configured, and nothing otherwise", () => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) });
    try {
      set({ BILLING_FAKE_VERIFIER: "true" });
      const fake = getPurchaseVerifier();
      expect(fake).toBeInstanceOf(FakePurchaseVerifier);
      expect(getPurchaseVerifier()).toBe(fake); // one instance per process

      // Production with the fake switched on by mistake: never the fake. NETLIFY marks a hosted runtime, so no
      // .env file is read by this test.
      set({ NODE_ENV: "production", NETLIFY: "true", BILLING_FAKE_VERIFIER: "true" });
      expect(getPurchaseVerifier()).toBe(null);
      set({ GOOGLE_PLAY_PACKAGE_NAME: "app.tactiq", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount });
      expect(getPurchaseVerifier()).toBeInstanceOf(GooglePlayVerifier);

      set({ NODE_ENV: "test", NETLIFY: undefined, BILLING_FAKE_VERIFIER: "false", GOOGLE_PLAY_PACKAGE_NAME: "app.tactiq", GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "" });
      expect(getPurchaseVerifier()).toBe(null); // a package name alone is not enough
    } finally {
      set(saved);
    }
  });
});

describe("Google Play client edge cases", () => {
  it("a refused OAuth token request fails the call without leaking anything, and a token without expires_in is cached for an hour", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccount = { client_email: "sa@test.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
    const refused = new GooglePlayVerifier({ packageName: "app.tactiq", serviceAccount, fetchImpl: async () => new Response("denied", { status: 401 }) });
    let err;
    try {
      await refused.getSubscription("secret-purchase-token");
    } catch (e) {
      err = e;
    }
    expect(err.message).toBe("Google OAuth token request failed: 401");

    let tokenCalls = 0;
    const v = new GooglePlayVerifier({
      packageName: "app.tactiq",
      serviceAccount,
      fetchImpl: async (url) => {
        if (url.startsWith("https://oauth2")) {
          tokenCalls += 1;
          return new Response(JSON.stringify({ access_token: "tok" }));
        }
        return new Response(JSON.stringify({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }));
      },
    });
    await v.getSubscription("a");
    await v.getSubscription("b");
    expect(tokenCalls).toBe(1);
    expect(v.tokenExpiresAt - Date.now() > 3500_000).toBe(true);
  });

  it("an answer without line items or dates maps to nulls, which billing then refuses for any entitled state", () => {
    const v = fromSubscriptionV2({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" });
    expect(v).toMatchObject({ productId: null, state: "active", startedAt: null, expiresAt: null });
    expect(() => assertStoreResponse(v)).toThrow(StoreResponseError);
  });

  it("the fake store keeps dates fixed between reads and fails acknowledgements during an outage", async () => {
    const f = new FakePurchaseVerifier();
    const a = await f.getSubscription("fake:pro_monthly:active");
    await new Promise((r) => setTimeout(r, 5));
    expect((await f.getSubscription("fake:pro_monthly:active")).expiresAt.getTime()).toBe(a.expiresAt.getTime());
    expect(Math.round((a.expiresAt - Date.now()) / 86_400_000)).toBe(30); // default term
    f.setState("fake:pro_monthly:active", "cancelled");
    expect(Math.round(((await f.getSubscription("fake:pro_monthly:active")).expiresAt - Date.now()) / 86_400_000)).toBe(30);
    f.failWith(new Error("ECONNRESET"));
    await expect(f.acknowledge("pro_monthly", "fake:pro_monthly:active")).rejects.toThrow(/ECONNRESET/);
    expect(f.acknowledged.size).toBe(0);
  });
});

describe("error logging edge cases", () => {
  const capture = (fn) => {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return lines.join("\n");
  };

  it("describes non-Error values, wrapped database errors and failed queries without their data", () => {
    expect(describeForLog("plain failure")).toEqual({ error: "Error", message: "plain failure", stack: [] });
    expect(describeForLog(undefined).message).toBe("unknown error");
    const cause = Object.assign(new Error('duplicate key value violates "users_email_uq"'), { code: "23505" });
    const wrapped = new Error("Failed query: insert into users values ($1)\nparams: secret@example.com", { cause });
    const d = describeForLog(wrapped);
    expect(d).toMatchObject({ code: "23505", message: 'duplicate key value violates "…"' });
    expect(JSON.stringify(d)).not.toContain("secret@example.com");
    expect(describeForLog(new Error("Failed query: select $1")).message).toBe("query failed");
  });

  it("logs the route pattern or the path without its query string, and never writes twice", () => {
    const withQuery = capture(() => sendError(new Error("boom"), { method: "GET", originalUrl: "/v1/x?token=secret-value" }, fakeRes()));
    expect(withQuery).toContain('"route":"/v1/x"');
    expect(withQuery).not.toContain("secret-value");
    const routed = capture(() => sendError(new Error("boom"), { method: "GET", baseUrl: "/v1/me", route: { path: "/notes/:id" }, originalUrl: "/v1/me/notes/abc" }, fakeRes()));
    expect(routed).toContain('"route":"/v1/me/notes/:id"');
    expect(capture(() => sendError(new Error("boom"), { method: "GET" }, fakeRes()))).toContain('"route":""');

    const sent = fakeRes();
    sent.headersSent = true;
    expect(capture(() => sendError(new Error("late"), { method: "GET" }, sent))).toBe("");
    expect(sent.body).toBe(null);

    const res = fakeRes();
    sendError(ApiError.notFound("Note"), { method: "GET", id: "req-1" }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.data).toEqual({ code: "NOT_FOUND", requestId: "req-1" });
  });

  it("job errors keep the database cause and are capped", () => {
    const cause = new TypeError("bad input");
    expect(describeError(new Error("Failed query: …", { cause }))).toBe("TypeError: bad input");
    expect(describeError(new Error("x".repeat(5000)))).toHaveLength(1000);
  });
});

describe("job registry and status", () => {
  it("refuses two handlers for one job type, and a runner with no handlers claims nothing", async () => {
    const r = new JobRegistry();
    r.register({ jobType: "a" });
    expect(() => r.register({ jobType: "a" })).toThrow(/duplicate handler/);
    expect(await new JobRunner(null, new JobRegistry(), {}).claim()).toBe(null); // never touches the database
  });

  it("failed and dead jobs show a generic message, never the internal error", () => {
    const jobs = new JobsService(null, null, null);
    for (const status of ["failed", "dead"]) {
      expect(jobs.shape({ status, lastError: "ECONNREFUSED 10.0.0.5:5432" }).error).toBe("The job failed. It will be retried automatically or reviewed by the team.");
    }
    expect(jobs.shape({ status: "completed" }).error).toBe(null);
  });
});

describe("Clerk mapping edge cases", () => {
  it("maps SDK-shaped users: unverified addresses dropped, unstated status trusted, username and avatar fallbacks", () => {
    const p = toProfile({
      id: "user_sdk",
      username: "ada_fan",
      imageUrl: "https://img.example/a.png",
      primaryEmailAddressId: "missing",
      emailAddresses: [
        { id: "e1", emailAddress: "bad@example.com", verification: { status: "unverified" } },
        { id: "e2", emailAddress: "trusted@example.com" },
      ],
      externalAccounts: [
        { provider: "oauth_apple", externalId: "apple-1", emailAddress: null },
        { provider: "oauth_google" }, // no subject: not an identity
      ],
    });
    expect(p).toEqual({
      clerkUserId: "user_sdk",
      email: "trusted@example.com",
      displayName: "ada_fan",
      avatarUrl: "https://img.example/a.png",
      identities: [{ provider: "apple", subject: "apple-1", email: null }],
    });
    expect(toProfile({ id: "bare" })).toEqual({ clerkUserId: "bare", email: null, displayName: null, avatarUrl: null, identities: [] });
  });

  it("without configured authorized parties any azp is accepted (Android has no web origin); a non-string sid is dropped", async () => {
    resetEnv();
    const saved = { key: process.env.CLERK_JWT_KEY, parties: process.env.CLERK_AUTHORIZED_PARTIES };
    process.env.CLERK_JWT_KEY = TEST_JWT_PUBLIC_KEY;
    process.env.CLERK_AUTHORIZED_PARTIES = "";
    try {
      expect(await verifySessionToken(signSessionToken("u1", { azp: "https://anything.example", sid: 42 }))).toEqual({ clerkUserId: "u1", sessionId: null });
    } finally {
      process.env.CLERK_JWT_KEY = saved.key;
      process.env.CLERK_AUTHORIZED_PARTIES = saved.parties;
      resetEnv();
    }
  });
});
