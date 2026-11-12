// Builds every service once per process and hands them their dependencies.
// Controllers and workers import `services()` and never construct a service themselves.
import { getEnv } from "../configs/env.js";
import { getDb } from "../configs/database.js";
import { cache, locks } from "../configs/redis.js";
import { getStorage } from "../configs/s3.js";
import { identity } from "../configs/clerk.js";
import { JobQueue } from "../queues/queue.js";
import { EntitlementsService } from "./entitlements.service.js";
import { SecurityEventsService } from "./securityEvents.service.js";
import { UsersService } from "./users.service.js";
import { FootballService } from "./football.service.js";
import { PersonalService } from "./personal.service.js";
import { PgAnalyticsRepository } from "./analyticsRepository.service.js";
import { MatchContextLoader } from "./matchContext.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { InsightsService } from "./insights.service.js";
import { JobsService } from "./jobs.service.js";
import { IngestionService } from "./ingestion.service.js";
import { CanonicalWriter } from "./canonicalWriter.service.js";
import { RawPayloadStore } from "./rawPayload.service.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ProviderRateLimiter } from "./providers/rateLimiter.js";
import { BillingService } from "./billing.service.js";
import { AdsService } from "./ads.service.js";
import { getPurchaseVerifier } from "../configs/googlePlay.js";

let instance = null;

export function services() {
  if (instance) return instance;
  const config = getEnv();
  const db = getDb();
  const queues = new JobQueue(db, config);

  const entitlements = new EntitlementsService(db, cache);
  const security = new SecurityEventsService(db);
  const users = new UsersService(db, identity, cache, entitlements, security);
  const football = new FootballService(db, cache, config);
  const personal = new PersonalService(db, entitlements, football);
  const analyticsRepo = new PgAnalyticsRepository(db);
  const contextLoader = new MatchContextLoader(db);
  const analytics = new AnalyticsService(db, analyticsRepo, cache, football);
  const insights = new InsightsService(db, analyticsRepo, contextLoader, cache);
  const jobs = new JobsService(db, queues, entitlements);
  const ingestion = new IngestionService(queues, db);
  const writer = new CanonicalWriter(db, config);
  const rawPayloads = new RawPayloadStore(db, getStorage());
  const providers = new ProviderRegistry(config, new ProviderRateLimiter(config));
  const billing = new BillingService(db, entitlements, security, getPurchaseVerifier(), config);
  const ads = new AdsService(entitlements, config);

  instance = {
    config,
    db,
    cache,
    locks,
    identity,
    queues,
    entitlements,
    security,
    users,
    football,
    personal,
    analyticsRepo,
    contextLoader,
    analytics,
    insights,
    jobs,
    ingestion,
    writer,
    rawPayloads,
    providers,
    billing,
    ads,
  };
  return instance;
}

/** Test hook: drop the singletons so the next call rebuilds them (after changing env or the database). */
export function resetServices() {
  instance = null;
}

export default services;
