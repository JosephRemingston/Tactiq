// Shared harness for tests that need the real app, a real Postgres database and the StatsBomb fixtures.
//
// Import this module FIRST in a test file: it fixes the environment before any app module reads it.
//   TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_test npm test
//
// Safety: the harness refuses any database host other than localhost / 127.0.0.1 / the CI service name
// "postgres", so a misconfigured variable can never point destructive tests at Neon or another real database.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TEST_AUTHORIZED_PARTY, TEST_JWT_PUBLIC_KEY, TEST_WEBHOOK_SECRET, signSessionToken, signWebhook } from "./tokens.js";

export const DB_URL = process.env.TEST_DATABASE_URL ?? "";
export const RTDN_TOKEN = "rtdn-test-token";
export const PACKAGE_NAME = "app.tactiq.test";
export const FINAL_2022 = "3869685";
export const FINAL_2018 = "8658";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

/** Why the database tests cannot run, or null when they can. */
export function skipReason() {
  if (!DB_URL) return "set TEST_DATABASE_URL to a disposable local Postgres database";
  let host;
  try {
    host = new URL(DB_URL).hostname;
  } catch {
    return "TEST_DATABASE_URL is not a valid URL";
  }
  if (!LOCAL_HOSTS.has(host)) return `refusing to run destructive tests against non-local database host "${host}"`;
  return null;
}

export const SKIP = skipReason();

/** The environment every database test runs with: no real credentials, no network services. */
export const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: DB_URL,
  DATABASE_POOL_MAX: "10",
  REDIS_URL: "",
  STORAGE_DRIVER: "fs",
  STORAGE_FS_ROOT: join(import.meta.dirname, "..", "..", ".data", "test-storage"),
  S3_ENDPOINT: "",
  S3_ACCESS_KEY_ID: "",
  S3_SECRET_ACCESS_KEY: "",
  CLERK_JWT_KEY: TEST_JWT_PUBLIC_KEY,
  CLERK_SECRET_KEY: "",
  CLERK_PUBLISHABLE_KEY: "",
  CLERK_AUTHORIZED_PARTIES: TEST_AUTHORIZED_PARTY,
  CLERK_WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SECRET,
  STATSBOMB_SOURCE: "local",
  STATSBOMB_OPEN_DATA_LOCAL_DIR: join(import.meta.dirname, "..", "fixtures", "statsbomb"),
  STATSBOMB_RATE_PER_SECOND: "1000",
  BILLING_FAKE_VERIFIER: "true",
  GOOGLE_PLAY_RTDN_TOKEN: RTDN_TOKEN,
  GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "",
  ADMOB_NATIVE_UNIT_ID: "",
  ADMOB_BANNER_UNIT_ID: "",
  EDGE_SHARED_SECRET: "",
  CORS_ORIGINS: "",
  TRUST_PROXY: "",
  THROTTLE_IP_PER_MIN: "100000",
  THROTTLE_USER_PER_MIN: "100000",
  QUEUE_BACKOFF_BASE_MS: "0",
};

if (!SKIP) Object.assign(process.env, TEST_ENV);

let ctx = null;

/**
 * Migrates and seeds the test database, makes sure the two fixture finals are ingested and analysed
 * (only the first time; later runs reuse them), and starts the real Express app on a random port.
 */
export async function startTestApp() {
  if (ctx) return ctx;
  const { sql } = await import("drizzle-orm");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const database = await import("../../configs/database.js");
  const { seed } = await import("../../services/seed.service.js");
  const { services } = await import("../../services/index.js");
  const { workers } = await import("../../workers/index.js");
  const { createApp } = await import("../../app.js");

  const db = database.getDb();
  await database.getPool().query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "..", "migrations") });
  await seed(db);

  const matchIds = await fixtureMatchIds(db, sql);
  if (!matchIds[FINAL_2022] || !matchIds[FINAL_2018] || !(await analysed(db, sql, Object.values(matchIds)))) {
    const { ingestion } = services();
    const started = await ingestion.startSync({ provider: "statsbomb", matchIds: [FINAL_2022, FINAL_2018], ingestMatches: true, force: true });
    await workers().runner.drain({ budgetMs: 180_000 });
    const summary = await ingestion.traceSummary(started.traceId);
    const realFailures = summary.failures.filter((f) => f.status === "dead");
    if (!summary.done || realFailures.length) throw new Error(`fixture pipeline failed: ${JSON.stringify(summary)}`);
    Object.assign(matchIds, await fixtureMatchIds(db, sql));
  }

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, headers = {}, raw } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && typeof body !== "string" && !raw ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" || raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  /** A fresh signed-in user; the first authenticated request creates the local row. */
  const newUser = async (prefix = "user") => {
    const clerkId = `${prefix}_${randomBytes(8).toString("hex")}`;
    const token = signSessionToken(clerkId);
    const me = await call("GET", "/v1/me", { token });
    if (me.status !== 200) throw new Error(`could not create test user: ${me.status} ${me.text}`);
    return { clerkId, token, id: me.body.data.user.id };
  };

  const rtdn = (messageId, notification, token = RTDN_TOKEN) =>
    call("POST", `/v1/webhooks/google-play-rtdn?token=${encodeURIComponent(token)}`, {
      body: {
        message: {
          messageId,
          data: Buffer.from(JSON.stringify({ version: "1.0", packageName: PACKAGE_NAME, ...notification })).toString("base64"),
        },
        subscription: "projects/test/subscriptions/rtdn",
      },
    });

  ctx = {
    base,
    server,
    db,
    sql,
    matchIds,
    services,
    workers,
    call,
    get: (path, opts) => call("GET", path, opts),
    newUser,
    rtdn,
    signSessionToken,
    signWebhook,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await database.closeDB();
      ctx = null;
    },
  };
  return ctx;
}

async function fixtureMatchIds(db, sql) {
  const { rows } = await db.execute(sql`
    select provider_entity_id as provider_id, canonical_id as id
      from provider_entity_maps
     where provider = 'statsbomb' and entity_type = 'match' and provider_entity_id in (${FINAL_2022}, ${FINAL_2018})`);
  return Object.fromEntries(rows.map((r) => [r.provider_id, r.id]));
}

async function analysed(db, sql, ids) {
  if (ids.length < 2) return false;
  const { rows } = await db.execute(sql`select count(*)::int as n from matches where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and analysis_status = 'complete'`);
  return rows[0].n === ids.length;
}

/** Month key used by entitlement usage counters. */
export const periodKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Concrete ids for the route catalogue: shared football entities from the fixtures, plus a note and a collection
 * owned by `user` (so private routes have something real to act on).
 */
export async function routeIds(t, user) {
  const { db, sql, matchIds } = t;
  const one = async (q) => (await db.execute(q)).rows[0];
  const match = matchIds[FINAL_2022];
  const team = (await one(sql`select home_team_id as id from matches where id = ${match}`)).id;
  const competition = (await one(sql`select competition_id as id from matches where id = ${match}`)).id;
  const player = (await one(sql`select player_id as id from lineups where match_id = ${match} and is_starter limit 1`)).id;
  const insight = (await one(sql`select id from insights where match_id = ${match} order by rank limit 1`)).id;
  const job = await one(sql`select job_id as id from ingestion_jobs where job_type = 'analyse_match' and match_id = ${match} limit 1`);
  const note = await t.call("POST", "/v1/me/notes", { token: user.token, body: { subjectType: "match", subjectId: match, body: "fixture note" } });
  const collection = await t.call("POST", "/v1/me/collections", { token: user.token, body: { name: "fixture collection" } });
  return {
    match,
    match2: matchIds[FINAL_2018],
    team,
    competition,
    player,
    insight,
    jobId: job?.id ?? "analytics.none",
    note: note.body.data.note.id,
    collection: collection.body.data.collection.id,
    uuid: "00000000-0000-7000-8000-000000000000",
  };
}
