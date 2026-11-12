// Background jobs: atomic claiming under real concurrency, retries, permanent failures, crash recovery with a real
// killed process, idempotent enqueueing and malformed payloads. Each test uses its own job type so it never
// touches the fixture pipeline's jobs.
import { SKIP, startTestApp, TEST_ENV } from "./support/harness.js";
import { describe, it, before, after, expect } from "./support/expect.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("background jobs", { skip: SKIP ?? false }, () => {
  let t;
  let JobRegistry;
  let JobRunner;
  let PermanentJobError;
  let JobQueue;

  before(async () => {
    t = await startTestApp();
    ({ JobRegistry, JobRunner, PermanentJobError } = await import("../workers/runner.js"));
    ({ JobQueue } = await import("../queues/queue.js"));
  });
  after(async () => t?.close());

  const config = () => ({ ...t.services().config, QUEUE_BACKOFF_BASE_MS: 60_000, QUEUE_MAX_ATTEMPTS: 3, WORKER_BUDGET_MS: 60_000 });
  const typeName = () => `test_${randomBytes(5).toString("hex")}`;
  const runnerFor = (jobType, handle) => {
    const registry = new JobRegistry();
    registry.register({ jobType, queue: "test", handle });
    return new JobRunner(t.db, registry, config());
  };
  const insertJobs = async (jobType, n, extra = {}) => {
    const q = new JobQueue(t.db, config());
    const ids = [];
    for (let i = 0; i < n; i++) {
      const jobId = `${jobType}.${i}`;
      await q.enqueue({ queue: "test", jobType, jobId, payload: { i }, ...extra });
      ids.push(jobId);
    }
    return ids;
  };
  const row = async (jobId) => (await t.db.execute(t.sql`select status, attempts, run_after > now() as delayed, last_error, locked_at from ingestion_jobs where job_id = ${jobId}`)).rows[0];

  it("concurrent runners claim every job exactly once", async () => {
    const jobType = typeName();
    const ids = await insertJobs(jobType, 40);
    const seen = [];
    const handle = async (env) => {
      seen.push(env.job_id);
      await new Promise((r) => setTimeout(r, 5));
      return { status: "completed" };
    };
    await Promise.all(Array.from({ length: 6 }, () => runnerFor(jobType, handle).drain({ budgetMs: 30_000 })));
    expect(seen.length).toBe(40);
    expect(new Set(seen).size).toBe(40);
    const { rows } = await t.db.execute(t.sql`select status, count(*)::int as n from ingestion_jobs where job_type = ${jobType} group by status`);
    expect(rows).toEqual([{ status: "completed", n: 40 }]);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("a failing job is retried later with backoff, then dead after its last attempt", async () => {
    const jobType = typeName();
    const [jobId] = await insertJobs(jobType, 1);
    const runner = runnerFor(jobType, async () => {
      throw new Error("provider timed out");
    });
    await runner.drain({ budgetMs: 10_000 });
    expect(await row(jobId)).toMatchObject({ status: "failed", attempts: 1, delayed: true });
    // A second drain right away does not retry it: the backoff is respected.
    await runner.drain({ budgetMs: 10_000 });
    expect((await row(jobId)).attempts).toBe(1);
    for (let i = 0; i < 2; i++) {
      await t.db.execute(t.sql`update ingestion_jobs set run_after = now() where job_id = ${jobId}`);
      await runner.drain({ budgetMs: 10_000 });
    }
    const final = await row(jobId);
    expect(final).toMatchObject({ status: "dead", attempts: 3 });
    expect(final.last_error).toContain("provider timed out");
    await t.db.execute(t.sql`update ingestion_jobs set run_after = now() where job_id = ${jobId}`);
    await runner.drain({ budgetMs: 10_000 });
    expect((await row(jobId)).attempts).toBe(3); // dead jobs are never claimed again
  });

  it("a permanent error (e.g. provider schema drift) goes straight to dead", async () => {
    const jobType = typeName();
    const [jobId] = await insertJobs(jobType, 1);
    await runnerFor(jobType, async () => {
      throw new PermanentJobError("schema changed");
    }).drain({ budgetMs: 10_000 });
    expect(await row(jobId)).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("jobs of types no handler is registered for are never claimed", async () => {
    const jobType = typeName();
    const [jobId] = await insertJobs(jobType, 1);
    await runnerFor(typeName(), async () => ({ status: "completed" })).drain({ budgetMs: 5_000 });
    expect((await row(jobId)).status).toBe("queued");
  });

  it("enqueueing the same job id concurrently creates one job; replay resets a dead job", async () => {
    const jobType = typeName();
    const q = new JobQueue(t.db, config());
    const results = await Promise.all(Array.from({ length: 10 }, () => q.enqueue({ queue: "test", jobType, jobId: `${jobType}.same`, payload: {} })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await t.db.execute(t.sql`update ingestion_jobs set status = 'dead', attempts = 3 where job_id = ${`${jobType}.same`}`);
    await q.replay(`${jobType}.same`);
    expect(await row(`${jobType}.same`)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("REGRESSION F-10: stale locks are recovered; jobs that used their last attempt become dead, not stuck", async () => {
    const jobType = typeName();
    const [retryable, exhausted] = await insertJobs(jobType, 2);
    await t.db.execute(t.sql`update ingestion_jobs set status = 'active', attempts = 1, locked_at = now() - interval '2 hours' where job_id = ${retryable}`);
    await t.db.execute(t.sql`update ingestion_jobs set status = 'active', attempts = 3, max_attempts = 3, locked_at = now() - interval '2 hours' where job_id = ${exhausted}`);
    await runnerFor(typeName(), async () => ({ status: "completed" })).recoverStale();
    expect(await row(retryable)).toMatchObject({ status: "queued", locked_at: null });
    expect(await row(exhausted)).toMatchObject({ status: "dead", locked_at: null });
    // A fresh lock (a worker that is still running) is left alone.
    const [fresh] = await insertJobs(typeName(), 1);
    await t.db.execute(t.sql`update ingestion_jobs set status = 'active', locked_at = now() where job_id = ${fresh}`);
    await runnerFor(typeName(), async () => ({ status: "completed" })).recoverStale();
    expect((await row(fresh)).status).toBe("active");
  });

  it("a worker process killed mid-job leaves a recoverable job that a new worker completes", async () => {
    const jobType = typeName();
    const [jobId] = await insertJobs(jobType, 1);
    const script = `
      const { getDb } = await import(${JSON.stringify(join(import.meta.dirname, "..", "configs", "database.js"))});
      const { JobRegistry, JobRunner } = await import(${JSON.stringify(join(import.meta.dirname, "..", "workers", "runner.js"))});
      const registry = new JobRegistry();
      registry.register({ jobType: ${JSON.stringify(jobType)}, queue: "test", handle: () => { console.log("CLAIMED"); return new Promise(() => {}); } });
      await new JobRunner(getDb(), registry, { QUEUE_BACKOFF_BASE_MS: 60000, WORKER_BUDGET_MS: 600000 }).drain();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...TEST_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child never claimed the job")), 20_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes("CLAIMED")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const orphan = await row(jobId);
    expect(orphan.status).toBe("active");
    expect(orphan.locked_at).not.toBe(null);
    await t.db.execute(t.sql`update ingestion_jobs set locked_at = now() - interval '2 hours' where job_id = ${jobId}`);
    await runnerFor(jobType, async () => ({ status: "completed" })).drain({ budgetMs: 10_000 });
    expect((await row(jobId)).status).toBe("completed");
  });

  it("real handlers survive malformed payloads: the job fails cleanly, nothing is half-written", async () => {
    const { registry } = t.workers();
    const env = (payload) => ({ job_id: "malformed", job_type: "x", payload, trace_id: "t", parent_job_id: null, requested_by_user_id: null });
    const runsBefore = (await t.db.execute(t.sql`select count(*)::int as n from analysis_runs`)).rows[0].n;
    for (const payload of [{}, { matchId: "00000000-0000-7000-8000-000000000000" }, { matchId: "'; drop table matches;--" }, { matchId: null }]) {
      let threw = false;
      try {
        await registry.get("analyse_match").handle(env(payload), { attempt: 1, progress: async () => {} });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
    for (const payload of [{ matchId: t.matchIds["3869685"], runId: "00000000-0000-7000-8000-000000000000" }, { teamId: "x", seasonId: "y" }]) {
      let threw = false;
      try {
        await registry.get(payload.runId ? "generate_insights" : "team_season_style").handle(env(payload), { attempt: 1, progress: async () => {} });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
    expect((await t.db.execute(t.sql`select count(*)::int as n from analysis_runs`)).rows[0].n).toBe(runsBefore);
    expect((await t.db.execute(t.sql`select count(*)::int as n from matches`)).rows[0].n).toBeGreaterThan(0);
  });

  it("re-running analysis for a match replaces its results rather than duplicating them", async () => {
    const match = t.matchIds["8658"];
    const count = async () => (await t.db.execute(t.sql`select (select count(*)::int from tactical_metrics where match_id = ${match}) as m, (select count(*)::int from insights where match_id = ${match}) as i`)).rows[0];
    const before = await count();
    const handler = t.workers().registry.get("analyse_match");
    await handler.handle({ job_id: "rerun", job_type: "analyse_match", payload: { matchId: match }, trace_id: "t", parent_job_id: null, requested_by_user_id: null }, { attempt: 1, progress: async () => {} });
    expect((await count()).m).toBe(before.m);
  });
});
