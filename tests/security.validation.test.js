// Input validation, injection and fuzzing over HTTP: hostile input must produce 2xx or 4xx, never 500, never
// change data it should not, and be stored or echoed literally (JSON), never interpreted.
import { SKIP, startTestApp, routeIds } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { routes } from "./support/routes.js";
import { rng, randomString, NASTY_STRINGS } from "./support/random.js";

describe("input validation, injection and fuzzing", { skip: SKIP ?? false }, () => {
  let t;
  let u;
  let ids;
  let errors;
  let restoreConsole;

  before(async () => {
    t = await startTestApp();
    u = await t.newUser("fuzz");
    ids = await routeIds(t, u);
    errors = [];
    const orig = console.error;
    console.error = (...a) => {
      errors.push(a.join(" "));
    };
    restoreConsole = () => (console.error = orig);
  });
  after(async () => {
    restoreConsole?.();
    await t?.close();
  });

  const no500 = (res, label) => {
    if (res.status >= 500) throw new Error(`${label} -> ${res.status} ${res.text.slice(0, 200)}`);
  };
  const tablesIntact = async () => {
    const { rows } = await t.db.execute(t.sql`select (select count(*)::int from users) as users, (select count(*)::int from events) as events, (select count(*)::int from purchases) as purchases`);
    expect(rows[0].users).toBeGreaterThan(0);
    expect(rows[0].events).toBeGreaterThan(1000);
    return rows[0];
  };

  it("SQL injection payloads in every free-text parameter are inert", async () => {
    const before = await tablesIntact();
    const payloads = ["' OR 1=1--", "1'; DROP TABLE users;--", "%' UNION SELECT email, clerk_user_id, null FROM users--", "'||(select pg_sleep(2))||'", "$$; select pg_sleep(2); $$", "\\'; select 1; --"];
    for (const p of payloads) {
      const e = encodeURIComponent(p);
      for (const path of [`/v1/search?q=${e}`, `/v1/teams?q=${e}`, `/v1/competitions?q=${e}`, `/v1/concepts?category=${e}`, `/v1/metric-definitions?family=${e}`]) {
        const started = Date.now();
        const res = await t.get(path, { token: u.token });
        no500(res, path);
        expect(Date.now() - started).toBeLessThan(1500); // no pg_sleep executed
        expect(JSON.stringify(res.body)).not.toContain("@example.com");
      }
      const note = await t.call("POST", "/v1/me/notes", { token: u.token, body: { subjectType: "match", subjectId: ids.match, body: p } });
      expect(note.status).toBe(201);
      expect(note.body.data.note.body).toBe(p);
      const coll = await t.call("POST", "/v1/me/collections", { token: u.token, body: { name: p.slice(0, 80), description: p } });
      expect(coll.status).toBe(201);
    }
    const afterRows = await tablesIntact();
    expect(afterRows.events).toBe(before.events);
  });

  it("injection through path ids, enums and sort-like parameters is rejected by validation", async () => {
    for (const path of [
      `/v1/matches/${encodeURIComponent("1 OR 1=1")}`,
      `/v1/matches/${ids.match}'--/events`,
      `/v1/teams/${encodeURIComponent("x'; drop table teams;--")}`,
      `/v1/matches?status=${encodeURIComponent("played' or '1'='1")}`,
      `/v1/matches/${ids.match}/insights?depth=${encodeURIComponent("quick;drop")}`,
      `/v1/concepts/${encodeURIComponent("ppda' or 1=1")}`,
      `/v1/matches/${ids.match}/events?type=${encodeURIComponent("shot') or ('1'='1")}`,
      `/v1/me/following/${encodeURIComponent("teams; drop")}/${ids.team}`,
      `/v1/matches?orderBy=${encodeURIComponent("email desc")}&sort=email`,
    ]) {
      const res = await t.get(path, { token: u.token });
      no500(res, path);
      expect([200, 400, 403, 404]).toContain(res.status);
    }
  });

  it("LIKE wildcards in search are literal: '%%' does not match every team", async () => {
    const all = (await t.get("/v1/teams?limit=100")).body.data.teams.length;
    expect(all).toBeGreaterThan(5);
    expect((await t.get(`/v1/teams?q=${encodeURIComponent("%")}`)).body.data.teams).toEqual([]);
    expect((await t.get(`/v1/teams?q=${encodeURIComponent("_")}`)).body.data.teams).toEqual([]);
    expect((await t.get(`/v1/search?q=${encodeURIComponent("%%")}&types=team`)).body.data.teams).toEqual([]);
  });

  it("markup and script payloads are stored and returned verbatim as JSON, never as HTML", async () => {
    for (const p of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "javascript:alert(1)", "\"><svg/onload=alert(1)>"]) {
      const res = await t.call("POST", "/v1/me/notes", { token: u.token, body: { subjectType: "match", subjectId: ids.match, body: p } });
      expect(res.status).toBe(201);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const back = await t.get(`/v1/me/notes/${res.body.data.note.id}`, { token: u.token });
      expect(back.body.data.note.body).toBe(p);
    }
  });

  it("REGRESSION F-05: NUL bytes anywhere are a 400, not a database error", async () => {
    const cases = [
      ["POST", "/v1/me/notes", { subjectType: "match", subjectId: ids.match, body: "a\u0000b" }],
      ["POST", "/v1/me/collections", { name: "x\u0000" }],
      ["PATCH", "/v1/me", { displayName: "\u0000" }],
      ["GET", "/v1/search?q=ab%00cd"],
      ["GET", "/v1/teams?q=%00"],
      ["GET", "/v1/concepts/pp%00da"],
    ];
    for (const [method, path, body] of cases) {
      const res = await t.call(method, path, { token: u.token, body });
      expect(res.status).toBe(400);
    }
  });

  it("REGRESSION F-05: impossible dates and tampered cursors on every paginated route are a 400", async () => {
    for (const d of ["2022-13-45", "2022-02-30T00:00:00Z", "2023-02-29", "9999-99-99", "2022-01-01T99:99:99Z", "0000-00-00", "2022-1-1"]) {
      const res = await t.get(`/v1/matches?from=${encodeURIComponent(d)}`);
      expect(res.status).toBe(400);
    }
    expect((await t.get(`/v1/matches?from=2024-02-29&to=2024-12-31T23:59:59Z`)).status).toBe(200); // leap day is fine
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const badCursors = ["!!!", b64(["x", "y"]), b64([1.5, ids.uuid]), b64(["2022-13-45", ids.uuid]), b64([-1, ids.uuid]), b64([1e400, "x"]), b64([{ a: 1 }, ids.uuid]), b64([1, 2, 3]), b64(null)];
    const paged = routes(ids).filter((r) => r.paged);
    expect(paged.length).toBe(8);
    for (const r of paged) {
      for (const c of badCursors) {
        // The teams cursor sorts by name, so a date-looking string is a legitimate first element there.
        if (r.path.startsWith("/v1/teams?") || r.path === "/v1/teams") {
          if (c === b64(["2022-13-45", ids.uuid])) continue;
        }
        const sep = r.path.includes("?") ? "&" : "?";
        const token = r.access === "public" ? undefined : u.token;
        const proToken = r.path.includes("/possessions") ? u.token : token;
        const res = await t.get(`${r.path}${sep}cursor=${encodeURIComponent(c)}`, { token: proToken });
        no500(res, `${r.path} cursor ${c}`);
        expect(res.status).toBe(400);
      }
    }
  });

  it("numeric parameters reject zero, negatives, fractions, overflow, NaN and Infinity", async () => {
    for (const v of ["0", "-1", "1.5", "1e3", "101", "NaN", "Infinity", "-Infinity", "9007199254740993", "0x10", "", "abc"]) {
      const res = await t.get(`/v1/teams?limit=${encodeURIComponent(v)}`);
      expect(res.status).toBe(400);
    }
    expect((await t.get("/v1/teams?limit=100")).status).toBe(200);
    expect((await t.get(`/v1/matches/${ids.match}/events?limit=500`)).status).toBe(200);
    expect((await t.get(`/v1/matches/${ids.match}/events?limit=501`)).status).toBe(400);
    // Repeated parameters arrive as arrays and are rejected, not concatenated.
    expect((await t.get("/v1/teams?limit=1&limit=2")).status).toBe(400);
  });

  it("every :id route rejects malformed ids", async () => {
    const withIds = routes(ids).filter((r) => r.idParam);
    expect(withIds.length).toBeGreaterThan(10);
    for (const r of withIds) {
      for (const bad of ["1", "not-a-uuid", "00000000-0000-0000-0000-00000000000g", `${ids.uuid}x`, "..%2F..%2Fetc%2Fpasswd"]) {
        const path = r.idParam.replace(":id", bad);
        const res = await t.get(path, { token: u.token });
        no500(res, path);
        expect([400, 404]).toContain(res.status);
      }
    }
  });

  it("request bodies: wrong types, nulls, empties, unknown fields and oversize are rejected", async () => {
    const base = { subjectType: "match", subjectId: ids.match, body: "ok" };
    for (const body of [
      { ...base, body: "" },
      { ...base, body: "   " },
      { ...base, body: null },
      { ...base, body: 42 },
      { ...base, body: ["x"] },
      { ...base, body: { $gt: "" } },
      { ...base, body: "x".repeat(4001) },
      { ...base, subjectType: "user" },
      { ...base, subjectId: "x" },
      { ...base, extra: 1 },
      [],
      "string",
      null,
    ]) {
      const res = await t.call("POST", "/v1/me/notes", { token: u.token, body: typeof body === "string" ? JSON.stringify(body) : body, headers: { "content-type": "application/json" }, raw: typeof body === "string" });
      expect(res.status).toBe(400);
    }
    expect((await t.call("POST", "/v1/me/notes", { token: u.token, body: { ...base, body: "x".repeat(4000) } })).status).toBe(201);
    const big = JSON.stringify({ ...base, body: "x".repeat(300_000) });
    expect((await t.call("POST", "/v1/me/notes", { token: u.token, body: big, headers: { "content-type": "application/json" }, raw: true })).status).toBe(413);
    expect((await t.call("POST", "/v1/me/notes", { token: u.token, body: '{"subjectType": "match",', headers: { "content-type": "application/json" }, raw: true })).status).toBe(400);
    expect((await t.call("POST", "/v1/me/notes", { token: u.token, body: "subjectType=match&body=x", headers: { "content-type": "application/x-www-form-urlencoded" }, raw: true })).status).toBe(400);
  });

  it("prototype pollution attempts are rejected and do not pollute the server", async () => {
    for (const raw of ['{"__proto__":{"polluted":true},"displayName":"x"}', '{"constructor":{"prototype":{"polluted":true}}}', '{"displayName":"x","__proto__":{"isAdmin":true}}']) {
      const res = await t.call("PATCH", "/v1/me", { token: u.token, body: raw, headers: { "content-type": "application/json" }, raw: true });
      expect(res.status).toBe(400);
    }
    expect({}.polluted).toBe(undefined);
    expect({}.isAdmin).toBe(undefined);
  });

  it("deeply nested JSON is rejected without exhausting the stack", async () => {
    const deep = `{"displayName":"x","n":${"[".repeat(50_000)}${"]".repeat(50_000)}}`;
    const res = await t.call("PATCH", "/v1/me", { token: u.token, body: deep, headers: { "content-type": "application/json" }, raw: true });
    expect(res.status).toBe(400);
  });

  it("CRLF in parameters never reaches response headers", async () => {
    const res = await t.get(`/v1/teams?q=${encodeURIComponent("x\r\nSet-Cookie: pwned=1")}`);
    no500(res, "crlf");
    expect(res.headers.get("set-cookie")).toBe(null);
  });

  it("fuzz: seeded random and hostile strings into every text input never cause a 500", async () => {
    const r = rng();
    const inputs = [...NASTY_STRINGS, ...Array.from({ length: 150 }, () => randomString(r, 120))];
    for (const s of inputs) {
      const e = encodeURIComponent(s);
      for (const path of [`/v1/search?q=${e}`, `/v1/teams?q=${e}`, `/v1/competitions?q=${e}`, `/v1/matches?from=${e}`, `/v1/concepts/${e || "x"}`, `/v1/metric-definitions/${e || "x"}`]) {
        no500(await t.get(path), path);
      }
      const note = await t.call("POST", "/v1/me/notes", { token: u.token, body: { subjectType: "match", subjectId: ids.match, body: s } });
      no500(note, "note");
      if (note.status === 201) expect(note.body.data.note.body).toBe(s.trim());
      no500(await t.call("PATCH", "/v1/me", { token: u.token, body: { displayName: s } }), "displayName");
    }
    await tablesIntact();
  });

  it("no request in this suite produced an unhandled server error or leaked request data to the log", () => {
    const unhandled = errors.filter((e) => e.includes("unhandled error"));
    expect(unhandled).toEqual([]);
    expect(errors.join("\n")).not.toContain("DROP TABLE");
  });
});
