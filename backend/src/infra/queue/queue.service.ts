import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { Db } from '../../db/client';
import { ingestionJobs } from '../../db/schema';
import { DB } from '../database/database.module';
import { RedisService } from '../redis/redis.service';
import { JOB_SCHEMA_VERSION, type JobEnvelope, type JobType, type QueueName } from './queue.constants';

export interface EnqueueInput<P extends Record<string, unknown>> {
  queue: QueueName;
  jobType: JobType;
  jobId: string;
  payload: P;
  requestedByUserId?: string | null;
  provider?: string | null;
  providerMatchId?: string | null;
  matchId?: string | null;
  traceId?: string;
  parentJobId?: string | null;
  /** BullMQ priority: lower runs first. User requests 1, scheduled 5, backfills 10. */
  priority?: number;
  delayMs?: number;
}

export interface EnqueueResult {
  jobId: string;
  created: boolean;
  status: string;
  traceId?: string;
}

export const PRIORITY = { user: 1, scheduled: 5, backfill: 10 } as const;

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.createBullConnection(`queue:${name}`) });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Idempotent enqueue. The ingestion_jobs row is the source of truth: if a row with this job id exists,
   * nothing new is scheduled (replays go through `replay`). Otherwise the row is written, then the BullMQ job.
   */
  async enqueue<P extends Record<string, unknown>>(input: EnqueueInput<P>): Promise<EnqueueResult> {
    const envelope: JobEnvelope<P> = {
      job_id: input.jobId,
      job_type: input.jobType,
      requested_by_user_id: input.requestedByUserId ?? null,
      scope: input.requestedByUserId ? 'user' : 'system',
      provider: input.provider ?? null,
      provider_match_id: input.providerMatchId ?? null,
      match_id: input.matchId ?? null,
      schema_version: JOB_SCHEMA_VERSION,
      requested_at: new Date().toISOString(),
      trace_id: input.traceId ?? randomUUID(),
      parent_job_id: input.parentJobId ?? null,
      payload: input.payload,
    };

    const inserted = await this.db
      .insert(ingestionJobs)
      .values({
        jobId: envelope.job_id,
        queue: input.queue,
        jobType: envelope.job_type,
        status: 'queued',
        maxAttempts: this.config.QUEUE_MAX_ATTEMPTS,
        payload: envelope.payload,
        requestedByUserId: envelope.requested_by_user_id,
        scope: envelope.scope,
        provider: envelope.provider,
        providerMatchId: envelope.provider_match_id,
        matchId: envelope.match_id,
        schemaVersion: envelope.schema_version,
        traceId: envelope.trace_id,
        parentJobId: envelope.parent_job_id,
      })
      .onConflictDoNothing({ target: ingestionJobs.jobId })
      .returning({ jobId: ingestionJobs.jobId });

    if (inserted.length === 0) {
      const [existing] = await this.db.select({ status: ingestionJobs.status }).from(ingestionJobs).where(eq(ingestionJobs.jobId, input.jobId));
      const status = existing?.status ?? 'unknown';
      // Unfinished in Postgres but unknown to Redis (Redis flushed or evicted): schedule it again instead of stranding it.
      if ((status === 'queued' || status === 'active') && !(await this.queue(input.queue).getJob(input.jobId))) {
        this.logger.warn(`job ${input.jobId} was ${status} in Postgres but missing from Redis; re-adding`);
        await this.db.update(ingestionJobs).set({ status: 'queued', traceId: envelope.trace_id, parentJobId: envelope.parent_job_id }).where(eq(ingestionJobs.jobId, input.jobId));
        await this.addToQueue(input.queue, envelope, input.priority, input.delayMs);
        return { jobId: input.jobId, created: true, status: 'queued' };
      }
      return { jobId: input.jobId, created: false, status };
    }

    await this.addToQueue(input.queue, envelope, input.priority, input.delayMs);
    return { jobId: input.jobId, created: true, status: 'queued' };
  }

  /**
   * Startup recovery: Postgres is the durable record, Redis is not. Jobs that are still pending in
   * ingestion_jobs (queued, active, or failed with attempts left) but unknown to BullMQ are re-added.
   */
  async recoverOrphans(queues: QueueName[]): Promise<string[]> {
    if (!queues.length) return [];
    const rows = await this.db
      .select()
      .from(ingestionJobs)
      .where(
        and(
          inArray(ingestionJobs.queue, queues),
          or(inArray(ingestionJobs.status, ['queued', 'active']), and(eq(ingestionJobs.status, 'failed'), lt(ingestionJobs.attempts, ingestionJobs.maxAttempts))),
        ),
      );
    const recovered: string[] = [];
    for (const row of rows) {
      if (await this.queue(row.queue as QueueName).getJob(row.jobId)) continue;
      await this.db.update(ingestionJobs).set({ status: 'queued' }).where(eq(ingestionJobs.jobId, row.jobId));
      await this.addToQueue(row.queue as QueueName, this.envelopeOf(row));
      recovered.push(row.jobId);
    }
    if (recovered.length) this.logger.warn(`recovered ${recovered.length} job(s) missing from Redis: ${recovered.slice(0, 5).join(', ')}${recovered.length > 5 ? ', ...' : ''}`);
    return recovered;
  }

  private envelopeOf(row: typeof ingestionJobs.$inferSelect): JobEnvelope {
    return {
      job_id: row.jobId,
      job_type: row.jobType as JobType,
      requested_by_user_id: row.requestedByUserId,
      scope: row.scope,
      provider: row.provider,
      provider_match_id: row.providerMatchId,
      match_id: row.matchId,
      schema_version: row.schemaVersion,
      requested_at: new Date().toISOString(),
      trace_id: row.traceId,
      parent_job_id: row.parentJobId,
      payload: row.payload,
    };
  }

  /** Re-runs a failed/dead job with the same id (admin replay, PDF section 12). */
  async replay(jobId: string): Promise<EnqueueResult> {
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    if (!row) throw new Error(`job ${jobId} not found`);
    const queue = this.queue(row.queue as QueueName);
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove();
    const envelope = this.envelopeOf(row);
    await this.db
      .update(ingestionJobs)
      .set({ status: 'queued', attempts: 0, lastError: null, finishedAt: null, updatedAt: sql`now()` })
      .where(eq(ingestionJobs.jobId, jobId));
    await this.addToQueue(row.queue as QueueName, envelope);
    return { jobId, created: true, status: 'queued', traceId: row.traceId };
  }

  private lastTrigger = 0;

  /**
   * Serverless hosting has no always-on worker: after enqueueing, wake the background worker function
   * (debounced, awaited briefly so a frozen function instance cannot drop the request). No-op inside workers.
   */
  private async triggerWorker(): Promise<void> {
    const netlifyDefault = process.env.NETLIFY && process.env.URL ? `${process.env.URL}/.netlify/functions/worker-background` : undefined;
    const url = this.config.WORKER_TRIGGER_URL ?? netlifyDefault;
    if (!url || process.env.TOUCHLINE_ROLE === 'worker' || Date.now() - this.lastTrigger < 10_000) return;
    this.lastTrigger = Date.now();
    await fetch(url, {
      method: 'POST',
      headers: this.config.WORKER_TRIGGER_SECRET ? { 'x-worker-secret': this.config.WORKER_TRIGGER_SECRET } : {},
      signal: AbortSignal.timeout(2000),
    }).catch((err: Error) => this.logger.warn(`worker trigger failed: ${err.message}`));
  }

  private async addToQueue(queue: QueueName, envelope: JobEnvelope, priority?: number, delayMs?: number): Promise<void> {
    await this.queue(queue).add(envelope.job_type, envelope, {
      jobId: envelope.job_id,
      attempts: this.config.QUEUE_MAX_ATTEMPTS,
      backoff: { type: 'touchline' },
      priority,
      delay: delayMs,
      removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    });
    this.logger.debug(`enqueued ${queue}/${envelope.job_type} ${envelope.job_id}`);
    await this.triggerWorker();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
