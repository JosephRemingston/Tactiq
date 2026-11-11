import type { Job } from 'bullmq';
import type { JobEnvelope, JobType, QueueName } from './queue.constants';

export interface JobProgress {
  step?: string;
  pct?: number;
  message?: string;
}

export interface JobContext {
  job: Job<JobEnvelope>;
  attempt: number;
  progress(p: JobProgress): Promise<void>;
}

export interface JobOutcome {
  status: 'completed' | 'skipped';
  result?: Record<string, unknown>;
}

export interface JobHandler<P extends Record<string, unknown> = Record<string, unknown>> {
  readonly queue: QueueName;
  readonly jobType: JobType;
  handle(envelope: JobEnvelope<P>, ctx: JobContext): Promise<JobOutcome>;
}

/** Errors that retrying cannot fix (schema drift, missing entities). The job goes straight to 'dead'. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}
