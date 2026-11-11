import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { loadConfig } from './config/env';
import { WorkerRunner } from './infra/queue/worker-runner';
import { WorkerModule } from './worker.module';

/** Worker process: BullMQ processors for WORKER_QUEUES plus a tiny /healthz for the orchestrator. */
async function main(): Promise<void> {
  process.env.TOUCHLINE_ROLE = 'worker';
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const queues = await app.get(WorkerRunner).start();
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  if (port) {
    createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', queues }));
    }).listen(port);
  }
  app.get(Logger).log(`worker running: ${queues.join(', ')}`);
}

void main();
