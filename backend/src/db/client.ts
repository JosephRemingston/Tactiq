import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A database handle or an open transaction; repositories accept either. */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: Pool;
}

export function createDb(url: string, max = 10): DbHandle {
  const pool = new Pool({ connectionString: url, max, application_name: 'touchline' });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool };
}
