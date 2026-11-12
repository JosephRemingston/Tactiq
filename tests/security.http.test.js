// HTTP-level controls: security headers, caching, CORS, the optional edge gate, method handling, and rate limits
// (including their behaviour when Redis is missing or failing, and attempts to bypass them).
import { SKIP, startTestApp } from "./support/harness.js";
import { describe, it, before, after, beforeEach, expect } from "./support/expect.js";

describe("HTTP security controls", { skip: SKIP ?? false }, () => {
  let t;
  let resetEnv;
  let resetMemoryLimits;
  let setRedisClientForTests;
  let createApp;

  before(async () => {
    t = await startTestApp();
    ({ resetEnv } = await import("../configs/env.js"));
    ({ resetMemoryLimits } = await import("../middlewares/rateLimit.middleware.js"));
    ({ setRedisClientForTests } = await import("../configs/redis.js"));
    ({ createApp } = await import("../app.js"));
  });
  after(async () => t?.close());

  /** Runs `fn` against a second app built with extra environment, then restores everything. */
  async function withApp(env, fn) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    resetEnv();
    resetMemoryLimits();
    const server = createApp().listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn((path, init = {}) => fetch(`${base}${path}`, init));
    } finally {
      await new Promise((r) => server.close(r));
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnv();
      resetMemoryLimits();
    }
  }

  describe("headers", () => {
    it("every response, success or error, carries the security headers and no server fingerprint", async () => {
      for (const path of ["/v1/competitions", "/v1/nope", "/v1/matches/not-a-uuid", "/v1/me"]) {
        const res = await t.get(path);
        const h = res.headers;
        expect(h.get("content-security-policy")).toBe("default-src 'none';frame-ancestors 'none'");
        expect(h.get("strict-transport-security")).toContain("max-age=");
        expect(h.get("x-content-type-options")).toBe("nosniff");
        expect(h.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(h.get("referrer-policy")).toBe("no-referrer");
        expect(h.get("x-powered-by")).toBe(null);
        expect(h.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
        expect(h.get("vary")).toContain("Authorization");
      }
    });

    it("authenticated responses are never storable by shared caches", async () => {
      const u = await t.newUser("cache");
      for (const path of ["/v1/me", "/v1/entitlements", "/v1/competitions", "/v1/me/notes"]) {
        expect((await t.get(path, { token: u.token })).headers.get("cache-control")).toBe("private, no-store");
      }
    });

    it("error bodies contain only the envelope: no stack, SQL, paths or internals", async () => {
      const u = await t.newUser("errbody");
      const responses = [
        await t.get("/v1/nope"),
        await t.get("/v1/matches/not-a-uuid"),
        await t.get("/v1/me"),
        await t.get(`/v1/matches/00000000-0000-7000-8000-000000000000`),
        await t.call("POST", "/v1/me/notes", { token: u.token, body: '{"bad', headers: { "content-type": "application/json" }, raw: true }),
        await t.call("POST", "/v1/me/notes", { token: u.token, body: JSON.stringify({ body: "x".repeat(300_000) }), headers: { "content-type": "application/json" }, raw: true }),
      ];
      for (const res of responses) {
        expect(Object.keys(res.body).sort()).toEqual(["data", "message", "statusCode"]);
        for (const k of Object.keys(res.body.data)) expect(["code", "details", "requestId"]).toContain(k);
        expect(res.text).not.toMatch(/at .+\.js:\d+|node_modules|select |insert |postgres|\/Users\//i);
      }
    });

    it("unsupported methods on existing paths are 404, not executed", async () => {
      for (const method of ["PUT", "DELETE", "PATCH", "POST"]) {
        expect((await t.call(method, "/v1/competitions", { body: method === "GET" ? undefined : {} })).status).toBe(404);
      }
      expect((await t.call("HEAD", "/v1/competitions")).status).toBe(200);
    });
  });

  describe("CORS", () => {
    it("with no configured origins, no browser origin is granted access", async () => {
      for (const origin of ["https://evil.example", "null", "http://localhost:3000"]) {
        const res = await t.get("/v1/competitions", { headers: { origin } });
        expect(res.headers.get("access-control-allow-origin")).toBe(null);
      }
    });

    it("with an allowlist, only exact origins are granted, and never with credentials", async () => {
      await withApp({ CORS_ORIGINS: "https://app.tactiq.test" }, async (f) => {
        const ok = await f("/v1/competitions", { headers: { origin: "https://app.tactiq.test" } });
        expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.tactiq.test");
        expect(ok.headers.get("access-control-allow-credentials")).toBe(null);
        for (const origin of ["https://evil.example", "null", "http://app.tactiq.test", "https://app.tactiq.test.evil.example", "https://sub.app.tactiq.test", "https://app.tactiq.test:8443"]) {
          const res = await f("/v1/competitions", { headers: { origin } });
          expect(res.headers.get("access-control-allow-origin")).toBe(null);
        }
        const preflight = await f("/v1/me/notes", { method: "OPTIONS", headers: { origin: "https://app.tactiq.test", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
        const evilPreflight = await f("/v1/me/notes", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "DELETE" } });
        expect(evilPreflight.headers.get("access-control-allow-origin")).toBe(null);
      });
    });

    it("CORS is not authentication: an allowed origin without a token is still a 401", async () => {
      await withApp({ CORS_ORIGINS: "https://app.tactiq.test" }, async (f) => {
        expect((await f("/v1/me", { headers: { origin: "https://app.tactiq.test" } })).status).toBe(401);
      });
    });
  });

  describe("edge gate (Cloudflare in front)", () => {
    it("rejects requests without the edge secret, allows them with it, and exempts liveness", async () => {
      await withApp({ EDGE_SHARED_SECRET: "edge-secret-for-tests" }, async (f) => {
        expect((await f("/v1/competitions")).status).toBe(403);
        expect((await f("/v1/competitions", { headers: { "x-edge-secret": "wrong" } })).status).toBe(403);
        expect((await f("/v1/competitions", { headers: { "x-edge-secret": "edge-secret-for-tests-and-more" } })).status).toBe(403);
        expect((await f("/v1/competitions", { headers: { "x-edge-secret": "EDGE-SECRET-FOR-TESTS" } })).status).toBe(403);
        expect((await f("/v1/competitions", { headers: { "x-edge-secret": "edge-secret-for-tests" } })).status).toBe(200);
        expect((await f("/healthz")).status).toBe(200);
      });
    });
  });

  describe("rate limiting", () => {
    beforeEach(() => resetMemoryLimits());

    it("REGRESSION F-07: anonymous callers are limited per IP even without Redis, with retry-after", async () => {
      await withApp({ THROTTLE_IP_PER_MIN: "5" }, async (f) => {
        const statuses = [];
        for (let i = 0; i < 7; i++) statuses.push(await f("/v1/competitions"));
        expect(statuses.slice(0, 5).every((r) => r.status === 200)).toBe(true);
        const limited = statuses[5];
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
        expect((await limited.json()).data.code).toBe("RATE_LIMITED");
      });
    });

    it("spoofed forwarding headers, other routes and other methods do not reset the per-IP budget", async () => {
      await withApp({ THROTTLE_IP_PER_MIN: "4" }, async (f) => {
        for (let i = 0; i < 4; i++) await f("/v1/competitions");
        const attempts = [
          f("/v1/teams", { headers: { "x-forwarded-for": "203.0.113.7" } }),
          f("/v1/concepts", { headers: { "x-nf-client-connection-ip": "198.51.100.9" } }),
          f("/v1/search?q=ar", { headers: { "cf-connecting-ip": "192.0.2.1", "x-real-ip": "192.0.2.2" } }),
          f("/v1/matches", { method: "HEAD" }),
        ];
        for (const res of await Promise.all(attempts)) expect(res.status).toBe(429);
      });
    });

    it("signed-in users have their own budget, shared across all of their sessions", async () => {
      const u = await t.newUser("ratelimit"); // created before the budget is reset, so it does not count
      await withApp({ THROTTLE_USER_PER_MIN: "6", THROTTLE_IP_PER_MIN: "1000" }, async (f) => {
        const second = t.signSessionToken(u.clerkId, { sid: "sess_second_device" });
        const statuses = [];
        for (let i = 0; i < 4; i++) statuses.push((await f("/v1/me", { headers: { authorization: `Bearer ${u.token}` } })).status);
        for (let i = 0; i < 4; i++) statuses.push((await f("/v1/me", { headers: { authorization: `Bearer ${second}` } })).status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(6);
        expect(statuses.filter((s) => s === 429)).toHaveLength(2);
      });
    });

    it("forged Authorization headers do not escape limiting (backstop, invalid-token path)", async () => {
      await withApp({ THROTTLE_IP_BACKSTOP_PER_MIN: "15", THROTTLE_IP_PER_MIN: "1000" }, async (f) => {
        const statuses = [];
        for (let i = 0; i < 18; i++) statuses.push((await f("/", { headers: { authorization: `Bearer junk-${i}` } })).status);
        expect(statuses.includes(429)).toBe(true);
      });
      await withApp({ THROTTLE_IP_PER_MIN: "5" }, async (f) => {
        const statuses = [];
        for (let i = 0; i < 8; i++) statuses.push((await f("/v1/competitions", { headers: { authorization: `Bearer junk-${i}` } })).status);
        expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
        expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
      });
    });

    it("REGRESSION F-07: sensitive routes keep their tight limits without Redis", async () => {
      const u = await t.newUser("strict");
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await t.call("POST", `/v1/matches/${t.matchIds["3869685"]}/analysis-jobs`, { token: u.token })).status);
      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    });

    it("REGRESSION F-07: a failing Redis falls back to in-memory limits instead of letting traffic through", async () => {
      // Every Redis command fails, like an unreachable Upstash. ("then" stays undefined: the client is not a promise.)
      const failing = new Proxy(
        {},
        {
          get: (_, prop) =>
            prop === "then"
              ? undefined
              : prop === "addTelemetry"
                ? () => {}
                : async () => {
                    throw new Error("UPSTASH_UNREACHABLE");
                  },
        },
      );
      setRedisClientForTests(failing);
      try {
        await withApp({ THROTTLE_IP_PER_MIN: "3" }, async (f) => {
          const statuses = [];
          for (let i = 0; i < 5; i++) statuses.push((await f("/v1/competitions")).status);
          expect(statuses).toEqual([200, 200, 200, 429, 429]);
        });
      } finally {
        setRedisClientForTests(null);
      }
    });
  });
});
