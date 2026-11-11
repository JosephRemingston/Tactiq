import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { Db } from '../../db/client';
import { matchCoverage, matches, providerSyncState } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { type JobContext, type JobHandler, type JobOutcome, PermanentJobError } from '../../infra/queue/job-handler';
import { JobRegistry } from '../../infra/queue/job-registry';
import { JOB_TYPES, type JobEnvelope, jobIds, QUEUES } from '../../infra/queue/queue.constants';
import { PRIORITY, QueueService } from '../../infra/queue/queue.service';
import { LockService } from '../../infra/redis/lock.service';
import { ANALYTICS_VERSION } from '../../lib/analytics/version';
import { type ProviderKey, ProviderNotConfiguredError, ProviderSchemaError } from '../../lib/providers/provider';
import { ProviderRegistry } from '../providers/provider-registry';
import { CanonicalWriter } from './canonical.writer';
import { RawPayloadStore } from './raw-payload.store';

export interface SyncCompetitionsPayload extends Record<string, unknown> {
  provider: ProviderKey;
  /** "competition:season" provider pairs; null = STATSBOMB_COMPETITION_ALLOWLIST. */
  allowlist: string[] | null;
  ingestMatches: boolean;
  matchIds: string[] | null;
  force: boolean;
}
export interface SyncMatchesPayload extends Record<string, unknown> {
  provider: ProviderKey;
  competitionId: string;
  seasonId: string;
  ingestMatches: boolean;
  matchIds: string[] | null;
  force: boolean;
}
export interface IngestMatchPayload extends Record<string, unknown> {
  provider: ProviderKey;
  providerMatchId: string;
  matchId: string;
  seasonId: string;
  freezeFrameStatus: string | null;
  force: boolean;
}
interface StoredRef {
  key: string;
  sha: string;
}
export interface NormalizeMatchPayload extends Record<string, unknown> {
  provider: ProviderKey;
  providerMatchId: string;
  matchId: string;
  seasonId: string;
  objects: { lineups: StoredRef; events: StoredRef; threeSixty: StoredRef | null };
}
export interface AnalyseMatchPayload extends Record<string, unknown> {
  matchId: string;
  reason: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** Provider errors that retrying cannot fix go straight to the dead-letter state. */
function rethrowPermanent(err: unknown): never {
  if (err instanceof ProviderSchemaError || err instanceof ProviderNotConfiguredError) throw new PermanentJobError(err.message);
  throw err;
}

abstract class Handler<P extends Record<string, unknown>> implements JobHandler<P>, OnModuleInit {
  abstract readonly queue: JobHandler['queue'];
  abstract readonly jobType: JobHandler['jobType'];
  constructor(protected readonly registry: JobRegistry) {}
  onModuleInit(): void {
    this.registry.register(this as unknown as JobHandler<never>);
  }
  abstract handle(envelope: JobEnvelope<P>, ctx: JobContext): Promise<JobOutcome>;
}

const childOf = (env: JobEnvelope) => ({ traceId: env.trace_id, parentJobId: env.job_id, requestedByUserId: env.requested_by_user_id });

@Injectable()
export class SyncCompetitionsHandler extends Handler<SyncCompetitionsPayload> {
  readonly queue = QUEUES.providerSync;
  readonly jobType = JOB_TYPES.syncCompetitions;

  constructor(
    registry: JobRegistry,
    private readonly providers: ProviderRegistry,
    private readonly store: RawPayloadStore,
    private readonly writer: CanonicalWriter,
    private readonly queues: QueueService,
    private readonly locks: LockService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super(registry);
  }

  async handle(env: JobEnvelope<SyncCompetitionsPayload>, ctx: JobContext): Promise<JobOutcome> {
    const p = env.payload;
    const result = await this.locks.withLock(`provider-sync:${p.provider}:competitions`, 10 * 60_000, async () => {
      const adapter = this.providers.get(p.provider);
      const etag = p.force ? null : await this.store.usableEtag(p.provider, 'competitions', 'all');
      const payload = await adapter.listCompetitions({ etag }).catch(rethrowPermanent);
      const stored = await this.store.store(payload);
      await ctx.progress({ step: 'fetched', pct: 30 });
      let items;
      try {
        items = adapter.normalizer.normalizeCompetitions(await this.store.readJson(stored.objectKey));
      } catch (err) {
        rethrowPermanent(err);
      }
      const seasons = await this.writer.upsertCompetitionSeasons(p.provider, items);
      const allow = p.allowlist ?? this.config.STATSBOMB_COMPETITION_ALLOWLIST.split(',').map((s) => s.trim().replace(':', '/'));
      const wanted = allow.map((a) => a.replace(':', '/')).filter((key) => seasons.has(key));
      const missing = allow.map((a) => a.replace(':', '/')).filter((key) => !seasons.has(key));
      for (const key of wanted) {
        const [competitionId, seasonId] = key.split('/') as [string, string];
        await this.queues.enqueue<SyncMatchesPayload>({
          queue: QUEUES.providerSync,
          jobType: JOB_TYPES.syncMatches,
          jobId: jobIds.syncMatches(p.provider, competitionId, seasonId, new Date(), `${p.ingestMatches}|${(p.matchIds ?? []).slice().sort().join(',')}`) + (p.force ? `.f${Date.now()}` : ''),
          payload: { provider: p.provider, competitionId, seasonId, ingestMatches: p.ingestMatches, matchIds: p.matchIds, force: p.force },
          priority: PRIORITY.scheduled,
          ...childOf(env),
        });
      }
      return { competitionSeasons: items.length, changed: stored.changed, enqueuedSeasons: wanted, unknownAllowlistEntries: missing };
    });
    if (!result) return { status: 'skipped', result: { reason: 'another sync holds the lock' } };
    return { status: 'completed', result };
  }
}

@Injectable()
export class SyncMatchesHandler extends Handler<SyncMatchesPayload> {
  private readonly logger = new Logger(SyncMatchesHandler.name);
  readonly queue = QUEUES.providerSync;
  readonly jobType = JOB_TYPES.syncMatches;

  constructor(
    registry: JobRegistry,
    private readonly providers: ProviderRegistry,
    private readonly store: RawPayloadStore,
    private readonly writer: CanonicalWriter,
    private readonly queues: QueueService,
    @Inject(DB) private readonly db: Db,
  ) {
    super(registry);
  }

  async handle(env: JobEnvelope<SyncMatchesPayload>, ctx: JobContext): Promise<JobOutcome> {
    const p = env.payload;
    const adapter = this.providers.get(p.provider);
    const scopeKey = `${p.competitionId}/${p.seasonId}`;
    const competitionId = await this.writer.lookup(p.provider, 'competition', p.competitionId);
    const seasonId = await this.writer.lookup(p.provider, 'season', scopeKey);
    if (!competitionId || !seasonId) throw new PermanentJobError(`competition/season ${scopeKey} not synced yet; run sync_competitions first`);

    const etag = p.force ? null : await this.store.usableEtag(p.provider, 'matches', scopeKey);
    const payload = await adapter.listMatches({ providerCompetitionId: p.competitionId, providerSeasonId: p.seasonId }, { etag }).catch(rethrowPermanent);
    const stored = await this.store.store(payload);
    let items;
    try {
      items = adapter.normalizer.normalizeMatches(await this.store.readJson(stored.objectKey));
    } catch (err) {
      rethrowPermanent(err);
    }
    const matchMap = await this.writer.upsertMatches(p.provider, items, { competitionId, seasonId });
    await ctx.progress({ step: 'matches upserted', pct: 60, message: `${items.length} matches` });

    let enqueued = 0;
    if (p.ingestMatches) {
      const filter = p.matchIds ? new Set(p.matchIds) : null;
      for (const m of items) {
        if (filter && !filter.has(m.ref.id)) continue;
        if (m.status !== 'played') continue;
        const version = `${m.providerUpdatedAt?.toISOString() ?? ''}|${m.providerUpdated360At?.toISOString() ?? ''}`;
        const res = await this.queues.enqueue<IngestMatchPayload>({
          queue: QUEUES.matchIngestion,
          jobType: JOB_TYPES.ingestMatch,
          jobId: jobIds.ingestMatch(p.provider, m.ref.id, version) + (p.force ? `.f${Date.now()}` : ''),
          payload: { provider: p.provider, providerMatchId: m.ref.id, matchId: matchMap.get(m.ref.id)!, seasonId, freezeFrameStatus: m.freezeFrameStatus, force: p.force },
          providerMatchId: m.ref.id,
          matchId: matchMap.get(m.ref.id)!,
          provider: p.provider,
          priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.backfill,
          ...childOf(env),
        });
        if (res.created) enqueued++;
      }
      if (filter && ![...filter].every((id) => matchMap.has(id))) this.logger.warn(`some requested matches are not in ${scopeKey}: ${[...filter].filter((id) => !matchMap.has(id)).join(',')}`);
    }
    await this.db
      .insert(providerSyncState)
      .values({ provider: p.provider, scopeKey: `matches:${scopeKey}`, lastSyncedAt: new Date(), lastSeenSha256: stored.sha256 })
      .onConflictDoUpdate({ target: [providerSyncState.provider, providerSyncState.scopeKey], set: { lastSyncedAt: new Date(), lastSeenSha256: stored.sha256 } });
    return { status: 'completed', result: { matches: items.length, ingestJobsEnqueued: enqueued, changed: stored.changed } };
  }
}

@Injectable()
export class IngestMatchHandler extends Handler<IngestMatchPayload> {
  readonly queue = QUEUES.matchIngestion;
  readonly jobType = JOB_TYPES.ingestMatch;

  constructor(
    registry: JobRegistry,
    private readonly providers: ProviderRegistry,
    private readonly store: RawPayloadStore,
    private readonly queues: QueueService,
    @Inject(DB) private readonly db: Db,
  ) {
    super(registry);
  }

  async handle(env: JobEnvelope<IngestMatchPayload>, ctx: JobContext): Promise<JobOutcome> {
    const p = env.payload;
    const adapter = this.providers.get(p.provider);
    const etag = async (kind: 'lineups' | 'events' | 'three_sixty') => (p.force ? null : this.store.usableEtag(p.provider, kind, p.providerMatchId));

    const lineups = await this.store.store(await adapter.getLineups(p.providerMatchId, { etag: await etag('lineups') }).catch(rethrowPermanent));
    await ctx.progress({ step: 'lineups', pct: 25 });
    const events = await this.store.store(await adapter.getEvents(p.providerMatchId, { etag: await etag('events') }).catch(rethrowPermanent));
    await ctx.progress({ step: 'events', pct: 60 });
    let threeSixty: StoredRef | null = null;
    let ffChanged = false;
    if (p.freezeFrameStatus === 'available') {
      const raw = await adapter.getFreezeFrames(p.providerMatchId, { etag: await etag('three_sixty') }).catch(rethrowPermanent);
      if (raw) {
        const stored = await this.store.store(raw);
        threeSixty = { key: stored.objectKey, sha: stored.sha256 };
        ffChanged = stored.changed;
      }
    }
    await ctx.progress({ step: 'stored', pct: 90 });

    const [coverage] = await this.db.select({ eventsCount: matchCoverage.eventsCount }).from(matchCoverage).where(eq(matchCoverage.matchId, p.matchId));
    const alreadyNormalized = (coverage?.eventsCount ?? 0) > 0;
    if (!p.force && !lineups.changed && !events.changed && !ffChanged && alreadyNormalized) {
      return { status: 'skipped', result: { reason: 'provider payloads unchanged' } };
    }
    const objects = { lineups: { key: lineups.objectKey, sha: lineups.sha256 }, events: { key: events.objectKey, sha: events.sha256 }, threeSixty };
    const normalizer = adapter.normalizer;
    await this.queues.enqueue<NormalizeMatchPayload>({
      queue: QUEUES.normalization,
      jobType: JOB_TYPES.normalizeMatch,
      jobId: jobIds.normalizeMatch(p.provider, p.providerMatchId, normalizer.taxonomyVersion, `${lineups.sha256}|${events.sha256}|${threeSixty?.sha ?? ''}`) + (p.force ? `.f${Date.now()}` : ''),
      payload: { provider: p.provider, providerMatchId: p.providerMatchId, matchId: p.matchId, seasonId: p.seasonId, objects },
      provider: p.provider,
      providerMatchId: p.providerMatchId,
      matchId: p.matchId,
      priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.scheduled,
      ...childOf(env),
    });
    return { status: 'completed', result: { lineupsChanged: lineups.changed, eventsChanged: events.changed, freezeFrames: Boolean(threeSixty) } };
  }
}

@Injectable()
export class NormalizeMatchHandler extends Handler<NormalizeMatchPayload> {
  readonly queue = QUEUES.normalization;
  readonly jobType = JOB_TYPES.normalizeMatch;

  constructor(
    registry: JobRegistry,
    private readonly providers: ProviderRegistry,
    private readonly store: RawPayloadStore,
    private readonly writer: CanonicalWriter,
    private readonly queues: QueueService,
    @Inject(DB) private readonly db: Db,
  ) {
    super(registry);
  }

  async handle(env: JobEnvelope<NormalizeMatchPayload>, ctx: JobContext): Promise<JobOutcome> {
    const p = env.payload;
    const adapter = this.providers.get(p.provider);
    const n = adapter.normalizer;
    let lineups, normalized, freezeFrames;
    try {
      lineups = n.normalizeLineups(await this.store.readJson(p.objects.lineups.key));
      normalized = n.normalizeEvents(await this.store.readJson(p.objects.events.key));
      freezeFrames = p.objects.threeSixty ? n.normalizeFreezeFrames(await this.store.readJson(p.objects.threeSixty.key)) : null;
    } catch (err) {
      rethrowPermanent(err);
    }
    await ctx.progress({ step: 'normalized', pct: 10 });
    const written = await this.writer.writeMatchData({
      provider: p.provider,
      matchId: p.matchId,
      seasonId: p.seasonId,
      lineups,
      events: normalized.events,
      freezeFrames,
      quality: normalized.quality,
      taxonomyVersion: n.taxonomyVersion,
      schemaVersion: n.schemaVersion,
      licenceId: adapter.capabilities().licenceId,
      retrievedAt: new Date(),
      onProgress: (pct) => ctx.progress({ step: 'writing events', pct: 10 + pct }),
    });
    await this.db
      .insert(providerSyncState)
      .values({ provider: p.provider, scopeKey: `match:${p.providerMatchId}`, lastSyncedAt: new Date(), lastSeenSha256: p.objects.events.sha })
      .onConflictDoUpdate({ target: [providerSyncState.provider, providerSyncState.scopeKey], set: { lastSyncedAt: new Date(), lastSeenSha256: p.objects.events.sha } });

    const inputVersion = hash(`${p.objects.lineups.sha}|${p.objects.events.sha}|${p.objects.threeSixty?.sha ?? ''}|t${n.taxonomyVersion}`);
    const enq = await this.queues.enqueue<AnalyseMatchPayload>({
      queue: QUEUES.tacticalAnalytics,
      jobType: JOB_TYPES.analyseMatch,
      jobId: jobIds.analyseMatch(p.matchId, ANALYTICS_VERSION, inputVersion),
      payload: { matchId: p.matchId, reason: 'normalized' },
      matchId: p.matchId,
      priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.scheduled,
      ...childOf(env),
    });
    if (enq.created) await this.db.update(matches).set({ analysisStatus: 'queued', updatedAt: sql`now()` }).where(eq(matches.id, p.matchId));
    return { status: 'completed', result: { ...written, quality: normalized.quality.partial ? 'partial' : 'complete', analysisJobId: enq.jobId } };
  }
}

export const INGESTION_HANDLERS = [SyncCompetitionsHandler, SyncMatchesHandler, IngestMatchHandler, NormalizeMatchHandler];
