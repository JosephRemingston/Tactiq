// Failure injection at every dependency boundary: Postgres down, pool pressure, Redis failing, storage down, the
// store (Google Play) down, the data provider down, missing webhook secret, and a transaction failing half-way.
// The API must answer predictably, leak nothing, and leave no partial state.
import { SKIP, startTestApp, DB_URL } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";

describe("failure handling", { skip: SKIP ?? false }, () => {
  let t;
  let env;
  let database;
  let redis;
  let s3;
  let svc;

  before(async () => {
    t = await startTestApp();
    env = await import("../configs/env.js");
    database = await import("../configs/database.js");
    redis = await import("../configs/redis.js");
    s3 = await import("../configs/s3.js");
    svc = await import("../services/index.js");
  });
  after(async () => t?.close());

  /** Switches configuration for the duration of `fn`, rebuilding the clients that depend on it. */
  async function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    env.resetEnv();
    await database.closeDB();
    s3.resetStorage();
    svc.resetServices();
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      env.resetEnv();
      await database.closeDB();
      s3.resetStorage();
      svc.resetServices();
    }
  }

  const leaks = (res) => /ECONNREFUSED|127\.0\.0\.1|5432|:9\b|postgres:|password|stack|node_modules/i.test(res.text);

  it("Postgres unavailable: predictable 500/503, no connection details, and recovery afterwards", async () => {
    const u = await t.newUser("dbdown");
    await withEnv({ DATABASE_URL: "postgres://touchline:wrong@127.0.0.1:1/none" }, async () => {
      for (const [path, token] of [["/v1/competitions"], ["/v1/me", u.token], ["/v1/me/notes", u.token]]) {
        const res = await t.get(path, { token });
        expect(res.status).toBe(500);
        expect(res.body.data.code).toBe("INTERNAL");
        expect(leaks(res)).toBe(false);
      }
      const ready = await t.get("/readyz");
      expect(ready.status).toBe(503);
      expect(ready.body.data.checks.database).toBe("down");
      expect(leaks(ready)).toBe(false);
    });
    expect((await t.get("/v1/me", { token: u.token })).status).toBe(200);
    expect(DB_URL).toContain("touchline_");
  });

  it("connection pool pressure: many parallel requests on a 2-connection pool all complete", async () => {
    await withEnv({ DATABASE_POOL_MAX: "2" }, async () => {
      const u = await t.newUser("pool");
      const res = await Promise.all(Array.from({ length: 40 }, (_, i) => t.get(i % 2 ? "/v1/me/notes" : "/v1/competitions", { token: u.token })));
      expect(res.every((r) => r.status === 200)).toBe(true);
    });
  });

  it("Redis failing: reads still work uncached and readiness reports it", async () => {
    const failing = new Proxy({}, { get: (_, p) => (p === "then" ? undefined : p === "addTelemetry" ? () => {} : async () => Promise.reject(new Error("UPSTASH_DOWN"))) });
    redis.setRedisClientForTests(failing);
    try {
      const u = await t.newUser("redisdown");
      expect((await t.get(`/v1/matches/${t.matchIds["3869685"]}`)).status).toBe(200);
      expect((await t.get(`/v1/matches/${t.matchIds["3869685"]}/pressing`, { token: u.token })).status).toBe(200);
      const ready = await t.get("/readyz");
      expect(ready.status).toBe(503);
      expect(ready.body.data.checks.redis).toBe("down");
    } finally {
      redis.setRedisClientForTests(null);
    }
  });

  it("object storage unavailable: readiness is 503 and does not reveal the endpoint", async () => {
    await withEnv({ STORAGE_DRIVER: "s3", S3_ENDPOINT: "http://127.0.0.1:9", S3_ACCESS_KEY_ID: "x", S3_SECRET_ACCESS_KEY: "y", S3_BUCKET_RAW: "b" }, async () => {
      const ready = await t.get("/readyz");
      expect(ready.status).toBe(503);
      expect(ready.body.data.checks.storage).toBe("down");
      expect(leaks(ready)).toBe(false);
    });
  });

  it("the football data provider down: ingestion fails with a retryable error, never hangs or crashes", async () => {
    const { ProviderRegistry } = await import("../services/providers/registry.js");
    const { ProviderRateLimiter } = await import("../services/providers/rateLimiter.js");
    const config = { ...t.services().config, STATSBOMB_SOURCE: "github", STATSBOMB_OPEN_DATA_BASE_URL: "http://127.0.0.1:9/data" };
    const adapter = new ProviderRegistry(config, new ProviderRateLimiter(config)).get("statsbomb");
    const started = Date.now();
    let err;
    try {
      await adapter.listCompetitions({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("Clerk webhook secret missing: 503, nothing processed", async () => {
    await withEnv({ CLERK_WEBHOOK_SIGNING_SECRET: "" }, async () => {
      const body = JSON.stringify({ type: "user.created", data: { id: "user_nosecret" } });
      const res = await t.call("POST", "/v1/webhooks/clerk", { body, headers: t.signWebhook(body), raw: true });
      expect(res.status).toBe(503);
      expect((await database.getDb().execute(t.sql`select count(*)::int as n from users where clerk_user_id = 'user_nosecret'`)).rows[0].n).toBe(0);
    });
  });

  it("a billing transaction failing half-way leaves no purchase, subscription or grant behind", async () => {
    const u = await t.newUser("atomic");
    const tk = `fake:pro_monthly:active:30::${randomBytes(6).toString("hex")}`;
    const verified = await t.services().billing.verifier.getSubscription(tk);
    let threw = false;
    try {
      // A product pointing at a plan that does not exist fails inside the transaction, after the purchase upsert.
      await t.services().billing.applyState(u.id, tk, { productId: "pro_monthly", planKey: "plan_that_does_not_exist" }, verified, "test");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const { rows } = await database.getDb().execute(t.sql`
      select (select count(*)::int from purchases where purchase_token = ${tk}) as purchases,
             (select count(*)::int from subscriptions where user_id = ${u.id}) as subs,
             (select count(*)::int from entitlements where user_id = ${u.id} and source_plan <> 'free') as grants`);
    expect(rows[0]).toEqual({ purchases: 0, subs: 0, grants: 0 });
  });

  it("a malformed store response (missing product) is rejected without writing anything", async () => {
    const u = await t.newUser("malformedstore");
    const tk = `fake:pro_monthly:active:30::${randomBytes(6).toString("hex")}`;
    t.services().billing.verifier.setState(tk, "active", 30, { productId: undefined, expiresAt: "not a date" });
    const res = await t.call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: tk } });
    expect(res.status).toBe(400);
    expect((await database.getDb().execute(t.sql`select count(*)::int as n from purchases where purchase_token = ${tk}`)).rows[0].n).toBe(0);
  });
});

describe("hostile provider data", { skip: SKIP ?? false }, () => {
  it("schema drift and wrong types are rejected before any value reaches storage paths or SQL", async () => {
    const { StatsBombNormalizer } = await import("../services/providers/statsbomb/normalizer.js");
    const { ProviderSchemaError } = await import("../services/providers/provider.js");
    const n = new StatsBombNormalizer();
    const goodMatch = {
      match_id: 1,
      match_date: "2022-12-18",
      kick_off: "17:00:00.000",
      competition: { competition_id: 43, competition_name: "WC" },
      season: { season_id: 106, season_name: "2022" },
      home_team: { home_team_id: 1, home_team_name: "A" },
      away_team: { away_team_id: 2, away_team_name: "B" },
      home_score: 1,
      away_score: 0,
      match_status: "available",
    };
    for (const bad of [
      [{ ...goodMatch, match_id: "../../etc/passwd" }],
      [{ ...goodMatch, match_id: 1.5 }],
      [{ ...goodMatch, competition: { competition_id: "43; drop table matches", competition_name: "x" } }],
      [{ ...goodMatch, match_id: null }],
      { not: "an array" },
    ]) {
      expect(() => n.normalizeMatches(bad)).toThrow(ProviderSchemaError);
    }
    expect(() => n.normalizeEvents([{ id: "not-a-uuid", index: 1 }])).toThrow(ProviderSchemaError);
    expect(() => n.normalizeEvents("{}")).toThrow(ProviderSchemaError);
  });

  it("the local transport refuses paths that escape its directory", async () => {
    const { LocalDirTransport, TransportError } = await import("../services/providers/statsbomb/transport.js");
    const tr = new LocalDirTransport(join(import.meta.dirname, "fixtures", "statsbomb"));
    for (const p of ["../../package.json", "../../../.env", "/etc/passwd", "matches/../../../.env"]) {
      let err;
      try {
        await tr.get(p);
      } catch (e) {
        err = e;
      }
      if (err) expect(err).toBeInstanceOf(TransportError);
      else expect((await tr.get(p)).status).toBe(404);
    }
  });

  it("a corrupt stored raw payload fails the job with a parse error instead of crashing the worker", async () => {
    const { RawPayloadStore } = await import("../services/rawPayload.service.js");
    const writes = new Map([["raw/statsbomb/events/1/x.json", Buffer.from('{"truncated": [1, 2,')]]);
    const store = new RawPayloadStore(null, { get: async (k) => writes.get(k) ?? null, put: async () => {}, exists: async () => true });
    let err;
    try {
      await store.readJson("raw/statsbomb/events/1/x.json");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyntaxError);
  });
});

import { join } from "node:path";
