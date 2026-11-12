// Clerk admin calls (sessions, profile, deletion) against a mocked Clerk API: the real SDK runs, only the network is
// replaced. Covers the rule that a user can only ever revoke their own sessions.
import "./support/unitEnv.js";
import { describe, it, before, expect } from "./support/expect.js";

const calls = [];
let deleteStatus = 200;
const session = (id, user) => ({ object: "session", id, user_id: user, client_id: "client_1", status: "active", last_active_at: 1_700_000_000_000, expire_at: 1_800_000_000_000, abandon_at: 1_800_000_000_000, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Clerk session management", () => {
  let clerk;
  before(async () => {
    process.env.CLERK_SECRET_KEY = `sk_test_${"x".repeat(40)}`;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      calls.push(`${init.method ?? "GET"} ${u.pathname}`);
      if (u.hostname !== "api.clerk.com") throw new Error(`unexpected host ${u.hostname}`);
      if (u.pathname === "/v1/sessions") return json({ data: [session(`sess_of_${u.searchParams.get("user_id")}`, u.searchParams.get("user_id"))], total_count: 1 });
      if (u.pathname.endsWith("/revoke")) return json(session(u.pathname.split("/")[3], "x"));
      if (u.pathname.startsWith("/v1/users/") && (init.method ?? "GET") === "DELETE") return deleteStatus === 200 ? json({ deleted: true }) : json({ errors: [{ code: "resource_not_found" }] }, deleteStatus);
      if (u.pathname.startsWith("/v1/users/")) {
        return json({
          object: "user",
          id: u.pathname.split("/")[3],
          first_name: "Ada",
          last_name: "Fan",
          primary_email_address_id: "e1",
          email_addresses: [{ id: "e1", email_address: "ada@example.com", verification: { status: "verified" }, linked_to: [] }],
          phone_numbers: [],
          web3_wallets: [],
          external_accounts: [],
          saml_accounts: [],
          enterprise_accounts: [],
          passkeys: [],
          public_metadata: {},
          private_metadata: {},
          unsafe_metadata: {},
        });
      }
      return json({}, 404);
    };
    clerk = await import("../configs/clerk.js");
  });

  it("lists only the caller's sessions, with timestamps normalised", async () => {
    const list = await clerk.listSessions("user_a");
    expect(list).toEqual([{ id: "sess_of_user_a", status: "active", lastActiveAt: "2023-11-14T22:13:20.000Z", expireAt: "2027-01-15T08:00:00.000Z", clientId: "client_1" }]);
  });

  it("revokes the caller's own session", async () => {
    calls.length = 0;
    expect(await clerk.revokeSession("user_a", "sess_of_user_a")).toBe(true);
    expect(calls).toContain("POST /v1/sessions/sess_of_user_a/revoke");
  });

  it("never revokes another user's session: Clerk's revoke endpoint is not even called", async () => {
    calls.length = 0;
    expect(await clerk.revokeSession("user_a", "sess_of_user_b")).toBe(false);
    expect(calls.some((c) => c.endsWith("/revoke"))).toBe(false);
  });

  it("deleting a user that Clerk already removed is treated as done; other failures propagate", async () => {
    deleteStatus = 404;
    await clerk.deleteUser("user_gone");
    deleteStatus = 500;
    let err;
    try {
      await clerk.deleteUser("user_err");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    deleteStatus = 200;
  });

  it("maps the Clerk profile through the same verified-email rules as webhooks", async () => {
    expect(await clerk.getProfile("user_p")).toMatchObject({ clerkUserId: "user_p", email: "ada@example.com", displayName: "Ada Fan" });
  });
});
