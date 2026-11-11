/**
 * Netlify background function entry: runs the BullMQ workers until the queues are idle or the time budget
 * (WORKER_DRAIN_BUDGET_MS, under Netlify's 15-minute limit) is used, then shuts down cleanly.
 * Delayed jobs (e.g. debounced team styles) are picked up by the next scheduled run.
 */
import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '../config/env';
import { QueueService } from '../infra/queue/queue.service';
import { WorkerRunner } from '../infra/queue/worker-runner';
import { WorkerModule } from '../worker.module';

export interface DrainResult {
  queues: string[];
  durationMs: number;
  stoppedBecause: 'idle' | 'budget';
}

export async function drainQueues(budgetMs?: number): Promise<DrainResult> {
  process.env.TOUCHLINE_ROLE = 'worker';
  const config = loadConfig();
  const started = Date.now();
  const deadline = started + (budgetMs ?? config.WORKER_DRAIN_BUDGET_MS);
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config), { bufferLogs: true });
  try {
    const queues = await app.get(WorkerRunner).start();
    const svc = app.get(QueueService);
    let idleChecks = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      let pending = 0;
      for (const q of queues) {
        const c = await svc.queue(q).getJobCounts('waiting', 'active', 'prioritized', 'waiting-children');
        pending += Object.values(c).reduce((s, n) => s + n, 0);
      }
      idleChecks = pending === 0 ? idleChecks + 1 : 0;
      if (idleChecks >= 2) return { queues, durationMs: Date.now() - started, stoppedBecause: 'idle' };
    }
    return { queues, durationMs: Date.now() - started, stoppedBecause: 'budget' };
  } finally {
    await app.close();
  }
}

/** Rejects callers without the shared secret when WORKER_TRIGGER_SECRET is configured. */
export function authorized(headers: Record<string, string | undefined> | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  const got = headers?.['x-worker-secret'] ?? headers?.['X-Worker-Secret'];
  return got === secret;
}

export const handler = async (event: { headers?: Record<string, string | undefined> }) => {
  const config = loadConfig();
  if (!authorized(event?.headers, config.WORKER_TRIGGER_SECRET)) return { statusCode: 401, body: 'unauthorized' };
  const result = await drainQueues();
  return { statusCode: 200, body: JSON.stringify(result) };
};
