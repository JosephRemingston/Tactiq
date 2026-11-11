import { Global, Module } from '@nestjs/common';
import { JobRegistry } from './job-registry';
import { QueueService } from './queue.service';
import { WorkerRunner } from './worker-runner';

@Global()
@Module({ providers: [QueueService, JobRegistry, WorkerRunner], exports: [QueueService, JobRegistry, WorkerRunner] })
export class QueueModule {}
