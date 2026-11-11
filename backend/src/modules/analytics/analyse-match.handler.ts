import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, like } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { Db } from '../../db/client';
import { ingestionJobs } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { CacheService } from '../../infra/redis/cache.service';
import type { JobContext, JobHandler, JobOutcome } from '../../infra/queue/job-handler';
import { JobRegistry } from '../../infra/queue/job-registry';
import { JOB_TYPES, type JobEnvelope, jobIds, QUEUES } from '../../infra/queue/queue.constants';
import { PRIORITY, QueueService } from '../../infra/queue/queue.service';
import { runCalculators } from '../../lib/analytics/calculators';
import { ANALYTICS_VERSION } from '../../lib/analytics/version';
import type { AnalyseMatchPayload } from '../ingestion/ingestion.handlers';
import { ANALYTICS_REPOSITORY, type AnalyticsRepository } from './analytics.repository';
import { MatchContextLoader } from './match-context.loader';

export interface GenerateInsightsPayload extends Record<string, unknown> {
  matchId: string;
  runId: string;
}
export interface TeamSeasonStylePayload extends Record<string, unknown> {
  teamId: string;
  seasonId: string;
  competitionId: string;
}

export const matchCacheKeys = (matchId: string) => [`cache:match:${matchId}:summary`, `cache:match:${matchId}:run`];

/** tactical-analytics / analyse_match: runs every eligible calculator and commits the results atomically. */
@Injectable()
export class AnalyseMatchHandler implements JobHandler<AnalyseMatchPayload>, OnModuleInit {
  private readonly logger = new Logger(AnalyseMatchHandler.name);
  readonly queue = QUEUES.tacticalAnalytics;
  readonly jobType = JOB_TYPES.analyseMatch;

  constructor(
    private readonly registry: JobRegistry,
    private readonly loader: MatchContextLoader,
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: AnalyticsRepository,
    private readonly queues: QueueService,
    private readonly cache: CacheService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  onModuleInit(): void {
    this.registry.register(this as unknown as JobHandler<never>);
  }

  /**
   * Debounced team-season style recompute: at most one *pending* job per team-season. A trigger that arrives
   * while a recompute is still queued is absorbed by it; once it has started, a new one is scheduled.
   */
  private async scheduleStyle(teamId: string, seasonId: string, competitionId: string, child: { traceId: string; parentJobId: string; requestedByUserId: string | null }) {
    const prefix = jobIds.teamSeasonStylePrefix(teamId, seasonId, ANALYTICS_VERSION);
    const [pending] = await this.db
      .select({ id: ingestionJobs.jobId })
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.jobType, JOB_TYPES.teamSeasonStyle), like(ingestionJobs.jobId, `${prefix}.%`), eq(ingestionJobs.status, 'queued')))
      .limit(1);
    if (pending) return;
    await this.queues.enqueue<TeamSeasonStylePayload>({
      queue: QUEUES.tacticalAnalytics,
      jobType: JOB_TYPES.teamSeasonStyle,
      jobId: jobIds.teamSeasonStyle(teamId, seasonId, ANALYTICS_VERSION, String(Date.now())),
      payload: { teamId, seasonId, competitionId },
      delayMs: this.config.TEAM_STYLE_DELAY_MS,
      priority: PRIORITY.backfill,
      ...child,
    });
  }

  async handle(env: JobEnvelope<AnalyseMatchPayload>, ctx: JobContext): Promise<JobOutcome> {
    const { matchId } = env.payload;
    const { ctx: match, coverage } = await this.loader.load(matchId);
    const runId = await this.repo.createRun(matchId, ANALYTICS_VERSION, { ...match.coverage, eventsCount: coverage?.eventsCount ?? 0, taxonomyVersion: coverage?.taxonomyVersion ?? null });
    await ctx.progress({ step: 'loaded', pct: 20, message: `${match.events.length} events` });
    try {
      const result = runCalculators(match);
      await ctx.progress({ step: 'computed', pct: 70, message: `${result.drafts.length} metrics` });
      const written = await this.repo.commitRun({ runId, matchId, analyticsVersion: ANALYTICS_VERSION, drafts: result.drafts, chains: match.chains, calculators: result.ran });
      await this.cache.del(...matchCacheKeys(matchId));

      const child = { traceId: env.trace_id, parentJobId: env.job_id, requestedByUserId: env.requested_by_user_id };
      await this.queues.enqueue<GenerateInsightsPayload>({
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
      return { status: 'completed', result: { runId, metrics: written, calculators: result.ran, skipped: result.skipped, possessions: match.chains.length } };
    } catch (err) {
      await this.repo.failRun(runId, matchId, (err as Error).message);
      this.logger.error(`analysis of ${matchId} failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
