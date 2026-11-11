import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { ingestionJobs } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { JOB_TYPES, jobIds, QUEUES } from '../../infra/queue/queue.constants';
import { PRIORITY, QueueService } from '../../infra/queue/queue.service';
import type { ProviderKey } from '../../lib/providers/provider';
import type { SyncCompetitionsPayload } from './ingestion.handlers';

export interface TraceSummary {
  traceId: string;
  done: boolean;
  counts: Record<string, Record<string, number>>;
  failures: Array<{ jobId: string; jobType: string; status: string; lastError: string | null }>;
}

@Injectable()
export class IngestionService {
  constructor(
    private readonly queues: QueueService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Starts the chain sync_competitions -> sync_matches -> ingest_match -> normalize_match -> analyse_match. */
  async startSync(input: {
    provider: ProviderKey;
    competitionId?: string;
    seasonId?: string;
    matchIds?: string[];
    ingestMatches?: boolean;
    force?: boolean;
    requestedByUserId?: string | null;
  }): Promise<{ jobId: string; traceId: string; created: boolean }> {
    const traceId = randomUUID();
    const allowlist = input.competitionId && input.seasonId ? [`${input.competitionId}:${input.seasonId}`] : null;
    const scopeSuffix = allowlist ? `.${input.competitionId}.${input.seasonId}` : '';
    const forceSuffix = input.force ? `.f${Date.now()}` : '';
    const res = await this.queues.enqueue<SyncCompetitionsPayload>({
      queue: QUEUES.providerSync,
      jobType: JOB_TYPES.syncCompetitions,
      // Manual runs get a unique suffix so a same-day scheduled sync does not swallow them.
      jobId: `${jobIds.syncCompetitions(input.provider, new Date())}${scopeSuffix}.${traceId.slice(0, 8)}${forceSuffix}`,
      payload: { provider: input.provider, allowlist, ingestMatches: input.ingestMatches ?? true, matchIds: input.matchIds?.length ? input.matchIds : null, force: Boolean(input.force) },
      provider: input.provider,
      traceId,
      requestedByUserId: input.requestedByUserId ?? null,
      priority: PRIORITY.user,
    });
    return { jobId: res.jobId, traceId, created: res.created };
  }

  async traceSummary(traceId: string): Promise<TraceSummary> {
    const rows = await this.db
      .select({ jobId: ingestionJobs.jobId, jobType: ingestionJobs.jobType, status: ingestionJobs.status, lastError: ingestionJobs.lastError, attempts: ingestionJobs.attempts, maxAttempts: ingestionJobs.maxAttempts })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.traceId, traceId));
    const counts: TraceSummary['counts'] = {};
    for (const r of rows) {
      counts[r.jobType] ??= {};
      counts[r.jobType]![r.status] = (counts[r.jobType]![r.status] ?? 0) + 1;
    }
    // 'failed' with attempts left will be retried, so it still counts as pending.
    const pending = rows.some((r) => r.status === 'queued' || r.status === 'active' || (r.status === 'failed' && r.attempts < r.maxAttempts));
    return {
      traceId,
      done: rows.length > 0 && !pending,
      counts,
      failures: rows.filter((r) => r.status === 'dead' || r.status === 'failed').map((r) => ({ jobId: r.jobId, jobType: r.jobType, status: r.status, lastError: r.lastError })),
    };
  }

  /** Polls until every job in the trace has finished (completed, skipped or dead) or the timeout passes. */
  async waitForTrace(traceId: string, timeoutMs = 10 * 60_000, onTick?: (s: TraceSummary) => void): Promise<TraceSummary> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.traceSummary(traceId);
    while (!last.done && Date.now() < deadline) {
      await sleep(500);
      last = await this.traceSummary(traceId);
      onTick?.(last);
    }
    return last;
  }

  async deadJobs(sinceHours = 24) {
    return this.db
      .select({ jobId: ingestionJobs.jobId, jobType: ingestionJobs.jobType, lastError: ingestionJobs.lastError })
      .from(ingestionJobs)
      .where(sql`${ingestionJobs.status} = 'dead' and ${ingestionJobs.updatedAt} > now() - make_interval(hours => ${sinceHours})`);
  }
}
