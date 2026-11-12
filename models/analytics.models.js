import { bigint, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid, boolean } from "drizzle-orm/pg-core";
import { pk, timestamps, tz } from "./_common.js";
import { competitions, matches, seasons, teams } from "./football.models.js";
export const SCOPES = ["full", "1H", "2H", "ET", "leading", "drawing", "trailing"];
export const COVERAGE_LABELS = ["observed", "calculated", "inferred"];
export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    key: text().notNull(),
    version: integer().notNull(),
    name: text().notNull(),
    family: text().notNull(),
    unit: text().notNull(),
    direction: text({ enum: ["higher_better", "lower_better", "neutral"] }).notNull(),
    descriptionQuick: text().notNull(),
    descriptionExplore: text().notNull(),
    descriptionAdvanced: text().notNull(),
    formula: text().notNull(),
    requires: jsonb().$type().notNull(),
    coverageLabel: text({ enum: COVERAGE_LABELS }).notNull(),
    providerCaveats: jsonb().$type().notNull(),
    conceptKeys: text().array(),
    status: text({ enum: ["active", "deprecated", "planned"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: pk(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    analyticsVersion: integer().notNull(),
    status: text({ enum: ["running", "complete", "failed"] }).notNull(),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
    calculators: jsonb().$type().notNull(),
    coverageSnapshot: jsonb().$type().notNull(),
    error: text(),
  },
  (t) => [index("analysis_runs_match_idx").on(t.matchId, t.startedAt.desc())],
);
export const tacticalMetrics = pgTable(
  "tactical_metrics",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    analysisRunId: uuid()
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
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
    evidence: jsonb().$type().notNull(),
    computedAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique("tactical_metrics_uq").on(t.matchId, t.metricKey, t.metricVersion, t.scope, t.teamId, t.playerId).nullsNotDistinct(),
    index("tactical_metrics_match_key_idx").on(t.matchId, t.metricKey),
    index("tactical_metrics_team_key_idx").on(t.teamId, t.metricKey, t.metricVersion, t.scope),
    index("tactical_metrics_player_key_idx").on(t.playerId, t.metricKey),
  ],
);
export const POSSESSION_END_TYPES = ["shot", "goal", "turnover", "out", "foul", "half_end", "other"];
export const matchPossessions = pgTable(
  "match_possessions",
  {
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
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
  (t) => [primaryKey({ columns: [t.matchId, t.possessionId] }), index("match_possessions_team_idx").on(t.matchId, t.teamId)],
);
export const insights = pgTable(
  "insights",
  {
    id: pk(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    analysisRunId: uuid()
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    teamId: uuid(),
    playerId: uuid(),
    kind: text().notNull(),
    family: text().notNull(),
    rank: integer(),
    score: doublePrecision().notNull(),
    headline: text().notNull(),
    whatHappened: text().notNull(),
    whyItMatters: text().notNull(),
    evidence: jsonb().$type().notNull(),
    confidence: text({ enum: ["high", "medium", "low"] }).notNull(),
    coverageLabel: text({ enum: COVERAGE_LABELS }).notNull(),
    completeness: doublePrecision().notNull(),
    exploreLink: jsonb().$type().notNull(),
    depth: jsonb().$type().notNull(),
    templateKey: text().notNull(),
    templateVersion: integer().notNull(),
    generatorVersion: integer().notNull(),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique("insights_run_kind_uq").on(t.analysisRunId, t.kind, t.teamId, t.playerId).nullsNotDistinct(),
    index("insights_match_rank_idx").on(t.matchId, t.rank),
  ],
);
export const matchStories = pgTable("match_stories", {
  matchId: uuid()
    .primaryKey()
    .references(() => matches.id, { onDelete: "cascade" }),
  analysisRunId: uuid(),
  kind: text({ enum: ["full", "recap", "unavailable"] }).notNull(),
  shortVersion: text().notNull(),
  teamApproaches: jsonb().$type().notNull(),
  keyPatternInsightIds: uuid().array().notNull(),
  whatChanged: jsonb().$type().notNull(),
  keyPlayers: jsonb().$type().notNull(),
  evidenceLinks: jsonb().$type().notNull(),
  coverageStatement: text().notNull(),
  generatorVersion: integer().notNull(),
  ...timestamps,
});
export const teamSeasonStyles = pgTable(
  "team_season_styles",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id),
    matchesAnalysed: integer().notNull(),
    metrics: jsonb().$type().notNull(),
    labels: jsonb().$type().notNull(),
    analyticsVersion: integer().notNull(),
    computedAt: tz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.seasonId] })],
);
