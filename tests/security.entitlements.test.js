// Paywall and usage accounting: every gated feature against Free and Pro, charging rules, refunds, monthly
// boundaries, concurrency at the limit, plan changes and cache invalidation.
import { SKIP, startTestApp, periodKey } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";

describe("entitlements and paywall", { skip: SKIP ?? false }, () => {
  let t;
  let m1;
  let m2;
  let unanalysed;

  before(async () => {
    t = await startTestApp();
    m1 = t.matchIds["3869685"];
    m2 = t.matchIds["8658"];
    unanalysed = (await t.db.execute(t.sql`select id from matches where analysis_status <> 'complete' limit 1`)).rows[0].id;
  });
  after(async () => t?.close());

  const pro = async (u) => {
    const tk = `fake:pro_monthly:active:30::${randomBytes(6).toString("hex")}`;
    const r = await t.call("POST", "/v1/billing/google-play/verify", { token: u.token, body: { productId: "pro_monthly", purchaseToken: tk } });
    expect(r.status).toBe(200);
    return tk;
  };
  const used = async (u, feature = "analysis.matches_per_month") =>
    (await t.get("/v1/entitlements", { token: u.token })).body.data.entitlements.find((e) => e.featureKey === feature).used;
  const setUsed = (u, feature, n) =>
    t.db.execute(t.sql`insert into entitlement_usage (user_id, feature_key, period_key, used) values (${u.id}, ${feature}, ${periodKey()}, ${n})
                       on conflict (user_id, feature_key, period_key) do update set used = ${n}`);

  const METERED = (m) => [`/v1/matches/${m}/metrics`, `/v1/matches/${m}/tactical-shape`, `/v1/matches/${m}/pressing`, `/v1/matches/${m}/transitions`, `/v1/matches/${m}/possessions`];

  it("Free: one match costs one unit no matter how many views are opened; a second match costs a second unit", async () => {
    const u = await t.newUser("meter");
    for (const p of METERED(m1)) {
      const r = await t.get(p, { token: u.token });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-entitlement-remaining")).toBe("19");
    }
    expect(await used(u)).toBe(1);
    expect((await t.get(METERED(m2)[0], { token: u.token })).headers.get("x-entitlement-remaining")).toBe("18");
    // Replaying a request never charges twice.
    for (let i = 0; i < 5; i++) await t.get(METERED(m1)[2], { token: u.token });
    expect(await used(u)).toBe(2);
  });

  it("Free: the limit is enforced server-side with paywall details; opened matches stay open", async () => {
    const u = await t.newUser("limit");
    await t.get(METERED(m1)[0], { token: u.token });
    await setUsed(u, "analysis.matches_per_month", 20);
    const denied = await t.get(METERED(m2)[0], { token: u.token });
    expect(denied.status).toBe(403);
    expect(denied.body.data).toMatchObject({ code: "ENTITLEMENT_EXCEEDED", details: { featureKey: "analysis.matches_per_month", limit: 20, used: 20, paywall: true } });
    expect(denied.body.data.details.resetsAt).toMatch(/^\d{4}-\d{2}-01T00:00:00.000Z$/);
    // The match already paid for this month is still available.
    expect((await t.get(METERED(m1)[3], { token: u.token })).status).toBe(200);
    // Free match centre, story and timeline are never paywalled.
    for (const p of [`/v1/matches/${m2}`, `/v1/matches/${m2}/story`, `/v1/matches/${m2}/insights`, `/v1/matches/${m2}/events`]) {
      expect((await t.get(p, { token: u.token })).status).toBe(200);
    }
  });

  it("REGRESSION F-04: a missing match (404) or an unanalysed match (409) does not cost a unit", async () => {
    const u = await t.newUser("refund");
    expect((await t.get(`/v1/matches/00000000-0000-7000-8000-00000000abcd/metrics`, { token: u.token })).status).toBe(404);
    expect((await t.get(`/v1/matches/${unanalysed}/pressing`, { token: u.token })).status).toBe(409);
    expect((await t.get(`/v1/matches/compare?a=${m1}&b=00000000-0000-7000-8000-00000000abcd`, { token: u.token })).status).toBe(404);
    expect(await used(u)).toBe(0);
    expect(await used(u, "comparisons.per_month")).toBe(0);
  });

  it("REGRESSION F-04: at the limit, a failing request neither succeeds nor burns the last unit", async () => {
    const u = await t.newUser("lastunit");
    await setUsed(u, "analysis.matches_per_month", 19);
    expect((await t.get(`/v1/matches/${unanalysed}/metrics`, { token: u.token })).status).toBe(409);
    expect(await used(u)).toBe(19);
    expect((await t.get(METERED(m1)[0], { token: u.token })).status).toBe(200);
    expect(await used(u)).toBe(20);
  });

  it("concurrency: parallel requests for different matches at the limit let exactly one through", async () => {
    for (let round = 0; round < 5; round++) {
      const u = await t.newUser("conc");
      await setUsed(u, "analysis.matches_per_month", 19);
      const res = await Promise.all([m1, m2, m1, m2].map((m, i) => t.get(METERED(m)[i % 5], { token: u.token })));
      const okMatches = new Set(res.map((r, i) => (r.status === 200 ? [m1, m2, m1, m2][i] : null)).filter(Boolean));
      expect(okMatches.size).toBe(1);
      expect(res.filter((r) => r.status === 403).length).toBeGreaterThanOrEqual(1);
      expect(await used(u)).toBe(20);
    }
  });

  it("concurrency: parallel requests for the same match charge exactly once", async () => {
    const u = await t.newUser("samematch");
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => t.get(METERED(m1)[i % 5], { token: u.token })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await used(u)).toBe(1);
    const events = (await t.db.execute(t.sql`select count(*)::int as n from entitlement_usage_events where user_id = ${u.id}`)).rows[0].n;
    expect(events).toBe(1);
  });

  it("comparisons are counted per distinct pair (in either order) and per team", async () => {
    const u = await t.newUser("compare");
    const cmp = (a, b, team) => t.get(`/v1/matches/compare?a=${a}&b=${b}${team ? `&teamId=${team}` : ""}`, { token: u.token });
    expect((await cmp(m1, m2)).status).toBe(200);
    expect((await cmp(m2, m1)).status).toBe(200); // same pair reversed
    expect(await used(u, "comparisons.per_month")).toBe(1);
    const team = (await t.db.execute(t.sql`select home_team_id as id from matches where id = ${m1}`)).rows[0].id;
    const sameTeamInBoth = (await t.db.execute(t.sql`select away_team_id as id from matches where id = ${m1}`)).rows[0].id; // France played both finals
    expect((await cmp(m1, m2, sameTeamInBoth)).status).toBe(200);
    expect(await used(u, "comparisons.per_month")).toBe(2);
    // A team that did not play both matches is a 400, and is not charged.
    expect((await cmp(m1, m2, team)).status).toBe(400);
    expect(await used(u, "comparisons.per_month")).toBe(2);
  });

  it("advanced filters are Pro-only on every filtered route; the unfiltered forms stay available", async () => {
    const free = await t.newUser("filters");
    const proUser = await t.newUser("filterspro");
    await pro(proUser);
    const team = (await t.db.execute(t.sql`select home_team_id as id from matches where id = ${m1}`)).rows[0].id;
    const filtered = [
      `/v1/matches/${m1}/events?type=shot`,
      `/v1/matches/${m1}/events?teamId=${team}`,
      `/v1/matches/${m1}/events?period=2`,
      `/v1/matches/${m1}/events?possessionId=3`,
      `/v1/matches/${m1}/events?include=raw`,
      `/v1/matches/${m1}/possessions?endType=shot`,
      `/v1/matches/${m1}/possessions?teamId=${team}`,
    ];
    for (const p of filtered) {
      const denied = await t.get(p, { token: free.token });
      expect(denied.status).toBe(403);
      expect(denied.body.data).toMatchObject({ code: "ENTITLEMENT_REQUIRED", details: { featureKey: "analysis.advanced_filters", unlockedBy: ["pro_monthly", "pro_annual"] } });
      expect((await t.get(p, { token: proUser.token })).status).toBe(200);
      expect((await t.get(p)).status).toBe(401);
    }
    expect((await t.get(`/v1/matches/${m1}/events`, { token: free.token })).status).toBe(200);
  });

  it("Pro removes the monthly limits and the ads; downgrading restores them immediately", async () => {
    const u = await t.newUser("updown");
    await setUsed(u, "analysis.matches_per_month", 20);
    expect((await t.get(METERED(m2)[0], { token: u.token })).status).toBe(403);
    const tk = await pro(u);
    const ok = await t.get(METERED(m2)[0], { token: u.token });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-entitlement-remaining")).toBe(null);
    expect((await t.get("/v1/ads/config", { token: u.token })).body.data.ads.enabled).toBe(false);
    t.services().billing.verifier.setState(tk, "revoked", 30);
    await t.services().billing.restore(u.id);
    expect((await t.get(METERED(m1)[0], { token: u.token })).status).toBe(403);
    expect((await t.get("/v1/ads/config", { token: u.token })).body.data.ads.enabled).toBe(true);
  });

  it("history: Free reaches only the latest two seasons of a competition; Pro reaches all", async () => {
    const competition = (await t.db.execute(t.sql`select competition_id as id from matches where id = ${m2}`)).rows[0].id;
    const names = ["2098", "2099"];
    for (const name of names) {
      await t.db.execute(t.sql`insert into seasons (id, competition_id, name) values (gen_random_uuid(), ${competition}, ${name}) on conflict do nothing`);
    }
    try {
      const free = await t.newUser("history");
      const res = await t.get(METERED(m2)[0], { token: free.token });
      expect(res.status).toBe(403);
      expect(res.body.data.details.featureKey).toBe("history.seasons_back");
      expect(await used(free)).toBe(0); // the history gate runs before anything is charged
      const proUser = await t.newUser("historypro");
      await pro(proUser);
      expect((await t.get(METERED(m2)[0], { token: proUser.token })).status).toBe(200);
    } finally {
      await t.db.execute(t.sql`delete from seasons where competition_id = ${competition} and name in (${names[0]}, ${names[1]})`);
    }
  });

  it("REGRESSION F-12: changing a plan's limits in plan_definitions applies to existing users", async () => {
    const u = await t.newUser("planedit");
    const ent = t.services().entitlements;
    expect((await ent.resolve(u.id, "comparisons.per_month")).limitValue).toBe(5);
    const original = (await t.db.execute(t.sql`select features from plan_definitions where plan_key = 'free'`)).rows[0].features;
    try {
      const edited = { ...original, "comparisons.per_month": { limitValue: 1, usagePeriod: "month" } };
      await t.db.execute(t.sql`update plan_definitions set features = ${JSON.stringify(edited)}::jsonb where plan_key = 'free'`);
      ent.plans = null; // drop the 5-minute in-process plan cache
      expect((await ent.resolve(u.id, "comparisons.per_month")).limitValue).toBe(1);
    } finally {
      await t.db.execute(t.sql`update plan_definitions set features = ${JSON.stringify(original)}::jsonb where plan_key = 'free'`);
      ent.plans = null;
    }
  });

  it("REGRESSION F-09: parallel saves cannot push a user past the saved-items limit", async () => {
    const u = await t.newUser("saves");
    await t.db.execute(t.sql`update entitlements set limit_value = 3 where user_id = ${u.id} and feature_key = 'following.max_saved_items'`);
    // Resolution reads the plan's current limit, so lower it through a dedicated grant source for this user only.
    await t.db.execute(t.sql`update entitlements set source_plan = 'test_custom' where user_id = ${u.id} and feature_key = 'following.max_saved_items'`);
    await t.services().entitlements.invalidate(u.id);
    await t.call("PUT", `/v1/me/saved-matches/${m1}`, { token: u.token });
    await t.call("PUT", `/v1/me/saved-matches/${m2}`, { token: u.token });
    const insights = (await t.db.execute(t.sql`select id from insights order by id limit 6`)).rows.map((r) => r.id);
    const res = await Promise.all(insights.map((id) => t.call("PUT", `/v1/me/saved-insights/${id}`, { token: u.token })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 403)).toHaveLength(5);
    const { rows } = await t.db.execute(t.sql`select (select count(*)::int from saved_matches where user_id = ${u.id}) + (select count(*)::int from saved_insights where owner_user_id = ${u.id}) as n`);
    expect(rows[0].n).toBe(3);
  });

  it("re-analysis is charged only when new work is queued", async () => {
    const u = await t.newUser("rerun");
    const r = await t.call("POST", `/v1/matches/${m1}/analysis-jobs`, { token: u.token });
    expect(r.status).toBe(202);
    expect(r.body.data.job.existing).toBe(true);
    expect(await used(u, "analysis.rerun_per_month")).toBe(0);
    expect((await t.call("POST", `/v1/matches/${unanalysed}/analysis-jobs`, { token: u.token })).status).toBe(409);
    expect(await used(u, "analysis.rerun_per_month")).toBe(0);
  });

  it("re-analysis: no charge when the identical job already ran, a charge and a replay when it had died", async () => {
    const u = await t.newUser("rerunpaths");
    const original = (await t.db.execute(t.sql`select analysis_status from matches where id = ${m2}`)).rows[0].analysis_status;
    const markAll = (status) => t.db.execute(t.sql`update ingestion_jobs set status = ${status} where match_id = ${m2} and job_type = 'analyse_match'`);
    try {
      // Precondition, independent of earlier suites: the match is not up to date and its current job exists, finished.
      await t.db.execute(t.sql`update matches set analysis_status = 'none' where id = ${m2}`);
      await markAll("completed");
      const setup = await t.newUser("rerunsetup");
      const jobId = (await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: setup.token })).body.data.job.jobId;
      await markAll("completed");
      await t.db.execute(t.sql`update matches set analysis_status = 'none' where id = ${m2}`);

      // The identical job already ran: nothing new is queued, so nothing is charged.
      const existing = await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: u.token });
      expect(existing.status).toBe(202);
      expect(existing.body.data.job).toMatchObject({ jobId, existing: true });
      expect(await used(u, "analysis.rerun_per_month")).toBe(0);

      // That job died: asking again replays it, which is real work, so it is charged once.
      await t.db.execute(t.sql`update ingestion_jobs set status = 'dead' where job_id = ${jobId}`);
      expect((await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: u.token })).status).toBe(202);
      expect(await used(u, "analysis.rerun_per_month")).toBe(1);
      expect((await t.db.execute(t.sql`select status, attempts from ingestion_jobs where job_id = ${jobId}`)).rows[0]).toEqual({ status: "queued", attempts: 0 });

      // Asking again while it is queued returns the same job without another charge.
      const again = await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: u.token });
      expect(again.body.data.job).toMatchObject({ jobId, existing: true });
      expect(await used(u, "analysis.rerun_per_month")).toBe(1);
    } finally {
      await t.db.execute(t.sql`update matches set analysis_status = ${original} where id = ${m2}`);
      await markAll("completed");
    }
  });

  it("re-analysis is refused at the monthly limit and nothing is queued", async () => {
    const u = await t.newUser("rerunlimit");
    await setUsed(u, "analysis.rerun_per_month", 3);
    const original = (await t.db.execute(t.sql`select analysis_status from matches where id = ${m2}`)).rows[0].analysis_status;
    const jobs = async () => (await t.db.execute(t.sql`select count(*)::int as n from ingestion_jobs where match_id = ${m2} and job_type = 'analyse_match'`)).rows[0].n;
    const before = await jobs();
    try {
      await t.db.execute(t.sql`update matches set analysis_status = 'none' where id = ${m2}`);
      await t.db.execute(t.sql`update ingestion_jobs set status = 'dead' where match_id = ${m2} and job_type = 'analyse_match'`);
      const res = await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: u.token });
      expect(res.status).toBe(403);
      expect(res.body.data.code).toBe("ENTITLEMENT_EXCEEDED");
      expect(await jobs()).toBe(before);
      expect((await t.db.execute(t.sql`select count(*)::int as n from ingestion_jobs where match_id = ${m2} and job_type = 'analyse_match' and status = 'queued'`)).rows[0].n).toBe(0);
    } finally {
      await t.db.execute(t.sql`update matches set analysis_status = ${original} where id = ${m2}`);
      await t.db.execute(t.sql`update ingestion_jobs set status = 'completed' where match_id = ${m2} and job_type = 'analyse_match'`);
    }
  });

  it("usage counters are per calendar month (UTC) and reset at the boundary", async () => {
    const u = await t.newUser("month");
    const ent = t.services().entitlements;
    const subject = { type: "match", id: m1 };
    const jan31 = new Date("2031-01-31T23:59:59.999Z");
    const feb1 = new Date("2031-02-01T00:00:00.000Z");
    const a = await ent.consume(u.id, "analysis.matches_per_month", subject, jan31);
    const b = await ent.consume(u.id, "analysis.matches_per_month", subject, jan31);
    const c = await ent.consume(u.id, "analysis.matches_per_month", subject, feb1);
    expect([a.charged, b.charged, c.charged]).toEqual([true, false, true]);
    expect([a.entitlement.periodKey, c.entitlement.periodKey]).toEqual(["2031-01", "2031-02"]);
    expect(a.entitlement.resetsAt).toBe("2031-02-01T00:00:00.000Z");
    const dec = await ent.consume(u.id, "analysis.matches_per_month", subject, new Date("2031-12-15T00:00:00Z"));
    expect(dec.entitlement.resetsAt).toBe("2032-01-01T00:00:00.000Z");
    const leap = await ent.consume(u.id, "analysis.matches_per_month", subject, new Date("2032-02-29T23:00:00Z"));
    expect(leap.entitlement.periodKey).toBe("2032-02");
  });

  it("grants and revocations invalidate the cached entitlements", async () => {
    const { EntitlementsService } = await import("../services/entitlements.service.js");
    const deleted = [];
    const store = new Map();
    const cache = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => store.set(k, v),
      del: async (...keys) => keys.forEach((k) => (deleted.push(k), store.delete(k))),
      wrap: async (k, ttl, load) => (store.has(k) ? store.get(k) : (store.set(k, await load()), store.get(k))),
    };
    const svc = new EntitlementsService(t.db, cache);
    const u = await t.newUser("cache");
    expect((await svc.resolve(u.id, "analysis.advanced_filters")).limitValue).toBe(0);
    await svc.grantPlan({ userId: u.id, planKey: "pro_monthly", actor: "test" });
    expect(deleted).toContain(`ent:${u.id}`);
    expect((await svc.resolve(u.id, "analysis.advanced_filters")).limitValue).toBe(1);
    await svc.revokePlan({ userId: u.id, planKey: "pro_monthly", actor: "test" });
    expect((await svc.resolve(u.id, "analysis.advanced_filters")).limitValue).toBe(0);
  });
});
