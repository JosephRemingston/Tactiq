import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

/**
 * Starts throwaway Postgres + Redis containers for the whole run (or reuses TEST_DATABASE_URL / TEST_REDIS_URL),
 * applies migrations and seeds, and hands the URLs to tests via `inject`.
 */
/**
 * Docker configs that name a credential helper which is not installed (e.g. `credsStore: desktop` after
 * switching from Docker Desktop to Colima) break image pulls. Use a sanitized copy for this process only.
 */
function sanitizeDockerConfig(): void {
  const dir = process.env.DOCKER_CONFIG ?? join(homedir(), '.docker');
  const file = join(dir, 'config.json');
  if (!existsSync(file)) return;
  const config = JSON.parse(readFileSync(file, 'utf8')) as { credsStore?: string; credHelpers?: Record<string, string> };
  const helper = config.credsStore;
  if (!helper) return;
  try {
    execFileSync('which', [`docker-credential-${helper}`], { stdio: 'ignore' });
  } catch {
    const safeDir = join(tmpdir(), 'touchline-test-docker-config');
    mkdirSync(safeDir, { recursive: true });
    delete config.credsStore;
    delete config.credHelpers;
    writeFileSync(join(safeDir, 'config.json'), JSON.stringify(config));
    process.env.DOCKER_CONFIG = safeDir;
  }
}

export default async function setup(project: TestProject) {
  sanitizeDockerConfig();
  // Colima users: point Testcontainers at the Colima socket when DOCKER_HOST is unset.
  const colima = join(homedir(), '.colima', 'default', 'docker.sock');
  if (!process.env.DOCKER_HOST && existsSync(colima)) {
    process.env.DOCKER_HOST = `unix://${colima}`;
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= '/var/run/docker.sock';
  }

  let databaseUrl = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;
  const stops: Array<() => Promise<unknown>> = [];

  if (!databaseUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const pg = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('touchline_test').withUsername('test').withPassword('test').start();
    databaseUrl = pg.getConnectionUri();
    stops.push(() => pg.stop());
  }
  if (!redisUrl) {
    const { RedisContainer } = await import('@testcontainers/redis');
    const redis = await new RedisContainer('redis:8-alpine').start();
    redisUrl = redis.getConnectionUrl();
    stops.push(() => redis.stop());
  }

  require('@swc-node/register');
  const { createDb } = require('../../src/db/client') as typeof import('../../src/db/client');
  const { runMigrations } = require('../../src/db/migrate') as typeof import('../../src/db/migrate');
  const { seed } = require('../../src/db/seed') as typeof import('../../src/db/seed');
  const handle = createDb(databaseUrl, 2);
  await runMigrations(handle);
  await seed(handle.db);
  await handle.pool.end();

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await Promise.allSettled(stops.map((s) => s()));
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}
