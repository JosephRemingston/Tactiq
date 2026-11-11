import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Errors } from '../../common/errors';
import type { Db } from '../../db/client';
import { ingestionJobs, matchCoverage, matches } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { JOB_TYPES, jobIds, QUEUES } from '../../infra/queue/queue.constants';
import { PRIORITY, QueueService } from '../../infra/queue/queue.service';
import { ANALYTICS_VERSION } from '../../lib/analytics/version';
import { EntitlementsService } from '../entitlements/entitlements.service';
import type { AnalyseMatchPayload } from '../ingestion/ingestion.handlers';

const PUBLIC_JOB_TYPES = new Set<string>([JOB_TYPES.analyseMatch, JOB_TYPES.generateInsights]);

@Injectable()
export class JobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly queues: QueueService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private shape(row: typeof ingestionJobs.$inferSelect) {
    return {
      jobId: row.jobId,
      type: row.jobType,
      status: row.status,
      progress: row.progress ?? null,
      matchId: row.matchId,
      attempts: row.attempts,
      error: row.status === 'dead' || row.status === 'failed' ? 'The job failed. It will be retried automatically or reviewed by the team.' : null,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  /**
   * Requests analysis of a match. Charges `analysis.rerun_per_month` only when new work is actually scheduled;
   * an already analysed or in-progress match returns the existing job.
   */
  async requestAnalysis(matchId: string, userId: string) {
    const [m] = await this.db
      .select({ status: matches.analysisStatus, version: matches.analyticsVersion, hasEvents: matchCoverage.hasEvents, eventsCount: matchCoverage.eventsCount, retrievedAt: matchCoverage.retrievedAt, taxonomy: matchCoverage.taxonomyVersion })
      .from(matches)
      .leftJoin(matchCoverage, eq(matchCoverage.matchId, matches.id))
      .where(eq(matches.id, matchId));
    if (!m) throw Errors.notFound('Match');
    if (!m.hasEvents) throw Errors.conflict('This match has no event data, so it cannot be analysed');

    const [latest] = await this.db
      .select()
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.matchId, matchId), eq(ingestionJobs.jobType, JOB_TYPES.analyseMatch)))
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(1);
    const upToDate = m.status === 'complete' && m.version === ANALYTICS_VERSION;
    if (latest && (upToDate || latest.status === 'queued' || latest.status === 'active')) {
      return { ...this.shape(latest), existing: true };
    }

    const inputVersion = createHash('sha256').update(`${m.eventsCount}|${m.retrievedAt?.toISOString() ?? ''}|t${m.taxonomy ?? 0}`).digest('hex');
    const jobId = jobIds.analyseMatch(matchId, ANALYTICS_VERSION, inputVersion);
    await this.entitlements.consume(userId, 'analysis.rerun_per_month', { type: 'match', id: matchId });
    const res = await this.queues.enqueue<AnalyseMatchPayload>({
      queue: QUEUES.tacticalAnalytics,
      jobType: JOB_TYPES.analyseMatch,
      jobId,
      payload: { matchId, reason: 'user_request' },
      matchId,
      requestedByUserId: userId,
      priority: PRIORITY.user,
    });
    if (!res.created && (res.status === 'dead' || res.status === 'failed')) await this.queues.replay(jobId);
    if (res.created) await this.db.update(matches).set({ analysisStatus: 'queued' }).where(eq(matches.id, matchId));
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    return { ...this.shape(row!), existing: !res.created };
  }

  /** Job status. Visible to its requester, or to anyone for public match-analysis jobs; otherwise 404. */
  async get(jobId: string, userId: string | undefined) {
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    if (!row) throw Errors.notFound('Job');
    const visible = (row.requestedByUserId !== null && row.requestedByUserId === userId) || (PUBLIC_JOB_TYPES.has(row.jobType) && row.matchId !== null);
    if (!visible) throw Errors.notFound('Job');
    return this.shape(row);
  }
}
