// Decisions that the main suites reached only on their usual path: refunds when queueing fails, how grants from
// several plans combine, unknown features, idempotent saves, cursor pagination of private lists, and feeds built
// from each kind of follow.
import { SKIP, startTestApp } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";

describe("edge cases", { skip: SKIP ?? false }, () => {
  let t;
  let s;
  let m2;

  before(async () => {
    t = await startTestApp();
    s = t.services();
    m2 = t.matchIds["8658"];
  });
  after(async () => t?.close());

  const rows = async (q) => (await t.db.execute(q)).rows;
  const usedRerun = async (u) =>
    (await rows(t.sql`select coalesce(sum(used), 0)::int as n from entitlement_usage where user_id = ${u.id} and feature_key = 'analysis.rerun_per_month'`))[0].n;
  const makePro = async (u) => {
    const tk = `fake:pro_monthly:active:30::${randomBytes(6).toString("hex")}`;
    await s.billing.verifyPurchase(u.id, { productId: "pro_monthly", purchaseToken: tk }, {});
  };

  describe("charging", () => {
    it("re-analysis: if the job cannot be queued, the charge is refunded and nothing internal leaks", async () => {
      const u = await t.newUser("enqfail");
      const original = (await rows(t.sql`select analysis_status from matches where id = ${m2}`))[0].analysis_status;
      const jobsBefore = await rows(t.sql`select job_id, status from ingestion_jobs where match_id = ${m2} and job_type = 'analyse_match'`);
      const queues = s.jobs.queues;
      const enqueue = queues.enqueue;
      queues.enqueue = async () => {
        throw new Error("connection to 10.0.0.5:5432 refused");
      };
      try {
        await t.db.execute(t.sql`update matches set analysis_status = 'none' where id = ${m2}`);
        await t.db.execute(t.sql`update ingestion_jobs set status = 'dead' where match_id = ${m2} and job_type = 'analyse_match'`);
        const res = await t.call("POST", `/v1/matches/${m2}/analysis-jobs`, { token: u.token });
        expect(res.status).toBe(500);
        expect(res.text).not.toContain("10.0.0.5");
        expect(await usedRerun(u)).toBe(0);
      } finally {
        queues.enqueue = enqueue;
        await t.db.execute(t.sql`update matches set analysis_status = ${original} where id = ${m2}`);
        for (const j of jobsBefore) await t.db.execute(t.sql`update ingestion_jobs set status = ${j.status} where job_id = ${j.job_id}`);
      }
    });

    it("re-analysis of a match that does not exist is a 404 and costs nothing", async () => {
      const u = await t.newUser("rerun404");
      const res = await t.call("POST", "/v1/matches/00000000-0000-7000-8000-000000000000/analysis-jobs", { token: u.token });
      expect(res.status).toBe(404);
      expect(await usedRerun(u)).toBe(0);
    });
  });

  describe("entitlement resolution", () => {
    it("Pro removes ads even though the Free grant still says 'on' (min-combined feature)", async () => {
      const u = await t.newUser("adsmin");
      expect((await s.entitlements.resolve(u.id, "ads.enabled")).limitValue).toBe(1);
      await makePro(u);
      const eff = await s.entitlements.resolve(u.id, "ads.enabled");
      expect(eff.limitValue).toBe(0);
      expect(await s.entitlements.isEnabled(u.id, "ads.enabled")).toBe(false);
    });

    it("a feature no plan defines resolves to 'not allowed', never to unlimited", async () => {
      const u = await t.newUser("unknownfeat");
      expect(await s.entitlements.resolve(u.id, "made.up.feature")).toMatchObject({ limitValue: 0, usagePeriod: "none", sourcePlan: "none" });
      let err;
      try {
        await s.entitlements.consume(u.id, "made.up.feature", { type: "match", id: m2 });
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe("ENTITLEMENT_REQUIRED");
    });

    it("an enabled on/off feature is allowed without being charged", async () => {
      const u = await t.newUser("boolfeat");
      await makePro(u);
      const r = await s.entitlements.consume(u.id, "analysis.advanced_filters", { type: "match", id: m2 });
      expect(r).toMatchObject({ allowed: true, charged: false });
      expect((await rows(t.sql`select count(*)::int n from entitlement_usage where user_id = ${u.id}`))[0].n).toBe(0);
    });

    it("writing the Free plan again for an existing user adds nothing", async () => {
      const u = await t.newUser("freeagain");
      const count = async () => (await rows(t.sql`select count(*)::int n from entitlements where user_id = ${u.id} and source_plan = 'free'`))[0].n;
      const before = await count();
      await s.entitlements.materializeFree(u.id);
      await s.entitlements.materializeFree(u.id);
      expect(await count()).toBe(before);
    });
  });

  describe("saved items and notes", () => {
    const walk = async (fetchPage) => {
      const seen = [];
      let cursor;
      for (let i = 0; i < 20; i++) {
        const page = await fetchPage(cursor);
        seen.push(...page.data);
        cursor = page.page.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };

    it("saving the same match or insight twice keeps one row", async () => {
      const u = await t.newUser("savetwice");
      const [ins] = await rows(t.sql`select id from insights limit 1`);
      for (let i = 0; i < 2; i++) {
        expect((await t.call("PUT", `/v1/me/saved-matches/${m2}`, { token: u.token })).status).toBe(200);
        expect((await t.call("PUT", `/v1/me/saved-insights/${ins.id}`, { token: u.token })).status).toBe(200);
      }
      const n = await rows(t.sql`select (select count(*)::int from saved_matches where user_id = ${u.id}) as m,
                                        (select count(*)::int from saved_insights where owner_user_id = ${u.id}) as i`);
      expect(n[0]).toEqual({ m: 1, i: 1 });
    });

    it("saved matches, saved insights and notes page one item at a time without gaps or repeats", async () => {
      const u = await t.newUser("pager");
      const ms = (await rows(t.sql`select id from matches order by id limit 4`)).map((r) => r.id);
      const ins = (await rows(t.sql`select id from insights order by id limit 4`)).map((r) => r.id);
      for (const id of ms) await s.personal.saveMatch(u.id, id);
      for (const id of ins) await s.personal.saveInsight(u.id, id);
      for (let i = 0; i < 4; i++) {
        expect((await t.call("POST", "/v1/me/notes", { token: u.token, body: { subjectType: "match", subjectId: m2, body: `note ${i}` } })).status).toBe(201);
      }
      const savedM = await walk((c) => s.personal.savedMatches(u.id, 1, c));
      expect(savedM.map((x) => x.match.id).sort()).toEqual([...ms].sort());
      const savedI = await walk((c) => s.personal.savedInsights(u.id, 1, c));
      expect(savedI).toHaveLength(ins.length);
      expect(new Set(savedI.map((x) => JSON.stringify(x))).size).toBe(ins.length);
      const notes = await walk((c) => s.personal.listNotes(u.id, { limit: 1, cursor: c }));
      expect(notes.map((n) => n.body).sort()).toEqual(["note 0", "note 1", "note 2", "note 3"]);
    });
  });

  describe("home feed", () => {
    const feed = async (u) => (await t.get("/v1/me/feed", { token: u.token })).body.data.feed;

    it("following only a competition shows only that competition's matches", async () => {
      const u = await t.newUser("feedcomp");
      const [c] = await rows(t.sql`select competition_id as id from matches where id = ${m2}`);
      expect((await t.call("PUT", `/v1/me/following/competitions/${c.id}`, { token: u.token })).status).toBe(200);
      const f = await feed(u);
      expect(f.empty).toBe(false);
      expect(f.recent.length > 0).toBe(true);
      expect(f.recent.every((m) => m.competition?.id === c.id || m.competitionId === c.id)).toBe(true);
    });

    it("following only a player shows the matches they played in", async () => {
      const u = await t.newUser("feedplayer");
      const [p] = await rows(t.sql`select player_id as id from lineups where match_id = ${m2} limit 1`);
      expect((await t.call("PUT", `/v1/me/following/players/${p.id}`, { token: u.token })).status).toBe(200);
      const f = await feed(u);
      expect(f.recent.map((m) => m.id)).toContain(m2);
    });

    it("following a competition with no matches gives an empty but valid feed", async () => {
      const u = await t.newUser("feedquiet");
      const [c] = await rows(t.sql`select id from competitions c where not exists (select 1 from matches m where m.competition_id = c.id) limit 1`);
      expect((await t.call("PUT", `/v1/me/following/competitions/${c.id}`, { token: u.token })).status).toBe(200);
      expect(await feed(u)).toEqual({ empty: false, recent: [], upcoming: [], insights: [], concepts: [] });
    });
  });
});
