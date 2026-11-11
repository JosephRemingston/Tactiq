import { Injectable } from '@nestjs/common';
import type { JobHandler } from './job-handler';
import type { JobType, QueueName } from './queue.constants';

/** Handlers self-register in onModuleInit; the worker runner dispatches by job type. */
@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<JobType, JobHandler<never>>();

  register(handler: JobHandler<never>): void {
    if (this.handlers.has(handler.jobType)) throw new Error(`duplicate handler for ${handler.jobType}`);
    this.handlers.set(handler.jobType, handler);
  }

  get(jobType: string): JobHandler<never> | undefined {
    return this.handlers.get(jobType as JobType);
  }

  queuesWithHandlers(): QueueName[] {
    return [...new Set([...this.handlers.values()].map((h) => h.queue))];
  }
}
