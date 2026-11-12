// Clerk webhooks: signatures, tampering, replay, timestamps, malformed payloads, ordering after deletion,
// concurrency and flood limits. Signatures are real Svix (Standard Webhooks) HMACs.
import { SKIP, startTestApp } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { createHmac, randomBytes } from "node:crypto";
import { TEST_WEBHOOK_SECRET } from "./support/tokens.js";

describe("Clerk webhooks", { skip: SKIP ?? false }, () => {
  let t;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => t?.close());

  const event = (type, data) => JSON.stringify({ type, object: "event", data });
  const userData = (id, extra = {}) => ({
    id,
    first_name: "Ada",
    last_name: "Fan",
    primary_email_address_id: "e1",
    email_addresses: [{ id: "e1", email_address: `${id}@example.com`, verification: { status: "verified" } }],
    ...extra,
  });
  const signAt = (body, timestamp, secret = TEST_WEBHOOK_SECRET, id = `msg_${randomBytes(8).toString("hex")}`) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64"); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": `v1,${sig}`, "content-type": "application/json" };
  };
  const post = (body, headers) => t.call("POST", "/v1/webhooks/clerk", { body, headers, raw: true });
  const userRow = async (clerkId) => (await t.db.execute(t.sql`select status, email, display_name from users where clerk_user_id = ${clerkId}`)).rows[0];
  const rejected = async () => (await t.db.execute(t.sql`select count(*)::int as n from security_events where kind = 'webhook_rejected'`)).rows[0].n;

  it("a correctly signed user.created creates the account with verified data only", async () => {
    const id = `user_wh_${randomBytes(6).toString("hex")}`;
    const body = event("user.created", userData(id));
    expect((await post(body, t.signWebhook(body))).status).toBe(200);
    expect(await userRow(id)).toEqual({ status: "active", email: `${id}@example.com`, display_name: "Ada Fan" });
  });

  it("missing, forged, re-signed or tampered deliveries are rejected before anything is processed", async () => {
    const id = `user_forge_${randomBytes(6).toString("hex")}`;
    const body = event("user.created", userData(id));
    const now = Math.floor(Date.now() / 1000);
    const good = t.signWebhook(body);
    const cases = {
      "no headers": { "content-type": "application/json" },
      "no signature": { ...good, "svix-signature": undefined },
      "garbage signature": { ...good, "svix-signature": "v1,AAAA" },
      "other secret": signAt(body, now, `whsec_${randomBytes(24).toString("base64")}`),
      "missing id": { ...good, "svix-id": undefined },
      "different id than signed": { ...good, "svix-id": "msg_other" },
      "stale timestamp (10 min)": signAt(body, now - 600),
      "future timestamp (10 min)": signAt(body, now + 600),
    };
    const before = await rejected();
    for (const [name, headers] of Object.entries(cases)) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
      const res = await post(body, clean);
      if (res.status !== 401) throw new Error(`${name}: expected 401, got ${res.status}`);
    }
    // Body changed after signing: an attacker swaps the user id.
    const tampered = body.replace(id, "user_victim");
    expect((await post(tampered, good)).status).toBe(401);
    expect(await userRow(id)).toBe(undefined);
    expect(await userRow("user_victim")).toBe(undefined);
    expect((await rejected()) - before).toBe(Object.keys(cases).length + 1);
  });

  it("a replayed delivery is acknowledged but processed only once", async () => {
    const id = `user_replay_${randomBytes(6).toString("hex")}`;
    const body = event("user.created", userData(id));
    const headers = t.signWebhook(body);
    expect((await post(body, headers)).body.data.duplicate).toBe(undefined);
    expect((await post(body, headers)).body.data.duplicate).toBe(true);
    const received = (await t.db.execute(t.sql`select count(*)::int as n from security_events where kind = 'webhook_received' and metadata->>'deliveryId' = ${headers["svix-id"]}`)).rows[0].n;
    expect(received).toBe(1);
  });

  it("concurrent deliveries of the same event leave one consistent account", async () => {
    const id = `user_conc_${randomBytes(6).toString("hex")}`;
    const body = event("user.created", userData(id));
    const headers = t.signWebhook(body);
    const res = await Promise.all(Array.from({ length: 6 }, () => post(body, headers)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const { rows } = await t.db.execute(t.sql`select count(*)::int as n from users where clerk_user_id = ${id}`);
    expect(rows[0].n).toBe(1);
  });

  it("REGRESSION F-03: a late or replayed user.updated cannot restore a deleted account's personal data", async () => {
    const u = await t.newUser("whdel");
    const created = event("user.created", userData(u.clerkId));
    await post(created, t.signWebhook(created));
    expect((await t.call("DELETE", "/v1/me", { token: u.token })).status).toBe(200);
    expect(await userRow(u.clerkId)).toEqual({ status: "deleted", email: null, display_name: null });

    for (const type of ["user.updated", "user.created"]) {
      const late = event(type, userData(u.clerkId, { first_name: "Resurrected", email_addresses: [{ id: "e1", email_address: "back@example.com" }] }));
      expect((await post(late, t.signWebhook(late))).status).toBe(200);
    }
    expect(await userRow(u.clerkId)).toEqual({ status: "deleted", email: null, display_name: null });
    const identities = (await t.db.execute(t.sql`select count(*)::int as n from user_identities i join users u on u.id = i.user_id where u.clerk_user_id = ${u.clerkId}`)).rows[0].n;
    expect(identities).toBe(0);
    expect((await t.get("/v1/me", { token: u.token })).status).toBe(401);
  });

  it("user.deleted removes private data and is idempotent", async () => {
    const u = await t.newUser("whremove");
    await t.call("POST", "/v1/me/notes", { token: u.token, body: { subjectType: "match", subjectId: t.matchIds["3869685"], body: "x" } });
    const body = event("user.deleted", { id: u.clerkId, deleted: true });
    expect((await post(body, t.signWebhook(body))).status).toBe(200);
    const again = event("user.deleted", { id: u.clerkId, deleted: true });
    expect((await post(again, t.signWebhook(again))).status).toBe(200);
    const { rows } = await t.db.execute(t.sql`select status, (select count(*)::int from user_notes where owner_user_id = ${u.id}) as notes from users where id = ${u.id}`);
    expect(rows[0]).toEqual({ status: "deleted", notes: 0 });
  });

  it("unknown event types and payloads with no user id are acknowledged and ignored", async () => {
    for (const body of [event("session.created", { id: "sess_1" }), event("user.updated", {}), event("organization.created", { id: "org_1" })]) {
      expect((await post(body, t.signWebhook(body))).status).toBe(200);
    }
  });

  it("malformed and oversized bodies fail cleanly without a 500", async () => {
    for (const body of ["", "not json", "{", "[]", "null"]) {
      const res = await post(body, t.signWebhook(body));
      expect([400, 401]).toContain(res.status);
    }
    const huge = event("user.created", userData("user_huge", { first_name: "a".repeat(1_200_000) }));
    expect((await post(huge, t.signWebhook(huge))).status).toBe(413);
  });

  it("forged deliveries are capped per IP (each one costs a security-log row)", async () => {
    const before = await rejected();
    const results = [];
    for (let i = 0; i < 330; i += 30) {
      results.push(...(await Promise.all(Array.from({ length: 30 }, () => post("{}", { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,AAA" })))));
    }
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect((await rejected()) - before).toBeLessThanOrEqual(300);
  });
});
