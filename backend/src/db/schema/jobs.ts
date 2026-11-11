import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, tz } from './_common';

export const JOB_STATUSES = ['queued', 'active', 'completed', 'failed', 'dead', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Durable, user-visible mirror of BullMQ jobs (PDF §12: persist job state where recovery or users need it). */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    jobId: text().primaryKey(),
    queue: text().notNull(),
    jobType: text().notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default('queued'),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lastError: text(),
    progress: jsonb().$type<{ step?: string; pct?: number; message?: string }>(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    result: jsonb().$type<Record<string, unknown>>(),
    requestedByUserId: uuid(),
    scope: text({ enum: ['system', 'user'] }).notNull(),
    provider: text(),
    providerMatchId: text(),
    matchId: uuid(),
    schemaVersion: integer().notNull(),
    traceId: text().notNull(),
    parentJobId: text(),
    startedAt: tz(),
    finishedAt: tz(),
    ...timestamps,
  },
  (t) => [
    index('ingestion_jobs_match_idx').on(t.matchId),
    index('ingestion_jobs_status_idx').on(t.status, t.createdAt),
    index('ingestion_jobs_user_idx').on(t.requestedByUserId, t.createdAt.desc()),
  ],
);
