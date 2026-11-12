import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "./env.js";
import * as schema from "../models/index.js";

let pool = null;
let db = null;

/**
 * One small pool per process. On Netlify a warm function instance reuses it across requests;
 * the Neon pooled connection string keeps the total connection count low.
 */
export function getPool() {
  if (!pool) {
    const env = getEnv();
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", msg: "postgres pool error", error: err.message }));
    });
  }
  return pool;
}

export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { schema, casing: "snake_case" });
  }
  return db;
}

const connectDB = async () => {
  const client = await getPool().connect();
  try {
    await client.query("select 1");
  } finally {
    client.release();
  }
  return getDb();
};

export async function closeDB() {
  if (pool) {
    const p = pool;
    pool = null;
    db = null;
    await p.end();
  }
}

export default connectDB;
