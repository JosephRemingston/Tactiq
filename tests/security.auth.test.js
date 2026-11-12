// Authentication: every route in the catalogue, against every kind of missing, broken or forged credential,
// through the real Express app and the real Clerk verifier.
import { SKIP, startTestApp, routeIds } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { routes } from "./support/routes.js";
import { generateKeyPairSync, sign as rsaSign, createHmac } from "node:crypto";
import { TEST_AUTHORIZED_PARTY, TEST_JWT_PUBLIC_KEY } from "./support/tokens.js";

describe("authentication", { skip: SKIP ?? false }, () => {
  let t;
  let ids;
  let owner;

  before(async () => {
    t = await startTestApp();
    owner = await t.newUser("authowner");
    ids = await routeIds(t, owner);
  });
  after(async () => t?.close());

  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const claims = (extra = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { sub: "user_forged", sid: "sess_forged", azp: TEST_AUTHORIZED_PARTY, iat: now, nbf: now - 5, exp: now + 600, ...extra };
  };

  /** Credentials that must never authenticate anyone. */
  function badCredentials() {
    const good = t.signSessionToken(owner.clerkId);
    const [h, , s] = good.split(".");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherInput = `${b64({ alg: "RS256", typ: "JWT", kid: "ins_test" })}.${b64(claims({ sub: owner.clerkId }))}`;
    const hsInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims({ sub: owner.clerkId }))}`;
    return {
      "empty header": { authorization: "" },
      "scheme only": { authorization: "Bearer" },
      "basic auth": { authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}` },
      "random token": { authorization: "Bearer 4f9c2b7e1a" },
      "malformed jwt": { authorization: "Bearer a.b.c" },
      expired: { authorization: `Bearer ${t.signSessionToken(owner.clerkId, { expiresInSec: -60 })}` },
      "not yet valid": { authorization: `Bearer ${h}.${b64(claims({ sub: owner.clerkId, nbf: Math.floor(Date.now() / 1000) + 3600 }))}.${s}` },
      "tampered payload (sub swapped)": { authorization: `Bearer ${h}.${b64(claims({ sub: owner.clerkId }))}.${s}` },
      "alg none": { authorization: `Bearer ${b64({ alg: "none", typ: "JWT" })}.${b64(claims({ sub: owner.clerkId }))}.` },
      "HS256 with public key (alg confusion)": {
        authorization: `Bearer ${hsInput}.${createHmac("sha256", TEST_JWT_PUBLIC_KEY).update(hsInput).digest("base64url")}`,
      },
      "signed by another key": { authorization: `Bearer ${otherInput}.${rsaSign("RSA-SHA256", Buffer.from(otherInput), other.privateKey).toString("base64url")}` },
      "wrong authorized party": { authorization: `Bearer ${t.signSessionToken(owner.clerkId, { azp: "https://evil.example" })}` },
      "pending session": { authorization: `Bearer ${t.signSessionToken(owner.clerkId, { sts: "pending" })}` },
    };
  }

  it("every private route answers 401 without a token, and never leaks data in the response", async () => {
    for (const r of routes(ids).filter((x) => x.access === "user" || x.access === "metered")) {
      const res = await t.call(r.method, r.path, { body: r.body });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, data: { code: "UNAUTHENTICATED" } });
      expect(Object.keys(res.body.data).sort()).toEqual(["code", "requestId"]);
    }
  });

  it("every route, public or private, rejects every forged or broken credential with 401", async () => {
    const creds = badCredentials();
    for (const r of routes(ids).filter((x) => ["user", "metered", "public"].includes(x.access) && x.path !== "/")) {
      for (const [name, headers] of Object.entries(creds)) {
        // An empty header or a bare scheme carries no token: public routes treat it as anonymous.
        const anonymousOk = r.access === "public" && (name === "empty header" || name === "scheme only" || name === "basic auth");
        const res = await t.call(r.method, r.path, { body: r.body, headers });
        if (anonymousOk) expect(res.status).not.toBe(401);
        else if (res.status !== 401) throw new Error(`${r.method} ${r.path} with ${name} returned ${res.status}`);
      }
    }
  });

  it("a valid token for the owner works on private routes", async () => {
    const res = await t.get("/v1/me", { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(owner.id);
  });

  it("a native-app token (no azp claim) is accepted even when authorized parties are set", async () => {
    // Clerk adds azp only for requests with an Origin header, so the mobile app's tokens never have one.
    const res = await t.get("/v1/me", { token: t.signSessionToken(owner.clerkId, { azp: null }) });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(owner.id);
  });

  it("identity comes only from the token: user ids in headers, query or body are ignored or rejected", async () => {
    const other = await t.newUser("authother");
    const viaQuery = await t.get(`/v1/me?userId=${owner.id}`, { token: other.token });
    expect(viaQuery.body.data.user.id).toBe(other.id);
    const viaHeader = await t.get("/v1/me", { token: other.token, headers: { "x-user-id": owner.id, "x-clerk-user-id": owner.clerkId } });
    expect(viaHeader.body.data.user.id).toBe(other.id);
    const viaBody = await t.call("PATCH", "/v1/me", { token: other.token, body: { id: owner.id, displayName: "x" } });
    expect(viaBody.status).toBe(400);
    const notes = await t.get("/v1/me/notes", { token: other.token, headers: { "x-user-id": owner.id } });
    expect(notes.body.data.notes).toEqual([]);
  });

  it("a deleted account's still-valid token is refused everywhere, including public routes", async () => {
    const gone = await t.newUser("authgone");
    expect((await t.call("DELETE", "/v1/me", { token: gone.token })).status).toBe(200);
    for (const path of ["/v1/me", "/v1/me/notes", "/v1/entitlements", "/v1/competitions", "/v1/ads/config"]) {
      const res = await t.get(path, { token: gone.token });
      expect(res.status).toBe(401);
    }
    // The deleted account is not silently re-created by the next request.
    const { rows } = await t.db.execute(t.sql`select count(*)::int as n, min(status) as status from users where clerk_user_id = ${gone.clerkId}`);
    expect(rows[0]).toEqual({ n: 1, status: "deleted" });
  });

  it("concurrent first requests for a new identity create exactly one account and one free plan", async () => {
    const clerkId = `user_race_${Date.now()}`;
    const token = t.signSessionToken(clerkId);
    const results = await Promise.all(Array.from({ length: 8 }, () => t.get("/v1/me", { token })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.user.id)).size).toBe(1);
    const id = results[0].body.data.user.id;
    const { rows } = await t.db.execute(t.sql`
      select (select count(*)::int from users where clerk_user_id = ${clerkId}) as users,
             (select count(*)::int from security_events where kind = 'user_created' and user_id = ${id}) as created,
             (select count(*)::int from entitlements where user_id = ${id} and feature_key = 'analysis.matches_per_month') as grants`);
    expect(rows[0]).toEqual({ users: 1, created: 1, grants: 1 });
  });

  it("account enumeration: an unknown and a deleted account look the same to an anonymous caller", async () => {
    const unknown = await t.get(`/v1/me/notes/${ids.uuid}`);
    const deletedish = await t.get(`/v1/me/notes/${ids.note}`);
    expect(unknown.status).toBe(401);
    expect(deletedish.status).toBe(401);
    expect(unknown.body.message).toBe(deletedish.body.message);
  });
});
