import { index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps, tz } from "./_common.js";
export const JOB_STATUSES = ["queued", "active", "completed", "failed", "dead", "skipped"];
/**
 * The job list. The API inserts rows; worker.js claims them with FOR UPDATE SKIP LOCKED.
 * Job state is durable and user-visible (PDF §12).
 */
export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    jobId: text().primaryKey(),
    queue: text().notNull(),
    jobType: text().notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lastError: text(),
    progress: jsonb().$type(),
    payload: jsonb().$type().notNull(),
    result: jsonb().$type(),
    requestedByUserId: uuid(),
    scope: text({ enum: ["system", "user"] }).notNull(),
    provider: text(),
    providerMatchId: text(),
    matchId: uuid(),
    schemaVersion: integer().notNull(),
    traceId: text().notNull(),
    parentJobId: text(),
    /** Lower runs first: 1 = user request, 5 = scheduled sync, 10 = backfill. */
    priority: integer().notNull().default(5),
    /** Earliest time the job may run (delayed jobs, retry backoff). */
    runAfter: tz().notNull().defaultNow(),
    /** Set while a worker holds the job; stale locks are re-queued. */
    lockedAt: tz(),
    startedAt: tz(),
    finishedAt: tz(),
    ...timestamps,
  },
  (t) => [
    index("ingestion_jobs_match_idx").on(t.matchId),
    index("ingestion_jobs_status_idx").on(t.status, t.createdAt),
    index("ingestion_jobs_claim_idx").on(t.status, t.runAfter, t.priority),
    index("ingestion_jobs_user_idx").on(t.requestedByUserId, t.createdAt.desc()),
  ],
);
