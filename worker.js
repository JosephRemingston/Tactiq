// Job runner entry point. Runs on a schedule in GitHub Actions (.github/workflows/jobs.yml) or by hand:
//   node worker.js            queue today's maintenance jobs, drain the job queue once, then exit
//   node worker.js --sync     start a provider sync first, then drain
import { getEnv } from "./configs/env.js";
import connectDB, { closeDB } from "./configs/database.js";
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
  if (withSync) {
    const started = await services().ingestion.startSync({ provider: "statsbomb", ingestMatches: true });
    console.log(`sync enqueued: ${started.jobId} (trace ${started.traceId})`);
  }
  console.log("Worker running...");
  const summary = await runner.drain({
    budgetMs: env.WORKER_BUDGET_MS,
    onJob: (row, status) => console.log(`${status.padEnd(9)} ${row.jobType} ${row.jobId}`),
  });
  console.log(JSON.stringify({ msg: "worker finished", ...summary }));
  if (summary.dead > 0) exitCode = 1;
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await closeDB();
}
process.exit(exitCode);
