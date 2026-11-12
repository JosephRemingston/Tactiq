import { createHash } from "node:crypto";
import { Logger } from "../utils/logger.js";
import { eq, sql } from "drizzle-orm";
import { matchCoverage, matches, providerSyncState } from "../models/index.js";
import { PermanentJobError } from "./runner.js";
import { JOB_TYPES, jobIds, QUEUES } from "../queues/constants.js";
import { PRIORITY } from "../queues/queue.js";
import { ANALYTICS_VERSION } from "../services/analytics/version.js";
import { ProviderNotConfiguredError, ProviderSchemaError } from "../services/providers/provider.js";
const hash = (s) => createHash("sha256").update(s).digest("hex");
/** Provider errors that retrying cannot fix go straight to the dead-letter state. */
function rethrowPermanent(err) {
  if (err instanceof ProviderSchemaError || err instanceof ProviderNotConfiguredError) throw new PermanentJobError(err.message);
  throw err;
}
class Handler {
  constructor(registry) {
    this.registry = registry;
  }
  onModuleInit() {
    this.registry.register(this);
  }
}
const childOf = (env) => ({ traceId: env.trace_id, parentJobId: env.job_id, requestedByUserId: env.requested_by_user_id });
export class SyncCompetitionsHandler extends Handler {
  constructor(registry, providers, store, writer, queues, locks, config) {
    super(registry);
    this.providers = providers;
    this.store = store;
    this.writer = writer;
    this.queues = queues;
    this.locks = locks;
    this.config = config;
    this.queue = QUEUES.providerSync;
    this.jobType = JOB_TYPES.syncCompetitions;
  }
  async handle(env, ctx) {
    const p = env.payload;
    const result = await this.locks.withLock(`provider-sync:${p.provider}:competitions`, 10 * 60_000, async () => {
      const adapter = this.providers.get(p.provider);
      const etag = p.force ? null : await this.store.usableEtag(p.provider, "competitions", "all");
      const payload = await adapter.listCompetitions({ etag }).catch(rethrowPermanent);
      const stored = await this.store.store(payload);
      await ctx.progress({ step: "fetched", pct: 30 });
      let items;
      try {
        items = adapter.normalizer.normalizeCompetitions(await this.store.readJson(stored.objectKey));
      } catch (err) {
        rethrowPermanent(err);
      }
      const seasons = await this.writer.upsertCompetitionSeasons(p.provider, items);
      const allow = p.allowlist ?? this.config.STATSBOMB_COMPETITION_ALLOWLIST.split(",").map((s) => s.trim().replace(":", "/"));
      const wanted = allow.map((a) => a.replace(":", "/")).filter((key) => seasons.has(key));
      const missing = allow.map((a) => a.replace(":", "/")).filter((key) => !seasons.has(key));
      for (const key of wanted) {
        const [competitionId, seasonId] = key.split("/");
        await this.queues.enqueue({
          queue: QUEUES.providerSync,
          jobType: JOB_TYPES.syncMatches,
          jobId:
            jobIds.syncMatches(
              p.provider,
              competitionId,
              seasonId,
              new Date(),
              `${p.ingestMatches}|${(p.matchIds ?? []).slice().sort().join(",")}`,
            ) + (p.force ? `.f${Date.now()}` : ""),
          payload: { provider: p.provider, competitionId, seasonId, ingestMatches: p.ingestMatches, matchIds: p.matchIds, force: p.force },
          priority: PRIORITY.scheduled,
          ...childOf(env),
        });
      }
      return { competitionSeasons: items.length, changed: stored.changed, enqueuedSeasons: wanted, unknownAllowlistEntries: missing };
    });
    if (!result) return { status: "skipped", result: { reason: "another sync holds the lock" } };
    return { status: "completed", result };
  }
}
export class SyncMatchesHandler extends Handler {
  constructor(registry, providers, store, writer, queues, db) {
    super(registry);
    this.providers = providers;
    this.store = store;
    this.writer = writer;
    this.queues = queues;
    this.db = db;
    this.logger = new Logger(SyncMatchesHandler.name);
    this.queue = QUEUES.providerSync;
    this.jobType = JOB_TYPES.syncMatches;
  }
  async handle(env, ctx) {
    const p = env.payload;
    const adapter = this.providers.get(p.provider);
    const scopeKey = `${p.competitionId}/${p.seasonId}`;
    const competitionId = await this.writer.lookup(p.provider, "competition", p.competitionId);
    const seasonId = await this.writer.lookup(p.provider, "season", scopeKey);
    if (!competitionId || !seasonId)
      throw new PermanentJobError(`competition/season ${scopeKey} not synced yet; run sync_competitions first`);
    const etag = p.force ? null : await this.store.usableEtag(p.provider, "matches", scopeKey);
    const payload = await adapter
      .listMatches({ providerCompetitionId: p.competitionId, providerSeasonId: p.seasonId }, { etag })
      .catch(rethrowPermanent);
    const stored = await this.store.store(payload);
    let items;
    try {
      items = adapter.normalizer.normalizeMatches(await this.store.readJson(stored.objectKey));
    } catch (err) {
      rethrowPermanent(err);
    }
    const matchMap = await this.writer.upsertMatches(p.provider, items, { competitionId, seasonId });
    await ctx.progress({ step: "matches upserted", pct: 60, message: `${items.length} matches` });
    let enqueued = 0;
    if (p.ingestMatches) {
      const filter = p.matchIds ? new Set(p.matchIds) : null;
      for (const m of items) {
        if (filter && !filter.has(m.ref.id)) continue;
        if (m.status !== "played") continue;
        const version = `${m.providerUpdatedAt?.toISOString() ?? ""}|${m.providerUpdated360At?.toISOString() ?? ""}`;
        const res = await this.queues.enqueue({
          queue: QUEUES.matchIngestion,
          jobType: JOB_TYPES.ingestMatch,
          jobId: jobIds.ingestMatch(p.provider, m.ref.id, version) + (p.force ? `.f${Date.now()}` : ""),
          payload: {
            provider: p.provider,
            providerMatchId: m.ref.id,
            matchId: matchMap.get(m.ref.id),
            seasonId,
            freezeFrameStatus: m.freezeFrameStatus,
            force: p.force,
          },
          providerMatchId: m.ref.id,
          matchId: matchMap.get(m.ref.id),
          provider: p.provider,
          priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.backfill,
          ...childOf(env),
        });
        if (res.created) enqueued++;
      }
      if (filter && ![...filter].every((id) => matchMap.has(id)))
        this.logger.warn(`some requested matches are not in ${scopeKey}: ${[...filter].filter((id) => !matchMap.has(id)).join(",")}`);
    }
    await this.db
      .insert(providerSyncState)
      .values({ provider: p.provider, scopeKey: `matches:${scopeKey}`, lastSyncedAt: new Date(), lastSeenSha256: stored.sha256 })
      .onConflictDoUpdate({
        target: [providerSyncState.provider, providerSyncState.scopeKey],
        set: { lastSyncedAt: new Date(), lastSeenSha256: stored.sha256 },
      });
    return { status: "completed", result: { matches: items.length, ingestJobsEnqueued: enqueued, changed: stored.changed } };
  }
}
export class IngestMatchHandler extends Handler {
  constructor(registry, providers, store, queues, db) {
    super(registry);
    this.providers = providers;
    this.store = store;
    this.queues = queues;
    this.db = db;
    this.queue = QUEUES.matchIngestion;
    this.jobType = JOB_TYPES.ingestMatch;
  }
  async handle(env, ctx) {
    const p = env.payload;
    const adapter = this.providers.get(p.provider);
    const etag = async (kind) => (p.force ? null : this.store.usableEtag(p.provider, kind, p.providerMatchId));
    const lineups = await this.store.store(
      await adapter.getLineups(p.providerMatchId, { etag: await etag("lineups") }).catch(rethrowPermanent),
    );
    await ctx.progress({ step: "lineups", pct: 25 });
    const events = await this.store.store(
      await adapter.getEvents(p.providerMatchId, { etag: await etag("events") }).catch(rethrowPermanent),
    );
    await ctx.progress({ step: "events", pct: 60 });
    let threeSixty = null;
    let ffChanged = false;
    if (p.freezeFrameStatus === "available") {
      const raw = await adapter.getFreezeFrames(p.providerMatchId, { etag: await etag("three_sixty") }).catch(rethrowPermanent);
      if (raw) {
        const stored = await this.store.store(raw);
        threeSixty = { key: stored.objectKey, sha: stored.sha256 };
        ffChanged = stored.changed;
      }
    }
    await ctx.progress({ step: "stored", pct: 90 });
    const [coverage] = await this.db
      .select({ eventsCount: matchCoverage.eventsCount })
      .from(matchCoverage)
      .where(eq(matchCoverage.matchId, p.matchId));
    const alreadyNormalized = (coverage?.eventsCount ?? 0) > 0;
    if (!p.force && !lineups.changed && !events.changed && !ffChanged && alreadyNormalized) {
      return { status: "skipped", result: { reason: "provider payloads unchanged" } };
    }
    const objects = {
      lineups: { key: lineups.objectKey, sha: lineups.sha256 },
      events: { key: events.objectKey, sha: events.sha256 },
      threeSixty,
    };
    const normalizer = adapter.normalizer;
    await this.queues.enqueue({
      queue: QUEUES.normalization,
      jobType: JOB_TYPES.normalizeMatch,
      jobId:
        jobIds.normalizeMatch(
          p.provider,
          p.providerMatchId,
          normalizer.taxonomyVersion,
          `${lineups.sha256}|${events.sha256}|${threeSixty?.sha ?? ""}`,
        ) + (p.force ? `.f${Date.now()}` : ""),
      payload: { provider: p.provider, providerMatchId: p.providerMatchId, matchId: p.matchId, seasonId: p.seasonId, objects },
      provider: p.provider,
      providerMatchId: p.providerMatchId,
      matchId: p.matchId,
      priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.scheduled,
      ...childOf(env),
    });
    return {
      status: "completed",
      result: { lineupsChanged: lineups.changed, eventsChanged: events.changed, freezeFrames: Boolean(threeSixty) },
    };
  }
}
export class NormalizeMatchHandler extends Handler {
  constructor(registry, providers, store, writer, queues, db) {
    super(registry);
    this.providers = providers;
    this.store = store;
    this.writer = writer;
    this.queues = queues;
    this.db = db;
    this.queue = QUEUES.normalization;
    this.jobType = JOB_TYPES.normalizeMatch;
  }
  async handle(env, ctx) {
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
    await ctx.progress({ step: "normalized", pct: 10 });
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
      onProgress: (pct) => ctx.progress({ step: "writing events", pct: 10 + pct }),
    });
    await this.db
      .insert(providerSyncState)
      .values({
        provider: p.provider,
        scopeKey: `match:${p.providerMatchId}`,
        lastSyncedAt: new Date(),
        lastSeenSha256: p.objects.events.sha,
      })
      .onConflictDoUpdate({
        target: [providerSyncState.provider, providerSyncState.scopeKey],
        set: { lastSyncedAt: new Date(), lastSeenSha256: p.objects.events.sha },
      });
    const inputVersion = hash(`${p.objects.lineups.sha}|${p.objects.events.sha}|${p.objects.threeSixty?.sha ?? ""}|t${n.taxonomyVersion}`);
    const enq = await this.queues.enqueue({
      queue: QUEUES.tacticalAnalytics,
      jobType: JOB_TYPES.analyseMatch,
      jobId: jobIds.analyseMatch(p.matchId, ANALYTICS_VERSION, inputVersion),
      payload: { matchId: p.matchId, reason: "normalized" },
      matchId: p.matchId,
      priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.scheduled,
      ...childOf(env),
    });
    if (enq.created)
      await this.db
        .update(matches)
        .set({ analysisStatus: "queued", updatedAt: sql`now()` })
        .where(eq(matches.id, p.matchId));
    return {
      status: "completed",
      result: { ...written, quality: normalized.quality.partial ? "partial" : "complete", analysisJobId: enq.jobId },
    };
  }
}
export const INGESTION_HANDLERS = [SyncCompetitionsHandler, SyncMatchesHandler, IngestMatchHandler, NormalizeMatchHandler];
