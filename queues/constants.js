import { createHash } from "node:crypto";
/** Queue names from PDF section 12 (a label on each job row; all jobs share the ingestion_jobs table). */
export const QUEUES = {
  providerSync: "provider-sync",
  matchIngestion: "match-ingestion",
  normalization: "normalization",
  tacticalAnalytics: "tactical-analytics",
  trackingEtl: "tracking-etl",
  patternDiscovery: "pattern-discovery",
  reportGeneration: "report-generation",
  videoProcessing: "video-processing",
  notifications: "notifications",
  billingReconciliation: "billing-reconciliation",
  dataRetention: "data-retention",
};
export const ALL_QUEUES = Object.values(QUEUES);
export const JOB_TYPES = {
  syncCompetitions: "sync_competitions",
  syncMatches: "sync_matches",
  ingestMatch: "ingest_match",
  normalizeMatch: "normalize_match",
  analyseMatch: "analyse_match",
  generateInsights: "generate_insights",
  teamSeasonStyle: "team_season_style",
  billingReconcile: "billing_reconcile",
  entitlementsExpire: "entitlements_expire",
};
export const JOB_SCHEMA_VERSION = 1;
const short = (s, n = 12) => createHash("sha256").update(s).digest("hex").slice(0, n);
const day = (d) => d.toISOString().slice(0, 10);
/**
 * Deterministic job ids, segments joined with '.'.
 * Re-enqueueing the same logical work yields the same id and is a no-op.
 */
export const jobIds = {
  syncCompetitions: (provider, at) => `${provider}.competitions.v1.${day(at)}`,
  /** `variant` captures the request scope (match filter, ingest flag) so a narrower sync never swallows a wider one. */
  syncMatches: (provider, comp, season, at, variant = "") =>
    `${provider}.matches.${comp}.${season}.v1.${day(at)}${variant ? `.${short(variant, 8)}` : ""}`,
  ingestMatch: (provider, providerMatchId, providerVersion) => `${provider}.match.${providerMatchId}.v1.${short(providerVersion, 10)}`,
  normalizeMatch: (provider, providerMatchId, taxonomyVersion, rawShaConcat) =>
    `normalize.${provider}.${providerMatchId}.t${taxonomyVersion}.${short(rawShaConcat)}`,
  analyseMatch: (matchId, analyticsVersion, inputVersion) => `analytics.${matchId}.v${analyticsVersion}.${short(inputVersion, 10)}`,
  generateInsights: (matchId, runId) => `insights.${matchId}.run.${runId}`,
  teamSeasonStylePrefix: (teamId, seasonId, analyticsVersion) => `style.${teamId}.${seasonId}.v${analyticsVersion}`,
  teamSeasonStyle: (teamId, seasonId, analyticsVersion, suffix) => `style.${teamId}.${seasonId}.v${analyticsVersion}.${suffix}`,
  billingReconcile: (at) => `billing.reconcile.${day(at)}`,
  entitlementsExpire: (at) => `entitlements.expire.${day(at)}`,
};
