import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ingestionJobs } from "../models/index.js";
import { JOB_SCHEMA_VERSION } from "./constants.js";

/** Lower runs first. */
export const PRIORITY = { user: 1, scheduled: 5, backfill: 10 };

/**
 * The job queue is the ingestion_jobs table. The API and the handlers only insert rows here;
 * worker.js (workers/runner.js) claims and runs them. There is no separate queue service.
 */
export class JobQueue {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  /**
   * Idempotent enqueue: a job id that already exists is left untouched (replays go through `replay`).
   * `delayMs` schedules the job for later (debounced work, retry backoff).
   */
  async enqueue(input) {
    const traceId = input.traceId ?? randomUUID();
    const runAfter = input.delayMs ? sql`now() + make_interval(secs => ${input.delayMs / 1000})` : sql`now()`;
    const inserted = await this.db
      .insert(ingestionJobs)
      .values({
        jobId: input.jobId,
        queue: input.queue,
        jobType: input.jobType,
        status: "queued",
        maxAttempts: this.config.QUEUE_MAX_ATTEMPTS,
        payload: input.payload,
        requestedByUserId: input.requestedByUserId ?? null,
        scope: input.requestedByUserId ? "user" : "system",
        provider: input.provider ?? null,
        providerMatchId: input.providerMatchId ?? null,
        matchId: input.matchId ?? null,
        schemaVersion: JOB_SCHEMA_VERSION,
        traceId,
        parentJobId: input.parentJobId ?? null,
        priority: input.priority ?? PRIORITY.scheduled,
        runAfter,
      })
      .onConflictDoNothing({ target: ingestionJobs.jobId })
      .returning({ jobId: ingestionJobs.jobId });

    if (inserted.length === 0) {
      const [existing] = await this.db.select({ status: ingestionJobs.status }).from(ingestionJobs).where(eq(ingestionJobs.jobId, input.jobId));
      return { jobId: input.jobId, created: false, status: existing?.status ?? "unknown", traceId };
    }
    return { jobId: input.jobId, created: true, status: "queued", traceId };
  }

  /** Re-runs a failed or dead job with the same id (admin replay, PDF section 12). */
  async replay(jobId) {
    const [row] = await this.db
      .update(ingestionJobs)
      .set({ status: "queued", attempts: 0, lastError: null, finishedAt: null, lockedAt: null, runAfter: sql`now()`, updatedAt: sql`now()` })
      .where(eq(ingestionJobs.jobId, jobId))
      .returning({ traceId: ingestionJobs.traceId });
    if (!row) throw new Error(`job ${jobId} not found`);
    return { jobId, created: true, status: "queued", traceId: row.traceId };
  }
}

/** The job envelope from PDF section 12, rebuilt from the stored row when a worker claims it. */
export function envelopeOf(row) {
  return {
    job_id: row.jobId,
    job_type: row.jobType,
    requested_by_user_id: row.requestedByUserId,
    scope: row.scope,
    provider: row.provider,
    provider_match_id: row.providerMatchId,
    match_id: row.matchId,
    schema_version: row.schemaVersion,
    requested_at: (row.createdAt ?? new Date()).toISOString(),
    trace_id: row.traceId,
    parent_job_id: row.parentJobId,
    payload: row.payload,
  };
}
