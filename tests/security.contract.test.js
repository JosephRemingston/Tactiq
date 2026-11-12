// API contract: every registered route is in the test catalogue, and every catalogued route answers a valid request
// with its documented status and the standard envelope. Security changes must not silently break API consumers.
import { SKIP, startTestApp, routeIds } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { routes, REGISTERED_ROUTE_COUNT } from "./support/routes.js";

describe("API contract", { skip: SKIP ?? false }, () => {
  let t;
  let u;
  let ids;
  let pro;

  before(async () => {
    t = await startTestApp();
    u = await t.newUser("contract");
    ids = await routeIds(t, u);
    pro = await t.newUser("contractpro");
    await t.call("POST", "/v1/billing/google-play/verify", { token: pro.token, body: { productId: "pro_monthly", purchaseToken: `fake:pro_monthly:active:30::contract${Date.now()}` } });
  });
  after(async () => t?.close());

  it("the catalogue covers every route registered in the app", async () => {
    const { createApp } = await import("../app.js");
    const app = createApp();
    const seen = new Set();
    const routers = new Set();
    let count = 0;
    const walk = (stack) => {
      for (const layer of stack) {
        if (layer.route) {
          count += Object.keys(layer.route.methods).filter((m) => m !== "_all").length;
        } else if (layer.handle?.stack && !routers.has(layer.handle)) {
          routers.add(layer.handle); // the webhook router is mounted at two prefixes; count it once
          walk(layer.handle.stack);
        }
      }
    };
    walk(app.router.stack);
    expect(count).toBe(REGISTERED_ROUTE_COUNT);
    const catalogued = routes(ids).filter((r) => r.path !== "/webhooks/clerk");
    for (const r of catalogued) seen.add(`${r.method} ${r.path}`);
    expect(seen.size).toBe(REGISTERED_ROUTE_COUNT);
  });

  it("every route answers a valid request with the expected status and the standard envelope", async () => {
    const expected = {
      "GET /v1/me/sessions": 503, // needs CLERK_SECRET_KEY, deliberately absent in tests
      "DELETE /v1/me/sessions/sess_unknown": 503,
      "POST /v1/billing/google-play/verify": 400, // the catalogue's token is not a real store token
      "POST /v1/me/notes": 201,
      "POST /v1/me/collections": 201,
      [`POST /v1/matches/${ids.match}/analysis-jobs`]: 202,
      [`DELETE /v1/me/notes/${ids.uuid}`]: 404,
      [`DELETE /v1/me/collections/${ids.uuid}`]: 404,
    };
    for (const r of routes(ids)) {
      if (r.access === "webhook" || r.destructive) continue;
      const key = `${r.method} ${r.path}`;
      const token = r.access === "public" || r.access === "health" ? undefined : r.access === "metered" ? pro.token : u.token;
      const res = await t.call(r.method, r.path, { token, body: r.body });
      const want = expected[key] ?? 200;
      if (res.status !== want) throw new Error(`${key}: expected ${want}, got ${res.status} ${res.text.slice(0, 200)}`);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(Object.keys(res.body).sort()).toEqual(["data", "message", "statusCode"]);
      expect(res.body.statusCode).toBe(res.status);
      expect(typeof res.body.message).toBe("string");
      expect(typeof res.body.data === "object" && res.body.data !== null && !Array.isArray(res.body.data)).toBe(true);
      if (r.list) expect(Array.isArray(res.body.data[r.list])).toBe(true);
      if (r.paged && res.status === 200) expect(Object.keys(res.body.data.page).sort()).toEqual(["limit", "nextCursor"]);
    }
  });

  it("pagination walks a full list without gaps or repeats", async () => {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await t.get(`/v1/teams?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.teams.map((x) => x.id));
      cursor = res.body.data.page.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    const all = (await t.get("/v1/teams?limit=100")).body.data.teams.map((x) => x.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("deleting the account works through the API and is final", async () => {
    const victim = await t.newUser("contractdelete");
    expect((await t.call("DELETE", "/v1/me", { token: victim.token })).status).toBe(200);
    expect((await t.get("/v1/me", { token: victim.token })).status).toBe(401);
  });
});
