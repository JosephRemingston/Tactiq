import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entitlements, events, ingestionJobs, matches, users } from '../../src/db/schema';
import { JOB_TYPES, QUEUES } from '../../src/infra/queue/queue.constants';
import { QueueService } from '../../src/infra/queue/queue.service';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service';
import { IngestionService } from '../../src/modules/ingestion/ingestion.service';
import { createTestApp, createTestWorker, resetUsers, type TestApp } from '../support/app';
import { signSessionToken } from '../support/tokens';

const auth = (sub: string) => ({ authorization: `Bearer ${signSessionToken(sub)}` });

describe('end-to-end: ingestion -> analytics -> API', () => {
  let t: TestApp;
  let worker: Awaited<ReturnType<typeof createTestWorker>>;
  let final2022: string;
  let final2018: string;
  let argentina: string;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp({ TEAM_STYLE_DELAY_MS: '0' });
    await t.db.execute(sql`truncate competitions, teams, players, raw_payloads, provider_entity_maps, provider_sync_state, ingestion_jobs restart identity cascade`);
    await resetUsers(t.db);
    worker = await createTestWorker(t.config);
    const ingestion = worker.ctx.get(IngestionService);
    for (const [competitionId, seasonId, matchId] of [['43', '106', '3869685'], ['43', '3', '8658']] as const) {
      const run = await ingestion.startSync({ provider: 'statsbomb', competitionId, seasonId, matchIds: [matchId] });
      const summary = await ingestion.waitForTrace(run.traceId, 120_000);
      expect(summary.failures).toEqual([]);
      expect(summary.done).toBe(true);
    }
    // Insights and team style are enqueued by analyse_match in the same trace; make sure they finished too.
    await ingestion.waitForTrace((await t.db.select({ t: ingestionJobs.traceId }).from(ingestionJobs).where(eq(ingestionJobs.jobType, JOB_TYPES.generateInsights)))[0]!.t, 60_000);
    const list = await http().get('/v1/matches?limit=100');
    final2022 = list.body.data.find((m: { home: { name: string }; away: { name: string }; stage: string }) => m.home.name === 'Argentina' && m.stage === 'Final').id;
    final2018 = list.body.data.find((m: { home: { name: string }; away: { name: string }; stage: string }) => m.home.name === 'France' && m.away.name === 'Croatia').id;
    argentina = list.body.data.find((m: { home: { name: string } }) => m.home.name === 'Argentina').home.id;
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await t?.close();
  });

  describe('public football data', () => {
    it('lists matches with coverage and serves the match centre', async () => {
      const m = (await http().get(`/v1/matches/${final2022}`)).body;
      expect(m.home.score).toBe(3);
      expect(m.home.formation).toBe('4-3-3');
      expect(m.coverage).toMatchObject({ level: 'events_and_freeze_frames', hasEvents: true, hasFreezeFrames: true, hasTracking: false });
      expect(m.coverage.unavailable).toContain('tracking');
      expect(m.analysis.status).toBe('complete');
      expect(m.licence.commercialUseAllowed).toBe(false);
      const m18 = (await http().get(`/v1/matches/${final2018}`)).body;
      expect(m18.coverage.hasFreezeFrames).toBe(false);
      expect(m18.coverage.level).toBe('events');
    });

    it('pages through the filtered timeline with stable cursors', async () => {
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const res = await http().get(`/v1/matches/${final2022}/events?type=shot&limit=10${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        ids.push(...res.body.data.map((e: { id: string }) => e.id));
        cursor = res.body.page.nextCursor;
      } while (cursor);
      const [{ n }] = (await t.db.select({ n: sql<number>`count(*)::int` }).from(events).where(and(eq(events.matchId, final2022), eq(events.typeKey, 'shot')))) as [{ n: number }];
      expect(ids).toHaveLength(n);
      expect(new Set(ids).size).toBe(n);
    });

    it('rejects malformed input with the error envelope', async () => {
      const res = await http().get('/v1/matches?limit=1000');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect((await http().get('/v1/matches/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('serves insights and the match story publicly at every depth', async () => {
      const story = (await http().get(`/v1/matches/${final2022}/story?depth=advanced`)).body;
      expect(story.status).toBe('full');
      expect(story.shortVersion).toContain('Argentina won 4-2 on penalties');
      expect(story.keyPatterns.length).toBeGreaterThan(0);
      expect(story.keyPatterns.length).toBeLessThanOrEqual(3);
      expect(story.keyPatterns[0].evidence.metrics.length).toBeGreaterThan(0);
      expect(story.keyPatterns[0].explanation).toContain('Source: statsbomb');
      const quick = (await http().get(`/v1/matches/${final2022}/story?depth=quick`)).body;
      expect(quick.keyPatterns[0].evidence).toBeUndefined();
      const insights = (await http().get(`/v1/matches/${final2022}/insights?depth=explore`)).body;
      expect(insights.data[0].rank).toBe(1);
      expect(insights.data[0].explanation).toMatch(/\d/);
    });

    it('computes team season style with an explicit sample-size note', async () => {
      const style = (await http().get(`/v1/teams/${argentina}/style`)).body;
      expect(style.data[0].matchesAnalysed).toBe(1);
      expect(style.data[0].labels).toEqual([]);
      expect(style.data[0].note).toMatch(/at least 5/);
    });
  });

  describe('metered analytics and entitlements', () => {
    it('requires sign-in and charges once per match per month', async () => {
      expect((await http().get(`/v1/matches/${final2022}/metrics`)).status).toBe(401);
      const a = await http().get(`/v1/matches/${final2022}/metrics?keys=pressing.ppda&playerId=none`).set(auth('user_meter'));
      expect(a.status).toBe(200);
      expect(a.headers['x-entitlement-remaining']).toBe('19');
      expect(a.body.data.every((m: { key: string }) => m.key === 'pressing.ppda')).toBe(true);
      const b = await http().get(`/v1/matches/${final2022}/tactical-shape?scope=1H`).set(auth('user_meter'));
      expect(b.status).toBe(200);
      expect(b.headers['x-entitlement-remaining']).toBe('19');
      expect(b.body.teams[0].passingNetwork.nodes.length).toBeGreaterThan(5);
      expect(b.body.unavailable[0].reason).toMatch(/tracking/);
      const p = await http().get(`/v1/matches/${final2022}/pressing`).set(auth('user_meter'));
      expect(p.body.teams[0].scopes.full['pressing.ppda'].value).toBeGreaterThan(0);
    });

    it('blocks the next match when the monthly limit is reached and unlocks with Pro', async () => {
      await http().get('/v1/me').set(auth('user_limit')).expect(200);
      const [u] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_limit'));
      const svc = t.app.get(EntitlementsService);
      await t.db.update(entitlements).set({ limitValue: 1 }).where(and(eq(entitlements.userId, u!.id), eq(entitlements.featureKey, 'analysis.matches_per_month')));
      await svc.invalidate(u!.id);
      await http().get(`/v1/matches/${final2022}/transitions`).set(auth('user_limit')).expect(200);
      const denied = await http().get(`/v1/matches/${final2018}/transitions`).set(auth('user_limit'));
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'ENTITLEMENT_EXCEEDED', details: { featureKey: 'analysis.matches_per_month', limit: 1, used: 1 } });
      await http().get(`/v1/matches/${final2022}/pressing`).set(auth('user_limit')).expect(200); // same match is still free
      await svc.grantPlan({ userId: u!.id, planKey: 'pro_monthly', actor: 'test' });
      await http().get(`/v1/matches/${final2018}/transitions`).set(auth('user_limit')).expect(200);
      const ents = (await http().get('/v1/entitlements').set(auth('user_limit'))).body;
      expect(ents.plan.key).toBe('pro_monthly');
      expect(ents.data.find((e: { featureKey: string }) => e.featureKey === 'ads.enabled').limitValue).toBe(0);
    });

    it('counts concurrent requests for the same match once', async () => {
      await http().get('/v1/me').set(auth('user_conc')).expect(200);
      const [u] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_conc'));
      const svc = t.app.get(EntitlementsService);
      await Promise.all(Array.from({ length: 10 }, () => svc.consume(u!.id, 'analysis.matches_per_month', { type: 'match', id: final2018 })));
      expect((await svc.resolve(u!.id, 'analysis.matches_per_month')).used).toBe(1);
    });

    it('compares two matches (route not captured by /matches/:id)', async () => {
      const res = await http().get(`/v1/matches/compare?a=${final2022}&b=${final2018}`).set(auth('user_cmp'));
      expect(res.status).toBe(200);
      expect(res.body.matches).toHaveLength(2);
      expect(res.body.matches[0].teams[0].metrics['shooting.xg']).toBeGreaterThan(0);
    });

    it('serves the player view with an inferred role profile', async () => {
      const lineups = (await http().get(`/v1/matches/${final2022}/lineups`)).body.data;
      const messi = lineups.flatMap((t: { starters: Array<{ playerId: string; knownName: string | null }> }) => t.starters).find((p: { knownName: string | null }) => p.knownName === 'Lionel Messi');
      const res = await http().get(`/v1/matches/${final2022}/players/${messi.playerId}`).set(auth('user_meter'));
      expect(res.status).toBe(200);
      expect(res.body.role.coverageLabel).toBe('inferred');
      expect(res.body.role.family).toBe('FWD');
      expect(res.body.minutes).toBeGreaterThan(90);
    });
  });

  describe('private data ownership', () => {
    it('isolates notes, collections and saved items between users (404, never 403)', async () => {
      const A = auth('owner_a');
      const B = auth('owner_b');
      const note = (await http().post('/v1/me/notes').set(A).send({ subjectType: 'match', subjectId: final2022, body: 'Look at the left channel' })).body;
      expect(note.id).toBeTruthy();
      expect((await http().get(`/v1/me/notes/${note.id}`).set(B)).status).toBe(404);
      expect((await http().patch(`/v1/me/notes/${note.id}`).set(B).send({ body: 'hijack' })).status).toBe(404);
      expect((await http().delete(`/v1/me/notes/${note.id}`).set(B)).status).toBe(404);
      expect((await http().get('/v1/me/notes').set(B)).body.data).toEqual([]);
      expect((await http().get(`/v1/me/notes/${note.id}`).set(A)).body.body).toBe('Look at the left channel');

      const coll = (await http().post('/v1/me/collections').set(A).send({ name: 'Pressing examples' })).body;
      expect((await http().get(`/v1/me/collections/${coll.id}`).set(B)).status).toBe(404);
      expect((await http().put(`/v1/me/collections/${coll.id}/items`).set(B).send({ itemType: 'match', itemId: final2022 })).status).toBe(404);
      expect((await http().put(`/v1/me/collections/${coll.id}/items`).set(B).send({ itemType: 'note', itemId: note.id })).status).toBe(404);
      const withItem = (await http().put(`/v1/me/collections/${coll.id}/items`).set(A).send({ itemType: 'note', itemId: note.id })).body;
      expect(withItem.items).toHaveLength(1);
      // B cannot put A's note into B's own collection either.
      const bColl = (await http().post('/v1/me/collections').set(B).send({ name: 'Mine' })).body;
      expect((await http().put(`/v1/me/collections/${bColl.id}/items`).set(B).send({ itemType: 'note', itemId: note.id })).status).toBe(404);

      const insight = (await http().get(`/v1/matches/${final2022}/insights`)).body.data[0];
      await http().put(`/v1/me/saved-insights/${insight.id}`).set(A).expect(200);
      expect((await http().get('/v1/me/saved-insights').set(B)).body.data).toEqual([]);
      expect((await http().get('/v1/me/saved-insights').set(A)).body.data).toHaveLength(1);
      await http().delete(`/v1/me/saved-insights/${insight.id}`).set(B).expect(200); // no-op for B
      expect((await http().get('/v1/me/saved-insights').set(A)).body.data).toHaveLength(1);
    });

    it('enforces the saved-items limit server-side', async () => {
      await http().get('/v1/me').set(auth('user_saved')).expect(200);
      const [u] = await t.db.select().from(users).where(eq(users.clerkUserId, 'user_saved'));
      await t.db.update(entitlements).set({ limitValue: 1 }).where(and(eq(entitlements.userId, u!.id), eq(entitlements.featureKey, 'following.max_saved_items')));
      await t.app.get(EntitlementsService).invalidate(u!.id);
      await http().put(`/v1/me/saved-matches/${final2022}`).set(auth('user_saved')).expect(200);
      await http().put(`/v1/me/saved-matches/${final2022}`).set(auth('user_saved')).expect(200); // idempotent, not a second item
      const res = await http().put(`/v1/me/saved-matches/${final2018}`).set(auth('user_saved'));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ENTITLEMENT_EXCEEDED');
      const saved = (await http().get('/v1/me/saved-matches').set(auth('user_saved'))).body;
      expect(saved.data[0].match.id).toBe(final2022);
    });

    it('builds a personalised feed from followed teams', async () => {
      const F = auth('user_feed');
      expect((await http().get('/v1/me/feed').set(F)).body.empty).toBe(true);
      await http().put(`/v1/me/following/teams/${argentina}`).set(F).expect(200);
      await http().put(`/v1/me/following/teams/${argentina}`).set(F).expect(200);
      expect((await http().put('/v1/me/following/teams/00000000-0000-4000-8000-000000000000').set(F)).status).toBe(404);
      const feed = (await http().get('/v1/me/feed').set(F)).body;
      expect(feed.recent.map((m: { id: string }) => m.id)).toContain(final2022);
      expect(feed.insights.length).toBeGreaterThan(0);
      expect((await http().get('/v1/me/following').set(F)).body.teams).toHaveLength(1);
      await http().put('/v1/me/learning/ppda').set(F).send({ status: 'completed' }).expect(200);
      expect((await http().get('/v1/me/learning').set(F)).body.data[0].conceptKey).toBe('ppda');
    });
  });

  describe('jobs and reliability', () => {
    it('returns the existing analysis instead of re-running it, and hides system jobs', async () => {
      const res = await http().post(`/v1/matches/${final2022}/analysis-jobs`).set(auth('user_jobs'));
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ existing: true, status: 'completed', type: 'analyse_match' });
      expect((await http().get(`/v1/jobs/${res.body.jobId}`)).status).toBe(200);
      const [ingest] = await t.db.select({ id: ingestionJobs.jobId }).from(ingestionJobs).where(eq(ingestionJobs.jobType, JOB_TYPES.ingestMatch)).limit(1);
      expect((await http().get(`/v1/jobs/${ingest!.id}`)).status).toBe(404);
    });

    it('re-syncing unchanged data is a no-op', async () => {
      const before = await t.db.select({ n: sql<number>`count(*)::int` }).from(ingestionJobs).where(eq(ingestionJobs.jobType, JOB_TYPES.normalizeMatch));
      const ingestion = worker.ctx.get(IngestionService);
      const run = await ingestion.startSync({ provider: 'statsbomb', competitionId: '43', seasonId: '106', matchIds: ['3869685'] });
      await ingestion.waitForTrace(run.traceId, 60_000);
      const after = await t.db.select({ n: sql<number>`count(*)::int` }).from(ingestionJobs).where(eq(ingestionJobs.jobType, JOB_TYPES.normalizeMatch));
      expect(after[0]!.n).toBe(before[0]!.n);
      const [{ n }] = (await t.db.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.matchId, final2022))) as [{ n: number }];
      expect(n).toBe(4407);
    });

    it('enqueueing the same job id twice schedules it once', async () => {
      const queues = worker.ctx.get(QueueService);
      const input = { queue: QUEUES.tacticalAnalytics, jobType: JOB_TYPES.teamSeasonStyle, jobId: 'test.dup.job', payload: { teamId: argentina, seasonId: 'x', competitionId: 'y' } } as const;
      const first = await queues.enqueue({ ...input, delayMs: 60_000 });
      const second = await queues.enqueue({ ...input, delayMs: 60_000 });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      await (await queues.queue(QUEUES.tacticalAnalytics).getJob('test.dup.job'))?.remove();
    });

    it('retries failing jobs with backoff and dead-letters them after max attempts', async () => {
      const queues = worker.ctx.get(QueueService);
      const [m] = await t.db.select({ id: matches.id, seasonId: matches.seasonId }).from(matches).where(eq(matches.id, final2018));
      const res = await queues.enqueue({
        queue: QUEUES.matchIngestion,
        jobType: JOB_TYPES.ingestMatch,
        jobId: 'test.ingest.missing.match',
        payload: { provider: 'statsbomb', providerMatchId: '999999999', matchId: m!.id, seasonId: m!.seasonId, freezeFrameStatus: null, force: true },
      });
      const summary = await worker.ctx.get(IngestionService).waitForTrace((await t.db.select({ t: ingestionJobs.traceId }).from(ingestionJobs).where(eq(ingestionJobs.jobId, res.jobId)))[0]!.t, 30_000);
      expect(summary.failures).toEqual([expect.objectContaining({ jobId: 'test.ingest.missing.match', status: 'dead' })]);
      const [row] = await t.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, res.jobId));
      expect(row!.attempts).toBe(3);
      expect(row!.lastError).toMatch(/not found/);
    });
  });
});
