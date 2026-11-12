import { and, eq, sql } from "drizzle-orm";
import { ingestionJobs } from "../models/index.js";
import { envelopeOf } from "../queues/queue.js";
import { Logger } from "../utils/logger.js";

/** Errors that retrying cannot fix (schema drift, missing entities). The job goes straight to 'dead'. */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Handlers register themselves by job type; the runner dispatches on it. */
export class JobRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(handler) {
    if (this.handlers.has(handler.jobType)) throw new Error(`duplicate handler for ${handler.jobType}`);
    this.handlers.set(handler.jobType, handler);
  }

  get(jobType) {
    return this.handlers.get(jobType);
  }

  jobTypes() {
    return [...this.handlers.keys()];
  }
}

/** Query errors embed the full SQL and parameters; keep the database cause and cap the length. */
export function describeError(err) {
  const cause = err.cause instanceof Error ? err.cause : null;
  const msg = cause ? `${cause.message}` : err.message;
  return `${cause?.name ?? err.name}: ${msg}`.slice(0, 1000);
}

const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** A job locked for longer than this belonged to a run that died; it is put back in the queue. */
const STALE_LOCK_MINUTES = 30;

export class JobRunner {
  constructor(db, registry, config) {
    this.db = db;
    this.registry = registry;
    this.config = config;
    this.logger = new Logger("JobRunner");
  }

  backoff(attemptsMade) {
    const base = this.config.QUEUE_BACKOFF_BASE_MS;
    const exp = Math.min(base * 2 ** Math.max(0, attemptsMade - 1), MAX_BACKOFF_MS);
    return Math.round(exp + Math.random() * Math.min(5000, base));
  }

  /**
   * Jobs left 'active' by a run that was killed go back to 'queued', unless that was their last attempt: then
   * they are 'dead' (visible, replayable) instead of sitting in 'queued' where no runner will ever claim them.
   */
  async recoverStale() {
    const stale = sql`${ingestionJobs.status} = 'active' and ${ingestionJobs.lockedAt} < now() - make_interval(mins => ${STALE_LOCK_MINUTES})`;
    const dead = await this.db
      .update(ingestionJobs)
      .set({ status: "dead", lockedAt: null, finishedAt: new Date(), lastError: "worker stopped during the final attempt" })
      .where(and(stale, sql`${ingestionJobs.attempts} >= ${ingestionJobs.maxAttempts}`))
      .returning({ jobId: ingestionJobs.jobId });
    const rows = await this.db
      .update(ingestionJobs)
      .set({ status: "queued", lockedAt: null })
      .where(stale)
      .returning({ jobId: ingestionJobs.jobId });
    if (rows.length) this.logger.warn(`re-queued ${rows.length} stale job(s)`);
    if (dead.length) this.logger.warn(`marked ${dead.length} stale job(s) dead after their final attempt`);
    return rows.length + dead.length;
  }

  /** Claims the next runnable job. SKIP LOCKED keeps two runners from taking the same row. */
  async claim() {
    const types = this.registry.jobTypes();
    if (!types.length) return null;
    const result = await this.db.execute(sql`
      update ingestion_jobs
         set status = 'active',
             attempts = attempts + 1,
             locked_at = now(),
             started_at = coalesce(started_at, now()),
             last_error = null,
             updated_at = now()
       where job_id = (
               select job_id
                 from ingestion_jobs
                where status in ('queued', 'failed')
                  and run_after <= now()
                  and attempts < max_attempts
                  and job_type in (${sql.join(
                    types.map((t) => sql`${t}`),
                    sql`, `,
                  )})
                order by priority asc, run_after asc, created_at asc
                for update skip locked
                limit 1
             )
      returning job_id
    `);
    const jobId = result.rows[0]?.job_id;
    if (!jobId) return null;
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    return row ?? null;
  }

  /** Runs one claimed job to an outcome and records it. Never throws. */
  async process(row) {
    const handler = this.registry.get(row.jobType);
    const jobId = row.jobId;
    const ctx = {
      attempt: row.attempts,
      progress: async (p) => {
        await this.db.update(ingestionJobs).set({ progress: p }).where(eq(ingestionJobs.jobId, jobId));
      },
    };
    try {
      const outcome = await handler.handle(envelopeOf(row), ctx);
      await this.db
        .update(ingestionJobs)
        .set({ status: outcome.status, result: outcome.result ?? null, finishedAt: new Date(), lockedAt: null, progress: { step: "done", pct: 100 } })
        .where(eq(ingestionJobs.jobId, jobId));
      return outcome.status;
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      const final = permanent || row.attempts >= row.maxAttempts;
      const delayMs = this.backoff(row.attempts);
      await this.db
        .update(ingestionJobs)
        .set({
          status: final ? "dead" : "failed",
          lastError: describeError(err),
          finishedAt: final ? new Date() : null,
          lockedAt: null,
          runAfter: final ? sql`${ingestionJobs.runAfter}` : sql`now() + make_interval(secs => ${delayMs / 1000})`,
        })
        .where(eq(ingestionJobs.jobId, jobId));
      this.logger.warn(`job ${jobId} attempt ${row.attempts} failed${final ? " (final)" : ""}: ${describeError(err)}`);
      return final ? "dead" : "failed";
    }
  }

  /**
   * Drains the queue: runs jobs one at a time until none is runnable or the time budget is spent.
   * Jobs scheduled for later (delays, retry backoff) are left for the next run.
   */
  async drain({ budgetMs = this.config.WORKER_BUDGET_MS, onJob } = {}) {
    const deadline = Date.now() + budgetMs;
    const counts = { completed: 0, skipped: 0, failed: 0, dead: 0 };
    await this.recoverStale();
    while (Date.now() < deadline) {
      const row = await this.claim();
      if (!row) break;
      const status = await this.process(row);
      counts[status] = (counts[status] ?? 0) + 1;
      onJob?.(row, status);
    }
    const [pending] = (
      await this.db.execute(sql`select count(*)::int as n from ingestion_jobs where status in ('queued', 'failed') and attempts < max_attempts`)
    ).rows;
    return { ...counts, pending: pending?.n ?? 0, budgetExhausted: Date.now() >= deadline };
  }
}
