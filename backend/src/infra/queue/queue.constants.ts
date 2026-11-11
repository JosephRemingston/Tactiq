import { createHash } from 'node:crypto';

/** Queue names from PDF section 12. Only the first four have processors in the MVP. */
export const QUEUES = {
  providerSync: 'provider-sync',
  matchIngestion: 'match-ingestion',
  normalization: 'normalization',
  tacticalAnalytics: 'tactical-analytics',
  trackingEtl: 'tracking-etl',
  patternDiscovery: 'pattern-discovery',
  reportGeneration: 'report-generation',
  videoProcessing: 'video-processing',
  notifications: 'notifications',
  billingReconciliation: 'billing-reconciliation',
  dataRetention: 'data-retention',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const ALL_QUEUES = Object.values(QUEUES) as QueueName[];

export const JOB_TYPES = {
  syncCompetitions: 'sync_competitions',
  syncMatches: 'sync_matches',
  ingestMatch: 'ingest_match',
  normalizeMatch: 'normalize_match',
  analyseMatch: 'analyse_match',
  generateInsights: 'generate_insights',
  teamSeasonStyle: 'team_season_style',
} as const;
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const JOB_SCHEMA_VERSION = 1;

/** PDF section 12 job envelope. Payloads stay small: ids and object-storage keys, never event arrays. */
export interface JobEnvelope<P extends Record<string, unknown> = Record<string, unknown>> {
  job_id: string;
  job_type: JobType;
  requested_by_user_id: string | null;
  scope: 'system' | 'user';
  provider: string | null;
  provider_match_id: string | null;
  match_id: string | null;
  schema_version: number;
  requested_at: string;
  trace_id: string;
  parent_job_id: string | null;
  payload: P;
}

const short = (s: string, n = 12) => createHash('sha256').update(s).digest('hex').slice(0, n);
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Deterministic job ids. BullMQ rejects ':' in custom ids, so segments are joined with '.'.
 * Re-enqueueing the same logical work yields the same id and is a no-op.
 */
export const jobIds = {
  syncCompetitions: (provider: string, at: Date) => `${provider}.competitions.v1.${day(at)}`,
  /** `variant` captures the request scope (match filter, ingest flag) so a narrower sync never swallows a wider one. */
  syncMatches: (provider: string, comp: string, season: string, at: Date, variant = '') => `${provider}.matches.${comp}.${season}.v1.${day(at)}${variant ? `.${short(variant, 8)}` : ''}`,
  ingestMatch: (provider: string, providerMatchId: string, providerVersion: string) => `${provider}.match.${providerMatchId}.v1.${short(providerVersion, 10)}`,
  normalizeMatch: (provider: string, providerMatchId: string, taxonomyVersion: number, rawShaConcat: string) =>
    `normalize.${provider}.${providerMatchId}.t${taxonomyVersion}.${short(rawShaConcat)}`,
  analyseMatch: (matchId: string, analyticsVersion: number, inputVersion: string) => `analytics.${matchId}.v${analyticsVersion}.${short(inputVersion, 10)}`,
  generateInsights: (matchId: string, runId: string) => `insights.${matchId}.run.${runId}`,
  teamSeasonStylePrefix: (teamId: string, seasonId: string, analyticsVersion: number) => `style.${teamId}.${seasonId}.v${analyticsVersion}`,
  teamSeasonStyle: (teamId: string, seasonId: string, analyticsVersion: number, suffix: string) => `style.${teamId}.${seasonId}.v${analyticsVersion}.${suffix}`,
};
