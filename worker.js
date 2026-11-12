// Job runner entry point. Runs on a schedule in GitHub Actions (.github/workflows/jobs.yml) or by hand:
//   node worker.js            queue today's maintenance jobs, drain the job queue once, then exit
//   node worker.js --sync     start a provider sync first, then drain
import { sql } from "drizzle-orm";
import { getEnv } from "./configs/env.js";
import connectDB, { closeDB, getDb } from "./configs/database.js";
import { matches } from "./models/index.js";
import { connectRedis } from "./configs/redis.js";
import { services } from "./services/index.js";
import { enqueueDailyJobs, workers } from "./workers/index.js";

const env = getEnv();
const withSync = process.argv.includes("--sync");

await connectDB();
await connectRedis();

let exitCode = 0;
try {
  const { runner } = workers();
  await enqueueDailyJobs();
  // A database with no matches has never been synced: start one even without --sync, so the first run fills it.
  const [{ n: matchCount }] = await getDb().select({ n: sql`count(*)::int` }).from(matches);
  const bootstrap = !withSync && matchCount === 0;
  if (bootstrap) console.log("no matches in the database yet: starting the first provider sync");
  console.log(`matches in database: ${matchCount}; provider allowlist: ${env.STATSBOMB_COMPETITION_ALLOWLIST}`);
  if (withSync || bootstrap) {
    const started = await services().ingestion.startSync({ provider: "statsbomb", ingestMatches: true });
    console.log(`sync enqueued: ${started.jobId} (trace ${started.traceId})`);
  }
  console.log("Worker running...");
  const summary = await runner.drain({
    budgetMs: env.WORKER_BUDGET_MS,
    onJob: (row, status) => console.log(`${status.padEnd(9)} ${row.jobType} ${row.jobId}`),
  });
  console.log(JSON.stringify({ msg: "worker finished", ...summary }));
  const [{ n: after, analysed }] = await getDb()
    .select({ n: sql`count(*)::int`, analysed: sql`count(*) filter (where ${matches.analysisStatus} = 'complete')::int` })
    .from(matches);
  console.log(`matches in database now: ${after} (${analysed} analysed)${summary.pending ? `; ${summary.pending} jobs left for the next run` : ""}`);
  // A sync that leaves the database empty is a misconfiguration (allowlist, provider or storage), not a success.
  if ((withSync || bootstrap) && after === 0) {
    console.error("the sync finished but no matches were stored: check STATSBOMB_COMPETITION_ALLOWLIST and the job errors above");
    exitCode = 1;
  }
  if (summary.dead > 0) exitCode = 1;
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await closeDB();
}
process.exit(exitCode);
