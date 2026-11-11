import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env';
import { createDb, type DbHandle } from './client';

export const MIGRATIONS_FOLDER = join(__dirname, 'migrations');

/** Extensions must exist before the first migration creates trigram indexes. */
export async function runMigrations(handle: DbHandle): Promise<void> {
  await handle.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (require.main === module) {
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, 2);
  runMigrations(handle)
    .then(() => console.log('migrations applied'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => handle.pool.end());
}
