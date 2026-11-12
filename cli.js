// Tactiq admin CLI: node cli.js <command> [options]
import { parseArgs } from "node:util";
import { join } from "node:path";
import { eq, or, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getEnv } from "./configs/env.js";
import { getDb, getPool, closeDB } from "./configs/database.js";
import { getStorage } from "./configs/s3.js";
import { users } from "./models/index.js";
import { isUuid } from "./utils/ids.js";
import { seed } from "./services/seed.service.js";
import { services } from "./services/index.js";
import { workers } from "./workers/index.js";

const HELP = `Tactiq admin CLI

  db:migrate
      Applies pending SQL migrations from ./migrations.
  db:seed
      Upserts licences, metric definitions, tactical concepts and plans from ./data.

  sync:statsbomb  [--competition 43 --season 106] [--matches 3869685,8658] [--local <dir>]
                  [--no-ingest] [--force] [--inline]
      Queues a sync of competitions, matches and (by default) ingestion + analysis of played matches.
      --inline also runs the worker in this process until the queue is empty.

  worker
      Drains the job queue once (same as: node worker.js).

  jobs:replay     --job-id <id> | --dead-since <hours>
  jobs:status     --trace <traceId>

  analytics:styles
      Recomputes team season styles for every team-season with analysed matches.

  storage:check
      Writes and reads back a small object in the configured object storage.

  entitlements:grant   --user <email|clerkId|uuid> --plan pro_monthly [--until 2027-01-01] [--actor admin:name]
  entitlements:revoke  --user <email|clerkId|uuid> --plan pro_monthly [--actor admin:name]
  entitlements:expire
`;

async function resolveUser(ref) {
  const cond = isUuid(ref) ? eq(users.id, ref) : or(eq(users.email, ref), eq(users.clerkUserId, ref));
  const [row] = await getDb().select({ id: users.id }).from(users).where(cond);
  if (!row) throw new Error(`user ${ref} not found`);
  return row.id;
}

async function drain() {
  const summary = await workers().runner.drain({
    onJob: (row, status) => console.log(`${status.padEnd(9)} ${row.jobType} ${row.jobId}`),
  });
  console.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      competition: { type: "string" },
      season: { type: "string" },
      matches: { type: "string" },
      local: { type: "string" },
      "no-ingest": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      inline: { type: "boolean", default: false },
      "job-id": { type: "string" },
      "dead-since": { type: "string" },
      trace: { type: "string" },
      user: { type: "string" },
      plan: { type: "string" },
      until: { type: "string" },
      actor: { type: "string", default: `admin:${process.env.USER ?? "cli"}` },
    },
    strict: true,
  });
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return 0;
  }
  const config = getEnv();

  switch (command) {
    case "db:migrate": {
      // The trigram extension must exist before the first migration creates its indexes.
      await getPool().query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await migrate(getDb(), { migrationsFolder: join(import.meta.dirname, "migrations") });
      console.log("migrations applied");
      return 0;
    }
    case "db:seed": {
      console.log("seeded", await seed(getDb()));
      return 0;
    }
    case "sync:statsbomb": {
      const s = services();
      if (values.local) s.providers.useStatsBombLocalDir(values.local);
      const started = await s.ingestion.startSync({
        provider: "statsbomb",
        competitionId: values.competition,
        seasonId: values.season,
        matchIds: values.matches?.split(",").map((m) => m.trim()),
        ingestMatches: !values["no-ingest"],
        force: values.force,
      });
      console.log(`enqueued ${started.jobId} (trace ${started.traceId})`);
      if (!values.inline) {
        console.log("the next worker run will process it; check progress with: node cli.js jobs:status --trace", started.traceId);
        return 0;
      }
      await drain();
      const summary = await s.ingestion.traceSummary(started.traceId);
      console.log(JSON.stringify(summary, null, 2));
      return summary.done && summary.failures.every((f) => f.status !== "dead") ? 0 : 1;
    }
    case "worker": {
      const summary = await drain();
      return summary.dead > 0 ? 1 : 0;
    }
    case "jobs:status": {
      if (!values.trace) throw new Error("--trace is required");
      console.log(JSON.stringify(await services().ingestion.traceSummary(values.trace), null, 2));
      return 0;
    }
    case "jobs:replay": {
      const s = services();
      const ids = values["job-id"] ? [values["job-id"]] : (await s.ingestion.deadJobs(Number(values["dead-since"] ?? 24))).map((j) => j.jobId);
      if (!ids.length) {
        console.log("nothing to replay");
        return 0;
      }
      for (const id of ids) console.log("replayed", (await s.queues.replay(id)).jobId);
      return 0;
    }
    case "analytics:styles": {
      const s = services();
      const pairs = await s.db.execute(sql`
        select distinct t.team_id, m.season_id, m.competition_id
        from matches m cross join lateral (values (m.home_team_id), (m.away_team_id)) as t(team_id)
        where m.analysis_status = 'complete'`);
      let labelled = 0;
      for (const p of pairs.rows) labelled += (await s.insights.computeTeamStyle(p.team_id, p.season_id, p.competition_id)).labels > 0 ? 1 : 0;
      console.log(`recomputed ${pairs.rows.length} team-season styles (${labelled} with labels)`);
      return 0;
    }
    case "storage:check": {
      const storage = getStorage();
      const key = `healthchecks/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      const body = Buffer.from(JSON.stringify({ ok: true, at: new Date().toISOString() }));
      await storage.put(key, body, "application/json");
      const back = await storage.get(key);
      if (!back || !back.equals(body)) throw new Error("read-back mismatch");
      console.log(`storage ok: driver=${config.STORAGE_DRIVER} bucket=${config.S3_BUCKET_RAW} wrote and read ${key}`);
      return 0;
    }
    case "entitlements:grant": {
      if (!values.user || !values.plan) throw new Error("--user and --plan are required");
      const userId = await resolveUser(values.user);
      const sub = await services().entitlements.grantPlan({
        userId,
        planKey: values.plan,
        until: values.until ? new Date(values.until) : null,
        actor: values.actor,
      });
      console.log(`granted ${values.plan} to ${userId} (subscription ${sub.id})`);
      return 0;
    }
    case "entitlements:revoke": {
      if (!values.user || !values.plan) throw new Error("--user and --plan are required");
      const userId = await resolveUser(values.user);
      console.log(`revoked ${await services().entitlements.revokePlan({ userId, planKey: values.plan, actor: values.actor })} entitlement rows`);
      return 0;
    }
    case "entitlements:expire": {
      console.log(`expired ${await services().entitlements.expireDue()} entitlement rows`);
      return 0;
    }
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then(
    (code) => code,
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      return 1;
    },
  )
  .then(async (code) => {
    await closeDB();
    process.exit(code);
  });
