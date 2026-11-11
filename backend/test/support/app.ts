import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { type AppConfig, loadConfig } from '../../src/config/env';
import type { Db } from '../../src/db/client';
import { DB } from '../../src/infra/database/database.module';
import { RedisService } from '../../src/infra/redis/redis.service';
import { configureApp } from '../../src/main';
import { WorkerRunner } from '../../src/infra/queue/worker-runner';
import { WorkerModule } from '../../src/worker.module';
import { TEST_AUTHORIZED_PARTY, TEST_JWT_PUBLIC_KEY, TEST_WEBHOOK_SECRET } from './tokens';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: `.data/test-storage/${process.pid}`,
    CLERK_JWT_KEY: TEST_JWT_PUBLIC_KEY,
    CLERK_SECRET_KEY: '',
    CLERK_AUTHORIZED_PARTIES: TEST_AUTHORIZED_PARTY,
    CLERK_WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SECRET,
    STATSBOMB_SOURCE: 'local',
    STATSBOMB_OPEN_DATA_LOCAL_DIR: 'test/fixtures/statsbomb',
    QUEUE_BACKOFF_BASE_MS: '50',
    QUEUE_MAX_ATTEMPTS: '3',
    THROTTLE_IP_PER_MIN: '10000',
    THROTTLE_USER_PER_MIN: '10000',
    ...overrides,
  });
}

export interface TestApp {
  app: NestExpressApplication;
  config: AppConfig;
  db: Db;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = testConfig(overrides);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, bufferLogs: true });
  configureApp(app, config);
  await app.init();
  return {
    app,
    config,
    db: app.get<Db>(DB),
    close: async () => {
      await app.get(RedisService).client.flushdb();
      await app.close();
    },
  };
}

/** Removes every user-owned row (keeps seeds and canonical football data). */
export async function resetUsers(db: Db): Promise<void> {
  await db.execute(sql`truncate users, security_events, entitlement_audit restart identity cascade`);
}

/** A worker context (job handlers + WorkerRunner) sharing the same containers as the API app. */
export async function createTestWorker(config: AppConfig) {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.register(config)] }).compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  await moduleRef.get(WorkerRunner).start();
  return { ctx: moduleRef, close: () => moduleRef.close() };
}
