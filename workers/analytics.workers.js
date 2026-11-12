import { Logger } from "../utils/logger.js";
import { and, eq, like } from "drizzle-orm";
import { ingestionJobs } from "../models/index.js";
import { JOB_TYPES, jobIds, QUEUES } from "../queues/constants.js";
import { PRIORITY } from "../queues/queue.js";
import { runCalculators } from "../services/analytics/calculators/index.js";
import { ANALYTICS_VERSION } from "../services/analytics/version.js";
export const matchCacheKeys = (matchId) => [`cache:match:${matchId}:summary`, `cache:match:${matchId}:run`];
/** tactical-analytics / analyse_match: runs every eligible calculator and commits the results atomically. */
export class AnalyseMatchHandler {
  constructor(registry, loader, repo, queues, cache, config, db) {
    this.registry = registry;
    this.loader = loader;
    this.repo = repo;
    this.queues = queues;
    this.cache = cache;
    this.config = config;
    this.db = db;
    this.logger = new Logger(AnalyseMatchHandler.name);
    this.queue = QUEUES.tacticalAnalytics;
    this.jobType = JOB_TYPES.analyseMatch;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  /**
   * Debounced team-season style recompute: at most one *pending* job per team-season. A trigger that arrives
   * while a recompute is still queued is absorbed by it; once it has started, a new one is scheduled.
   */
  async scheduleStyle(teamId, seasonId, competitionId, child) {
    const prefix = jobIds.teamSeasonStylePrefix(teamId, seasonId, ANALYTICS_VERSION);
    const [pending] = await this.db
      .select({ id: ingestionJobs.jobId })
      .from(ingestionJobs)
      .where(
        and(
          eq(ingestionJobs.jobType, JOB_TYPES.teamSeasonStyle),
          like(ingestionJobs.jobId, `${prefix}.%`),
          eq(ingestionJobs.status, "queued"),
        ),
      )
      .limit(1);
    if (pending) return;
    await this.queues.enqueue({
      queue: QUEUES.tacticalAnalytics,
      jobType: JOB_TYPES.teamSeasonStyle,
      jobId: jobIds.teamSeasonStyle(teamId, seasonId, ANALYTICS_VERSION, String(Date.now())),
      payload: { teamId, seasonId, competitionId },
      delayMs: this.config.TEAM_STYLE_DELAY_MS,
      priority: PRIORITY.backfill,
      ...child,
    });
  }
  async handle(env, ctx) {
    const { matchId } = env.payload;
    const { ctx: match, coverage } = await this.loader.load(matchId);
    const runId = await this.repo.createRun(matchId, ANALYTICS_VERSION, {
      ...match.coverage,
      eventsCount: coverage?.eventsCount ?? 0,
      taxonomyVersion: coverage?.taxonomyVersion ?? null,
    });
    await ctx.progress({ step: "loaded", pct: 20, message: `${match.events.length} events` });
    try {
      const result = runCalculators(match);
      await ctx.progress({ step: "computed", pct: 70, message: `${result.drafts.length} metrics` });
      const written = await this.repo.commitRun({
        runId,
        matchId,
        analyticsVersion: ANALYTICS_VERSION,
        drafts: result.drafts,
        chains: match.chains,
        calculators: result.ran,
      });
      await this.cache.del(...matchCacheKeys(matchId));
      const child = { traceId: env.trace_id, parentJobId: env.job_id, requestedByUserId: env.requested_by_user_id };
      await this.queues.enqueue({
        queue: QUEUES.tacticalAnalytics,
        jobType: JOB_TYPES.generateInsights,
        jobId: jobIds.generateInsights(matchId, runId),
        payload: { matchId, runId },
        matchId,
        priority: env.requested_by_user_id ? PRIORITY.user : PRIORITY.scheduled,
        ...child,
      });
      if (result.drafts.length) {
        for (const teamId of match.teams) await this.scheduleStyle(teamId, match.meta.seasonId, match.meta.competitionId, child);
      }
      return {
        status: "completed",
        result: { runId, metrics: written, calculators: result.ran, skipped: result.skipped, possessions: match.chains.length },
      };
    } catch (err) {
      await this.repo.failRun(runId, matchId, err.message);
      this.logger.error(`analysis of ${matchId} failed: ${err.message}`);
      throw err;
    }
  }
}
