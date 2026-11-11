import { bigint, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid, boolean } from 'drizzle-orm/pg-core';
import { pk, timestamps, tz } from './_common';
import { competitions, matches, seasons, teams } from './football';

export const SCOPES = ['full', '1H', '2H', 'ET', 'leading', 'drawing', 'trailing'] as const;
export type Scope = (typeof SCOPES)[number];
export const COVERAGE_LABELS = ['observed', 'calculated', 'inferred'] as const;
export type CoverageLabel = (typeof COVERAGE_LABELS)[number];

export interface EvidenceJson {
  eventIds: string[];
  totalEvents: number;
  query?: Record<string, unknown>;
  zones?: string[];
  periods?: number[];
  window?: { period: number; startClock: number; endClock: number };
  note?: string;
}

export const metricDefinitions = pgTable(
  'metric_definitions',
  {
    key: text().notNull(),
    version: integer().notNull(),
    name: text().notNull(),
    family: text().notNull(),
    unit: text().notNull(),
    direction: text({ enum: ['higher_better', 'lower_better', 'neutral'] }).notNull(),
    descriptionQuick: text().notNull(),
    descriptionExplore: text().notNull(),
    descriptionAdvanced: text().notNull(),
    formula: text().notNull(),
    requires: jsonb().$type<{ events?: boolean; lineups?: boolean; freezeFrames?: boolean; tracking?: boolean }>().notNull(),
    coverageLabel: text({ enum: COVERAGE_LABELS }).notNull(),
    providerCaveats: jsonb().$type<Record<string, string>>().notNull(),
    conceptKeys: text().array(),
    status: text({ enum: ['active', 'deprecated', 'planned'] }).notNull().default('active'),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);

export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: pk(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    analyticsVersion: integer().notNull(),
    status: text({ enum: ['running', 'complete', 'failed'] }).notNull(),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
    calculators: jsonb().$type<Record<string, number>>().notNull(),
    coverageSnapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    error: text(),
  },
  (t) => [index('analysis_runs_match_idx').on(t.matchId, t.startedAt.desc())],
);

export const tacticalMetrics = pgTable(
  'tactical_metrics',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    analysisRunId: uuid()
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    teamId: uuid(),
    playerId: uuid(),
    metricKey: text().notNull(),
    metricVersion: integer().notNull(),
    scope: text({ enum: SCOPES }).notNull(),
    value: doublePrecision(),
    valueJson: jsonb(),
    sampleSize: integer().notNull(),
    minutes: doublePrecision(),
    coverageLabel: text({ enum: COVERAGE_LABELS }).notNull(),
    evidence: jsonb().$type<EvidenceJson>().notNull(),
    computedAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique('tactical_metrics_uq').on(t.matchId, t.metricKey, t.metricVersion, t.scope, t.teamId, t.playerId).nullsNotDistinct(),
    index('tactical_metrics_match_key_idx').on(t.matchId, t.metricKey),
    index('tactical_metrics_team_key_idx').on(t.teamId, t.metricKey, t.metricVersion, t.scope),
    index('tactical_metrics_player_key_idx').on(t.playerId, t.metricKey),
  ],
);

export const POSSESSION_END_TYPES = ['shot', 'goal', 'turnover', 'out', 'foul', 'half_end', 'other'] as const;

export const matchPossessions = pgTable(
  'match_possessions',
  {
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    possessionId: integer().notNull(),
    teamId: uuid(),
    period: integer().notNull(),
    startEventId: uuid().notNull(),
    endEventId: uuid().notNull(),
    startClock: doublePrecision().notNull(),
    endClock: doublePrecision().notNull(),
    startX: doublePrecision(),
    startY: doublePrecision(),
    endType: text({ enum: POSSESSION_END_TYPES }).notNull(),
    nEvents: integer().notNull(),
    nPasses: integer().notNull(),
    reachedFinalThird: boolean().notNull(),
    reachedBox: boolean().notNull(),
    xtNet: doublePrecision().notNull(),
    xgTotal: doublePrecision().notNull(),
    playPattern: text(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.possessionId] }), index('match_possessions_team_idx').on(t.matchId, t.teamId)],
);

export interface InsightDepth {
  quick: string;
  explore: string;
  advanced: string;
}
export interface ExploreLink {
  view: 'pressing' | 'passing-network' | 'shot-map' | 'timeline' | 'player' | 'progression' | 'shape';
  matchId: string;
  teamId?: string;
  playerId?: string;
  scope?: Scope;
  metricKeys: string[];
}

export const insights = pgTable(
  'insights',
  {
    id: pk(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    analysisRunId: uuid()
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    teamId: uuid(),
    playerId: uuid(),
    kind: text().notNull(),
    family: text().notNull(),
    rank: integer(),
    score: doublePrecision().notNull(),
    headline: text().notNull(),
    whatHappened: text().notNull(),
    whyItMatters: text().notNull(),
    evidence: jsonb().$type<EvidenceJson & { metrics: Array<{ key: string; version: number; scope: Scope; value: number | null; teamId?: string | null }> }>().notNull(),
    confidence: text({ enum: ['high', 'medium', 'low'] }).notNull(),
    coverageLabel: text({ enum: COVERAGE_LABELS }).notNull(),
    completeness: doublePrecision().notNull(),
    exploreLink: jsonb().$type<ExploreLink>().notNull(),
    depth: jsonb().$type<InsightDepth>().notNull(),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    generatorVersion: integer().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique('insights_run_kind_uq').on(t.analysisRunId, t.kind, t.teamId, t.playerId).nullsNotDistinct(),
    index('insights_match_rank_idx').on(t.matchId, t.rank),
  ],
);

export const matchStories = pgTable('match_stories', {
  matchId: uuid()
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  analysisRunId: uuid(),
  kind: text({ enum: ['full', 'recap', 'unavailable'] }).notNull(),
  shortVersion: text().notNull(),
  teamApproaches: jsonb().$type<Array<{ teamId: string; teamName: string; formation: string | null; summary: string; labels: string[] }>>().notNull(),
  keyPatternInsightIds: uuid().array().notNull(),
  whatChanged: jsonb().$type<Array<{ kind: string; minute: number | null; text: string; insightId?: string }>>().notNull(),
  keyPlayers: jsonb().$type<Array<{ playerId: string; playerName: string; teamId: string; role: string | null; text: string }>>().notNull(),
  evidenceLinks: jsonb().$type<string[]>().notNull(),
  coverageStatement: text().notNull(),
  generatorVersion: integer().notNull(),
  ...timestamps,
});

export const teamSeasonStyles = pgTable(
  'team_season_styles',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id),
    matchesAnalysed: integer().notNull(),
    metrics: jsonb().$type<Record<string, { median: number; p25: number; p75: number; n: number; competitionPercentile: number | null }>>().notNull(),
    labels: jsonb().$type<Array<{ label: string; metricKey: string; percentile: number | null; sample: number }>>().notNull(),
    analyticsVersion: integer().notNull(),
    computedAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.seasonId] })],
);

