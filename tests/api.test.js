// End-to-end API tests: real Express app, real Postgres, real Clerk token verification (test keys),
// the StatsBomb fixtures run through the full job pipeline, and the fake Google Play verifier.
//
// Needs a disposable Postgres database:
//   TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_e2e npm test
// Skipped when TEST_DATABASE_URL is not set. Never point it at a database whose data you want to keep.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, before, after, expect } from "./support/expect.js";
import { TEST_AUTHORIZED_PARTY, TEST_JWT_PUBLIC_KEY, TEST_WEBHOOK_SECRET, signSessionToken, signWebhook } from "./support/tokens.js";

const DB_URL = process.env.TEST_DATABASE_URL;
const RTDN_TOKEN = "rtdn-test-token";
const FINAL_2022 = "3869685";
const FINAL_2018 = "8658";

if (!DB_URL) {
  describe("API (end to end)", () => {
    it("skipped: set TEST_DATABASE_URL to a disposable Postgres database to run", { skip: true }, () => {});
  });
} else {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    REDIS_URL: "",
    STORAGE_DRIVER: "fs",
    STORAGE_FS_ROOT: join(import.meta.dirname, "..", ".data", "test-storage"),
    S3_ENDPOINT: "",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    CLERK_JWT_KEY: TEST_JWT_PUBLIC_KEY,
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_AUTHORIZED_PARTIES: TEST_AUTHORIZED_PARTY,
    CLERK_WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SECRET,
    STATSBOMB_SOURCE: "local",
    STATSBOMB_OPEN_DATA_LOCAL_DIR: join(import.meta.dirname, "fixtures", "statsbomb"),
    STATSBOMB_RATE_PER_SECOND: "1000",
    BILLING_FAKE_VERIFIER: "true",
    GOOGLE_PLAY_RTDN_TOKEN: RTDN_TOKEN,
    GOOGLE_PLAY_PACKAGE_NAME: "app.tactiq.test",
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "",
    ADMOB_NATIVE_UNIT_ID: "",
    ADMOB_BANNER_UNIT_ID: "",
    EDGE_SHARED_SECRET: "",
    CORS_ORIGINS: "",
  });

  const { sql } = await import("drizzle-orm");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { getDb, getPool, closeDB } = await import("../configs/database.js");
  const { seed } = await import("../services/seed.service.js");
  const { services } = await import("../services/index.js");
  const { workers } = await import("../workers/index.js");
  const { createApp } = await import("../app.js");
  const { obfuscatedAccountId } = await import("../services/billing.service.js");

  let server;
  let base;
  const matchIds = {};

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  const get = (path, opts) => call("GET", path, opts);

  /** A fresh signed-in user. The first authenticated request creates the local row. */
  async function newUser() {
    const clerkId = `user_${randomBytes(6).toString("hex")}`;
    const token = signSessionToken(clerkId);
    const me = await get("/v1/me", { token });
    expect(me.status).toBe(200);
    return { clerkId, token, id: me.body.data.user.id };
  }

  const rtdn = (messageId, notification, token = RTDN_TOKEN) =>
    call("POST", `/v1/webhooks/google-play-rtdn?token=${encodeURIComponent(token)}`, {
      body: {
        message: {
          messageId,
          data: Buffer.from(JSON.stringify({ version: "1.0", packageName: "app.tactiq.test", ...notification })).toString("base64"),
        },
        subscription: "projects/test/subscriptions/rtdn",
      },
    });

  before(async () => {
    const db = getDb();
    await getPool().query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "migrations") });
    await seed(db);
    await db.execute(sql`truncate users, security_events, entitlement_audit, ingestion_jobs, billing_notifications restart identity cascade`);

    // Ingest and analyse the two fixture finals through the real job chain.
    const { ingestion } = services();
    const started = await ingestion.startSync({ provider: "statsbomb", matchIds: [FINAL_2022, FINAL_2018], ingestMatches: true });
    await workers().runner.drain({ budgetMs: 120_000 });
    const summary = await ingestion.traceSummary(started.traceId);
    if (!summary.done || summary.failures.length) throw new Error(`pipeline failed: ${JSON.stringify(summary)}`);

    const { rows } = await db.execute(sql`
      select pem.provider_entity_id as provider_id, pem.canonical_id as id
        from provider_entity_maps pem
       where pem.provider = 'statsbomb' and pem.entity_type = 'match' and pem.provider_entity_id in (${FINAL_2022}, ${FINAL_2018})`);
    for (const r of rows) matchIds[r.provider_id] = r.id;

    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closeDB();
  });

  describe("health and errors", () => {
    it("liveness and readiness", async () => {
      expect((await get("/healthz")).status).toBe(200);
      const ready = await get("/readyz");
      expect(ready.status).toBe(200);
      expect(ready.body.data.checks.database).toBe("ok");
    });
    it("uses one envelope for errors and never leaks internals", async () => {
      const notFound = await get("/v1/nope");
      expect(notFound.status).toBe(404);
      expect(notFound.body).toMatchObject({ statusCode: 404, data: { code: "NOT_FOUND" } });
      const invalid = await get("/v1/matches/not-a-uuid");
      expect(invalid.status).toBe(400);
      expect(invalid.body.data.code).toBe("VALIDATION_FAILED");
      const unknownJob = await get("/v1/jobs/does.not.exist");
      expect(unknownJob.status).toBe(404);
    });
  });

  describe("public football data", () => {
    it("lists the ingested competition, matches and a match story", async () => {
      const comps = await get("/v1/competitions");
      expect(comps.status).toBe(200);
      expect(comps.body.data.competitions.some((c) => c.name === "FIFA World Cup")).toBe(true);

      const list = await get("/v1/matches?status=played");
      expect(list.body.data.matches.length).toBeGreaterThanOrEqual(2);

      const match = await get(`/v1/matches/${matchIds[FINAL_2022]}`);
      expect(match.status).toBe(200);
      expect(match.body.data.match.coverage.hasEvents).toBe(true);

      const story = await get(`/v1/matches/${matchIds[FINAL_2022]}/story`);
      expect(story.status).toBe(200);
      expect(story.body.data.story.status).toBe("full");
      expect(story.body.data.story.keyPatterns.length).toBeGreaterThan(0);

      const insights = await get(`/v1/matches/${matchIds[FINAL_2022]}/insights?depth=explore`);
      expect(insights.body.data.insights.length).toBeGreaterThan(0);
    });
    it("serves the unfiltered timeline to everyone", async () => {
      const events = await get(`/v1/matches/${matchIds[FINAL_2022]}/events?limit=50`);
      expect(events.status).toBe(200);
      expect(events.body.data.events).toHaveLength(50);
      expect(events.body.data.page.nextCursor).toBeTruthy();
    });
  });

  describe("authentication and ownership", () => {
    it("rejects missing, tampered, expired and wrong-audience tokens", async () => {
      expect((await get("/v1/me")).status).toBe(401);
      const token = signSessionToken("user_tamper");
      expect((await get("/v1/me", { token: `${token.slice(0, -4)}AAAA` })).status).toBe(401);
      expect((await get("/v1/me", { token: signSessionToken("user_old", { expiresInSec: -60 }) })).status).toBe(401);
      expect((await get("/v1/me", { token: signSessionToken("user_azp", { azp: "https://evil.example" }) })).status).toBe(401);
      // A bad token is a 401 even on a public route.
      expect((await get("/v1/competitions", { token: "garbage" })).status).toBe(401);
    });
    it("creates the local user on first use and starts on the free plan", async () => {
      const u = await newUser();
      const me = await get("/v1/me", { token: u.token });
      expect(me.body.data.user.plan.key).toBe("free");
    });
    it("hides another user's private data behind 404", async () => {
      const a = await newUser();
      const b = await newUser();
      const created = await call("POST", "/v1/me/notes", {
        token: a.token,
        body: { subjectType: "match", subjectId: matchIds[FINAL_2022], body: "Watch the left channel" },
      });
      expect(created.status).toBe(201);
      const noteId = created.body.data.note.id;
      expect((await get(`/v1/me/notes/${noteId}`, { token: a.token })).status).toBe(200);
      expect((await get(`/v1/me/notes/${noteId}`, { token: b.token })).status).toBe(404);
      expect((await call("DELETE", `/v1/me/notes/${noteId}`, { token: b.token })).status).toBe(404);
      expect((await get(`/v1/me/notes/${noteId}`, { token: a.token })).status).toBe(200);
    });
    it("rejects unknown fields on private writes", async () => {
      const u = await newUser();
      const res = await call("PATCH", "/v1/me", { token: u.token, body: { depthPreference: "advanced", userId: "someone-else" } });
      expect(res.status).toBe(400);
    });
  });

  describe("paywall", () => {
    it("charges one unit per match, not per view", async () => {
      const u = await newUser();
      const first = await get(`/v1/matches/${matchIds[FINAL_2022]}/metrics`, { token: u.token });
      expect(first.status).toBe(200);
      expect(first.headers.get("x-entitlement-remaining")).toBe("19");
      const again = await get(`/v1/matches/${matchIds[FINAL_2022]}/pressing`, { token: u.token });
      expect(again.status).toBe(200);
      expect(again.headers.get("x-entitlement-remaining")).toBe("19");
      const other = await get(`/v1/matches/${matchIds[FINAL_2018]}/transitions`, { token: u.token });
      expect(other.headers.get("x-entitlement-remaining")).toBe("18");
    });
    it("returns ENTITLEMENT_EXCEEDED with the unlocking plans once the monthly limit is used", async () => {
      const u = await newUser();
      const period = new Date().toISOString().slice(0, 7);
      const { db } = services();
      await db.execute(sql`insert into entitlement_usage (user_id, feature_key, period_key, used) values (${u.id}, 'analysis.matches_per_month', ${period}, 20)`);
      const res = await get(`/v1/matches/${matchIds[FINAL_2022]}/metrics`, { token: u.token });
      expect(res.status).toBe(403);
      expect(res.body.data.code).toBe("ENTITLEMENT_EXCEEDED");
      expect(res.body.data.details.paywall).toBe(true);
      expect(res.body.data.details.unlockedBy).toEqual(["pro_monthly", "pro_annual"]);
    });
    it("keeps advanced filters for Pro and asks anonymous users to sign in", async () => {
      const u = await newUser();
      const path = `/v1/matches/${matchIds[FINAL_2022]}/events?type=shot`;
      expect((await get(path)).status).toBe(401);
      const free = await get(path, { token: u.token });
      expect(free.status).toBe(403);
      expect(free.body.data.code).toBe("ENTITLEMENT_REQUIRED");
      expect(free.body.data.details.featureKey).toBe("analysis.advanced_filters");
    });
    it("lists every feature with its limit and usage", async () => {
      const u = await newUser();
      const res = await get("/v1/entitlements", { token: u.token });
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.data.entitlements.map((e) => [e.featureKey, e]));
      expect(byKey["analysis.matches_per_month"].limitValue).toBe(20);
      expect(byKey["analysis.advanced_filters"].limitValue).toBe(0);
      expect(byKey["ads.enabled"].limitValue).toBe(1);
    });
    it("publishes the plan catalogue for the paywall screen", async () => {
      const res = await get("/v1/billing/products");
      expect(res.status).toBe(200);
      expect(res.body.data.billingAvailable).toBe(true);
      expect(res.body.data.plans.map((p) => p.planKey)).toEqual(["free", "pro_monthly", "pro_annual"]);
      expect(res.body.data.comparison.length).toBeGreaterThan(0);
    });
  });

  describe("Google Play billing", () => {
    it("verifies a purchase once, grants Pro and unlocks Pro features", async () => {
      const u = await newUser();
      const token = `fake:pro_monthly:active:30:${obfuscatedAccountId(u.id)}`;
      const res = await call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: token } });
      expect(res.status).toBe(200);
      expect(res.body.data.plan.key).toBe("pro_monthly");
      expect(res.body.data.purchase.entitled).toBe(true);

      const again = await call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: token } });
      expect(again.status).toBe(200);
      const { db } = services();
      const subs = await db.execute(sql`select count(*)::int as n from subscriptions where user_id = ${u.id}`);
      expect(subs.rows[0].n).toBe(1);
      expect(services().billing.verifier.acknowledged.has(token)).toBe(true);

      const filtered = await get(`/v1/matches/${matchIds[FINAL_2022]}/events?type=shot`, { token: u.token });
      expect(filtered.status).toBe(200);
      const metrics = await get(`/v1/matches/${matchIds[FINAL_2022]}/metrics`, { token: u.token });
      expect(metrics.headers.get("x-entitlement-remaining")).toBe(null);
      const ents = await get("/v1/entitlements", { token: u.token });
      const byKey = Object.fromEntries(ents.body.data.entitlements.map((e) => [e.featureKey, e]));
      expect(byKey["analysis.matches_per_month"].limitValue).toBe(null);
      expect(byKey["ads.enabled"].limitValue).toBe(0);
    });
    it("rejects a token already linked to another account, a mismatched account and unknown products", async () => {
      const a = await newUser();
      const b = await newUser();
      const token = `fake:pro_annual:active:300`;
      expect((await call("POST", "/v1/billing/google-play/verify", { token: a.token, body: { productId: "pro_annual", purchaseToken: token } })).status).toBe(200);
      const stolen = await call("POST", "/v1/billing/google-play/verify", { token: b.token, body: { productId: "pro_annual", purchaseToken: token } });
      expect(stolen.status).toBe(409);
      const mismatch = await call("POST", "/v1/billing/google-play/verify", {
        token: b.token,
        body: { productId: "pro_monthly", purchaseToken: `fake:pro_monthly:active:30:${obfuscatedAccountId(a.id)}` },
      });
      expect(mismatch.status).toBe(403);
      const unknown = await call("POST", "/v1/billing/google-play/verify", { token: b.token, body: { productId: "gold_plan", purchaseToken: "fake:gold_plan:active" } });
      expect(unknown.status).toBe(400);
      const bogus = await call("POST", "/v1/billing/google-play/verify", { token: b.token, body: { productId: "pro_monthly", purchaseToken: "not-a-store-token" } });
      expect(bogus.status).toBe(400);
    });
    it("maps every store state to the right access", async () => {
      const u = await newUser();
      const token = `fake:pro_monthly:active:30`;
      await call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: token } });
      const verifier = services().billing.verifier;
      const planAfter = async (state, days = 30) => {
        verifier.setState(token, state, days);
        const res = await call("POST", "/v1/billing/restore", { token: u.token });
        expect(res.status).toBe(200);
        return res.body.data.plan.key;
      };
      expect(await planAfter("grace")).toBe("pro_monthly");
      expect(await planAfter("on_hold")).toBe("free");
      expect(await planAfter("active")).toBe("pro_monthly");
      expect(await planAfter("paused")).toBe("free");
      expect(await planAfter("cancelled", 5)).toBe("pro_monthly"); // access until the paid-through date
      expect(await planAfter("cancelled", -1)).toBe("free");
      expect(await planAfter("expired")).toBe("free");
    });
    it("handles notifications: authenticated, idempotent, and revocation ends access", async () => {
      const u = await newUser();
      const token = `fake:pro_monthly:active:30:${obfuscatedAccountId(u.id)}`;
      await call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: token } });

      const note = { subscriptionNotification: { version: "1.0", notificationType: 12, purchaseToken: token, subscriptionId: "pro_monthly" } };
      expect((await rtdn("msg-unauth", note, "wrong-token")).status).toBe(401);
      const first = await rtdn("msg-revoke-1", note);
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("processed");
      expect((await get("/v1/me", { token: u.token })).body.data.user.plan.key).toBe("free");

      const replay = await rtdn("msg-revoke-1", note);
      expect(replay.body.data.status).toBe("duplicate");
      const unknown = await rtdn("msg-unknown", { subscriptionNotification: { version: "1.0", notificationType: 4, purchaseToken: "fake:pro_monthly:active" } });
      expect(unknown.body.data.status).toBe("ignored");
    });
  });

  describe("ads", () => {
    it("serves placements to free users and anonymous visitors, none to Pro", async () => {
      const anon = await get("/v1/ads/config");
      expect(anon.body.data.ads.enabled).toBe(true);
      expect(anon.body.data.ads.placements.length).toBeGreaterThan(0);
      expect(anon.body.data.ads.adFreeScreens).toContain("match_story");

      const u = await newUser();
      expect((await get("/v1/ads/config", { token: u.token })).body.data.ads.enabled).toBe(true);
      await call("POST", "/v1/billing/google-play/verify", {
        token: u.token,
        body: { productId: "pro_monthly", purchaseToken: `fake:pro_monthly:active:30:${obfuscatedAccountId(u.id)}` },
      });
      const pro = await get("/v1/ads/config", { token: u.token });
      expect(pro.body.data.ads.enabled).toBe(false);
      expect(pro.body.data.ads.placements).toEqual([]);
    });
    it("never puts user data in the ad payload", async () => {
      const u = await newUser();
      const res = await get("/v1/ads/config", { token: u.token });
      const text = JSON.stringify(res.body.data);
      expect(text).not.toContain(u.id);
      expect(text).not.toContain(u.clerkId);
    });
  });

  describe("Clerk webhook", () => {
    it("accepts signed events once and rejects unsigned ones", async () => {
      const clerkId = `user_${randomBytes(6).toString("hex")}`;
      const body = JSON.stringify({
        type: "user.created",
        data: { id: clerkId, first_name: "Ada", last_name: "Fan", email_addresses: [{ id: "e1", email_address: "ada@example.com" }], primary_email_address_id: "e1" },
      });
      const headers = signWebhook(body);
      const ok = await call("POST", "/v1/webhooks/clerk", { body, headers });
      expect(ok.status).toBe(200);
      const dup = await call("POST", "/v1/webhooks/clerk", { body, headers });
      expect(dup.body.data.duplicate).toBe(true);
      const me = await get("/v1/me", { token: signSessionToken(clerkId) });
      expect(me.body.data.user.displayName).toBe("Ada Fan");
      const forged = await call("POST", "/v1/webhooks/clerk", { body, headers: { ...headers, "svix-signature": "v1,AAAA" } });
      expect(forged.status).toBe(401);
    });
  });

  describe("jobs", () => {
    it("returns the existing job for an already analysed match instead of charging again", async () => {
      const u = await newUser();
      const res = await call("POST", `/v1/matches/${matchIds[FINAL_2022]}/analysis-jobs`, { token: u.token });
      expect(res.status).toBe(202);
      expect(res.body.data.job.existing).toBe(true);
      expect(res.body.data.job.status).toBe("completed");
      const ents = await get("/v1/entitlements", { token: u.token });
      expect(ents.body.data.entitlements.find((e) => e.featureKey === "analysis.rerun_per_month").used).toBe(0);
    });
    it("re-running the pipeline creates no duplicate rows", async () => {
      const { db, ingestion } = services();
      const count = async () => (await db.execute(sql`select (select count(*) from events)::int as e, (select count(*) from tactical_metrics)::int as m`)).rows[0];
      const before = await count();
      await ingestion.startSync({ provider: "statsbomb", matchIds: [FINAL_2022, FINAL_2018], ingestMatches: true, force: true });
      await workers().runner.drain({ budgetMs: 120_000 });
      expect(await count()).toEqual(before);
    });
  });
}
