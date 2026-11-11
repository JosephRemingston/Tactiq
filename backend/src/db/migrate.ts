import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { databaseUrlFromEnv } from '../config/env';
import { createDb, type DbHandle } from './client';

export const MIGRATIONS_FOLDER = join(__dirname, 'migrations');

/** Extensions must exist before the first migration creates trigram indexes. */
export async function runMigrations(handle: DbHandle): Promise<void> {
  await handle.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (require.main === module) {
  // Only DATABASE_URL is needed, so this can run in a build step without the full runtime configuration.
  const handle = createDb(databaseUrlFromEnv(), 2);
  runMigrations(handle)
    .then(() => console.log('migrations applied'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => handle.pool.end());
}
