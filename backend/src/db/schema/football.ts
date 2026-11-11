import { sql } from 'drizzle-orm';
import { boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pk, timestamps, tz } from './_common';

export const PROVIDERS = ['statsbomb', 'sportmonks'] as const;
export type ProviderKey = (typeof PROVIDERS)[number];

export const dataLicences = pgTable('data_licences', {
  id: text().primaryKey(),
  provider: text({ enum: PROVIDERS }).notNull(),
  name: text().notNull(),
  url: text().notNull(),
  termsSummary: text().notNull(),
  attributionText: text().notNull(),
  commercialUseAllowed: boolean().notNull(),
  ...timestamps,
});

export const competitions = pgTable(
  'competitions',
  {
    id: pk(),
    name: text().notNull(),
    countryName: text(),
    gender: text({ enum: ['male', 'female'] }),
    isYouth: boolean().notNull().default(false),
    isInternational: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [index('competitions_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`)],
);

export const seasons = pgTable(
  'seasons',
  {
    id: pk(),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    startDate: date(),
    endDate: date(),
    ...timestamps,
  },
  (t) => [unique('seasons_competition_name_uq').on(t.competitionId, t.name)],
);

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    name: text().notNull(),
    shortName: text(),
    countryName: text(),
    gender: text({ enum: ['male', 'female'] }),
    isNationalTeam: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [index('teams_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`)],
);

export const players = pgTable(
  'players',
  {
    id: pk(),
    fullName: text().notNull(),
    knownName: text(),
    birthDate: date(),
    countryName: text(),
    primaryPosition: text(),
    ...timestamps,
  },
  (t) => [
    index('players_full_name_trgm').using('gin', sql`${t.fullName} gin_trgm_ops`),
    index('players_known_name_trgm').using('gin', sql`${t.knownName} gin_trgm_ops`),
  ],
);

export const playerTeamAssignments = pgTable(
  'player_team_assignments',
  {
    id: pk(),
    playerId: uuid()
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    jerseyNumber: integer(),
    source: text().notNull(),
    ...timestamps,
  },
  (t) => [unique('pta_player_team_season_uq').on(t.playerId, t.teamId, t.seasonId), index('pta_team_season_idx').on(t.teamId, t.seasonId)],
);

export const MATCH_STATUSES = ['scheduled', 'played', 'postponed', 'cancelled'] as const;
export const ANALYSIS_STATUSES = ['none', 'queued', 'running', 'complete', 'failed'] as const;

export const matches = pgTable(
  'matches',
  {
    id: pk(),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id),
    seasonId: uuid()
      .notNull()
      .references(() => seasons.id),
    homeTeamId: uuid()
      .notNull()
      .references(() => teams.id),
    awayTeamId: uuid()
      .notNull()
      .references(() => teams.id),
    kickoffAt: tz().notNull(),
    matchDate: date().notNull(),
    status: text({ enum: MATCH_STATUSES }).notNull().default('scheduled'),
    homeScore: integer(),
    awayScore: integer(),
    matchWeek: integer(),
    stage: text(),
    stadiumName: text(),
    refereeName: text(),
    pitchLengthM: doublePrecision().notNull().default(105),
    pitchWidthM: doublePrecision().notNull().default(68),
    analysisStatus: text({ enum: ANALYSIS_STATUSES }).notNull().default('none'),
    analysisRunId: uuid(),
    analyticsVersion: integer(),
    analysedAt: tz(),
    ...timestamps,
  },
  (t) => [
    unique('matches_natural_uq').on(t.competitionId, t.seasonId, t.homeTeamId, t.awayTeamId, t.matchDate),
    index('matches_comp_season_kickoff_idx').on(t.competitionId, t.seasonId, t.kickoffAt.desc(), t.id.desc()),
    index('matches_home_kickoff_idx').on(t.homeTeamId, t.kickoffAt.desc()),
    index('matches_away_kickoff_idx').on(t.awayTeamId, t.kickoffAt.desc()),
    index('matches_kickoff_idx').on(t.kickoffAt.desc(), t.id.desc()),
  ],
);

export const matchParticipants = pgTable(
  'match_participants',
  {
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    side: text({ enum: ['home', 'away'] }).notNull(),
    startingFormation: text(),
    managerName: text(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.matchId, t.teamId] }), unique('match_participants_side_uq').on(t.matchId, t.side)],
);

export interface DataQualityReport {
  missingLocationPct: number;
  eventsWithoutPlayer: number;
  periodsPresent: number[];
  hasExtraTime: boolean;
  hasShootout: boolean;
  unknownTypeNames: string[];
  xgSource: string | null;
  partial: boolean;
  notes: string[];
}

/** What data exists for a match. The API exposes this so clients never imply data that is absent. */
export const matchCoverage = pgTable('match_coverage', {
  matchId: uuid()
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  hasLineups: boolean().notNull().default(false),
  hasEvents: boolean().notNull().default(false),
  hasFreezeFrames: boolean().notNull().default(false),
  hasTracking: boolean().notNull().default(false),
  hasVideo: boolean().notNull().default(false),
  eventProvider: text({ enum: PROVIDERS }),
  eventSchemaVersion: text(),
  taxonomyVersion: integer(),
  eventsCount: integer().notNull().default(0),
  freezeFrameCount: integer().notNull().default(0),
  providerLastUpdatedAt: tz(),
  providerLastUpdated360At: tz(),
  provider360Status: text(),
  licenceId: text().references(() => dataLicences.id),
  retrievedAt: tz(),
  dataQuality: jsonb().$type<DataQualityReport>(),
  ...timestamps,
});

export const lineups = pgTable(
  'lineups',
  {
    id: pk(),
    matchId: uuid()
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    teamId: uuid()
      .notNull()
      .references(() => teams.id),
    playerId: uuid()
      .notNull()
      .references(() => players.id),
    jerseyNumber: integer(),
    positionName: text(),
    positionGroup: text({ enum: ['GK', 'DEF', 'MID', 'FWD'] }),
    isStarter: boolean().notNull().default(false),
    minuteOn: integer(),
    minuteOff: integer(),
    cards: jsonb().$type<Array<{ minute: number; type: string; reason?: string }>>(),
    ...timestamps,
  },
  (t) => [unique('lineups_match_team_player_uq').on(t.matchId, t.teamId, t.playerId), index('lineups_match_idx').on(t.matchId)],
);

export const ENTITY_TYPES = ['competition', 'season', 'team', 'player', 'match'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const providerEntityMaps = pgTable(
  'provider_entity_maps',
  {
    id: pk(),
    provider: text({ enum: PROVIDERS }).notNull(),
    entityType: text({ enum: ENTITY_TYPES }).notNull(),
    providerEntityId: text().notNull(),
    canonicalId: uuid().notNull(),
    providerName: text(),
    firstSeenAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
  },
  (t) => [
    unique('provider_entity_maps_uq').on(t.provider, t.entityType, t.providerEntityId),
    index('provider_entity_maps_canonical_idx').on(t.entityType, t.canonicalId),
  ],
);

export const PAYLOAD_KINDS = ['competitions', 'matches', 'lineups', 'events', 'three_sixty'] as const;
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: pk(),
    provider: text({ enum: PROVIDERS }).notNull(),
    payloadKind: text({ enum: PAYLOAD_KINDS }).notNull(),
    scopeKey: text().notNull(),
    objectKey: text().notNull(),
    sha256: text().notNull(),
    byteSize: integer().notNull(),
    etag: text(),
    sourceUrl: text().notNull(),
    retrievedAt: tz().notNull(),
    schemaVersion: text().notNull(),
    licenceId: text().references(() => dataLicences.id),
    isLatest: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('raw_payloads_sha_uq').on(t.provider, t.payloadKind, t.scopeKey, t.sha256),
    uniqueIndex('raw_payloads_latest_uq').on(t.provider, t.payloadKind, t.scopeKey).where(sql`is_latest = true`),
  ],
);

export const providerSyncState = pgTable(
  'provider_sync_state',
  {
    provider: text({ enum: PROVIDERS }).notNull(),
    scopeKey: text().notNull(),
    lastSyncedAt: tz(),
    lastSeenSha256: text(),
    lastProviderUpdatedAt: tz(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.scopeKey] })],
);

/** Searchable tactical glossary (PDF §4.11). */
export const tacticalConcepts = pgTable('tactical_concepts', {
  key: text().primaryKey(),
  name: text().notNull(),
  category: text().notNull(),
  simpleText: text().notNull(),
  exploreText: text().notNull(),
  advancedText: text().notNull(),
  misconceptions: text(),
  relatedKeys: text().array().notNull().default(sql`'{}'::text[]`),
  linkedMetricKeys: text().array().notNull().default(sql`'{}'::text[]`),
  ...timestamps,
});
