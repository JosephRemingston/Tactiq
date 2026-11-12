import { services } from "../services/index.js";
import { JOB_TYPES, QUEUES, jobIds } from "../queues/constants.js";
import { JobRegistry, JobRunner } from "./runner.js";
import { SyncCompetitionsHandler, SyncMatchesHandler, IngestMatchHandler, NormalizeMatchHandler } from "./ingestion.workers.js";
import { AnalyseMatchHandler } from "./analytics.workers.js";
import { GenerateInsightsHandler, TeamSeasonStyleHandler } from "./insights.workers.js";
import { BillingReconcileHandler, EntitlementsExpireHandler } from "./billing.workers.js";

let instance = null;

/** Builds the job handlers once, registers them by job type and returns the runner that drains the queue. */
export function workers() {
  if (instance) return instance;
  const s = services();
  const registry = new JobRegistry();
  const handlers = [
    new SyncCompetitionsHandler(registry, s.providers, s.rawPayloads, s.writer, s.queues, s.locks, s.config),
    new SyncMatchesHandler(registry, s.providers, s.rawPayloads, s.writer, s.queues, s.db),
    new IngestMatchHandler(registry, s.providers, s.rawPayloads, s.queues, s.db),
    new NormalizeMatchHandler(registry, s.providers, s.rawPayloads, s.writer, s.queues, s.db),
    new AnalyseMatchHandler(registry, s.contextLoader, s.analyticsRepo, s.queues, s.cache, s.config, s.db),
    new GenerateInsightsHandler(registry, s.insights),
    new TeamSeasonStyleHandler(registry, s.insights),
    new BillingReconcileHandler(registry, s.billing),
    new EntitlementsExpireHandler(registry, s.entitlements),
  ];
  for (const handler of handlers) handler.onModuleInit();
  instance = { registry, runner: new JobRunner(s.db, registry, s.config) };
  return instance;
}

/** Queues the once-a-day maintenance jobs. Deterministic ids make repeated calls on the same day a no-op. */
export async function enqueueDailyJobs(now = new Date()) {
  const { queues } = services();
  await queues.enqueue({ queue: QUEUES.billingReconciliation, jobType: JOB_TYPES.billingReconcile, jobId: jobIds.billingReconcile(now), payload: {} });
  await queues.enqueue({ queue: QUEUES.billingReconciliation, jobType: JOB_TYPES.entitlementsExpire, jobId: jobIds.entitlementsExpire(now), payload: {} });
}

export default workers;
