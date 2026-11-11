import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import type { Db } from '../../db/client';
import { ingestionJobs } from '../../db/schema';
import { DB } from '../database/database.module';
import { RedisService } from '../redis/redis.service';
import { type JobContext, type JobOutcome, PermanentJobError } from './job-handler';
import { JobRegistry } from './job-registry';
import { QueueService } from './queue.service';
import { type JobEnvelope, QUEUES, type QueueName } from './queue.constants';

export const JOB_EVENTS_CHANNEL = 'touchline:jobs';

/** Query errors embed the full SQL and parameters; keep the database cause and cap the length. */
export function describeError(err: Error): string {
  const cause = err.cause instanceof Error ? err.cause : null;
  const msg = cause ? `${cause.message}` : err.message;
  return `${cause?.name ?? err.name}: ${msg}`.slice(0, 1000);
}
const MAX_BACKOFF_MS = 30 * 60 * 1000;

@Injectable()
export class WorkerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private readonly workers: Worker[] = [];

  constructor(
    private readonly registry: JobRegistry,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Starts one BullMQ worker per requested queue that has registered handlers. */
  async start(queues: QueueName[] = this.configuredQueues()): Promise<QueueName[]> {
    const available = new Set(this.registry.queuesWithHandlers());
    const started: QueueName[] = [];
    for (const name of queues) {
      if (!available.has(name)) {
        this.logger.warn(`queue ${name} has no handlers in this build; skipping`);
        continue;
      }
      const worker = new Worker<JobEnvelope, JobOutcome>(name, (job) => this.process(job), {
        connection: this.redis.createBullConnection(`worker:${name}`),
        concurrency: this.concurrency(name),
        drainDelay: this.config.WORKER_DRAIN_DELAY_SECONDS,
        stalledInterval: this.config.WORKER_STALLED_INTERVAL_MS,
        settings: { backoffStrategy: (attemptsMade: number) => this.backoff(attemptsMade) },
      });
      worker.on('error', (err) => this.logger.error(`worker ${name}: ${err.message}`));
      await worker.waitUntilReady();
      this.workers.push(worker);
      started.push(name);
    }
    this.logger.log(`workers started: ${started.join(', ') || '(none)'}`);
    await this.queues.recoverOrphans(started);
    return started;
  }

  configuredQueues(): QueueName[] {
    return this.config.WORKER_QUEUES.split(',')
      .map((q) => q.trim())
      .filter(Boolean) as QueueName[];
  }

  private concurrency(name: QueueName): number {
    if (name === QUEUES.providerSync) return 1;
    if (name === QUEUES.tacticalAnalytics) return this.config.WORKER_CONCURRENCY_ANALYTICS;
    return this.config.WORKER_CONCURRENCY_INGESTION;
  }

  backoff(attemptsMade: number): number {
    const base = this.config.QUEUE_BACKOFF_BASE_MS;
    const exp = Math.min(base * 2 ** Math.max(0, attemptsMade - 1), MAX_BACKOFF_MS);
    return Math.round(exp + Math.random() * Math.min(5000, base));
  }

  private async process(job: Job<JobEnvelope>): Promise<JobOutcome> {
    const handler = this.registry.get(job.name);
    if (!handler) throw new UnrecoverableError(`no handler registered for ${job.name}`);
    const jobId = job.id ?? job.data.job_id;
    const attempt = job.attemptsMade + 1;

    const [row] = await this.db.select({ status: ingestionJobs.status }).from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    if (row && (row.status === 'completed' || row.status === 'skipped')) {
      return { status: row.status, result: { deduplicated: true } };
    }

    await this.db
      .update(ingestionJobs)
      .set({ status: 'active', attempts: attempt, startedAt: sql`coalesce(${ingestionJobs.startedAt}, now())`, lastError: null })
      .where(eq(ingestionJobs.jobId, jobId));
    await this.publish(jobId, 'active', job.data.match_id);

    const ctx: JobContext = {
      job,
      attempt,
      progress: async (p) => {
        await this.db.update(ingestionJobs).set({ progress: p }).where(eq(ingestionJobs.jobId, jobId));
        await job.updateProgress(p);
      },
    };

    try {
      const outcome = await handler.handle(job.data as never, ctx);
      await this.db
        .update(ingestionJobs)
        .set({ status: outcome.status, result: outcome.result ?? null, finishedAt: new Date(), progress: { step: 'done', pct: 100 } })
        .where(eq(ingestionJobs.jobId, jobId));
      await this.publish(jobId, outcome.status, job.data.match_id);
      return outcome;
    } catch (err) {
      const error = err as Error;
      const permanent = error instanceof PermanentJobError || error instanceof UnrecoverableError;
      const final = permanent || attempt >= (job.opts.attempts ?? 1);
      await this.db
        .update(ingestionJobs)
        .set({ status: final ? 'dead' : 'failed', lastError: describeError(error), finishedAt: final ? new Date() : null })
        .where(eq(ingestionJobs.jobId, jobId));
      await this.publish(jobId, final ? 'dead' : 'failed', job.data.match_id);
      this.logger.warn(`job ${jobId} attempt ${attempt} failed${final ? ' (final)' : ''}: ${describeError(error)}`);
      if (permanent) throw new UnrecoverableError(error.message);
      throw error;
    }
  }

  private async publish(jobId: string, status: string, matchId: string | null): Promise<void> {
    await this.redis.client.publish(JOB_EVENTS_CHANNEL, JSON.stringify({ jobId, status, matchId, at: new Date().toISOString() })).catch(() => undefined);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.workers.splice(0).map((w) => w.close()));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
