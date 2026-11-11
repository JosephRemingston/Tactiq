import type { DataQualityReport } from '../../db/schema/football';

export type ProviderKey = 'statsbomb' | 'sportmonks';

export interface ProviderCapabilities {
  lineups: boolean;
  events: boolean;
  freezeFrames: 'none' | 'partial' | 'full';
  tracking: boolean;
  video: boolean;
  xg: 'none' | 'provider';
  live: boolean;
  coordinateSystem: { length: number; width: number; perTeamNormalized: boolean };
  licenceId: string;
}

export type PayloadKind = 'competitions' | 'matches' | 'lineups' | 'events' | 'three_sixty';

export interface RawPayload {
  provider: ProviderKey;
  kind: PayloadKind;
  scopeKey: string;
  bytes: Buffer;
  sha256: string;
  sourceUrl: string;
  etag: string | null;
  retrievedAt: Date;
  schemaVersion: string;
  licenceId: string;
  notModified: boolean;
}

export interface FetchOptions {
  etag?: string | null;
}

/** Fetching only. Adapters never touch the database; normalization is a separate, replayable step. */
export interface ProviderAdapter {
  readonly provider: ProviderKey;
  capabilities(): ProviderCapabilities;
  listCompetitions(opts?: FetchOptions): Promise<RawPayload>;
  listMatches(ref: { providerCompetitionId: string; providerSeasonId: string }, opts?: FetchOptions): Promise<RawPayload>;
  getLineups(providerMatchId: string, opts?: FetchOptions): Promise<RawPayload>;
  getEvents(providerMatchId: string, opts?: FetchOptions): Promise<RawPayload>;
  /** null = the provider has no freeze-frame file for this match. */
  getFreezeFrames(providerMatchId: string, opts?: FetchOptions): Promise<RawPayload | null>;
  readonly normalizer: ProviderNormalizer;
}

export class ProviderNotConfiguredError extends Error {
  override readonly name = 'ProviderNotConfiguredError';
}
export class ProviderSchemaError extends Error {
  override readonly name = 'ProviderSchemaError';
}

// ---- Canonical DTOs (provider ids, not yet resolved to Touchline UUIDs) ----

export interface ProviderRef {
  id: string;
  name: string;
}

export interface CanonicalCompetitionSeason {
  competition: ProviderRef & { countryName: string | null; gender: 'male' | 'female' | null; isYouth: boolean; isInternational: boolean };
  season: ProviderRef;
  matchesUpdatedAt: Date | null;
}

export interface CanonicalTeam extends ProviderRef {
  countryName: string | null;
  gender: 'male' | 'female' | null;
  isNationalTeam: boolean;
  managerName: string | null;
}

export interface CanonicalMatch {
  ref: ProviderRef;
  competition: ProviderRef;
  season: ProviderRef;
  home: CanonicalTeam;
  away: CanonicalTeam;
  kickoffAt: Date;
  matchDate: string;
  status: 'scheduled' | 'played';
  homeScore: number | null;
  awayScore: number | null;
  matchWeek: number | null;
  stage: string | null;
  stadiumName: string | null;
  refereeName: string | null;
  providerUpdatedAt: Date | null;
  providerUpdated360At: Date | null;
  freezeFrameStatus: string | null;
}

export interface CanonicalPlayer extends ProviderRef {
  knownName: string | null;
  countryName: string | null;
}

export interface CanonicalLineup {
  team: ProviderRef;
  player: CanonicalPlayer;
  jerseyNumber: number | null;
  positionName: string | null;
  positionGroup: 'GK' | 'DEF' | 'MID' | 'FWD' | null;
  isStarter: boolean;
  minuteOn: number | null;
  minuteOff: number | null;
  cards: Array<{ minute: number; type: string; reason?: string }>;
}

/**
 * Event in canonical coordinates. `detail` holds type-specific fields; player references inside it use
 * `...ProviderPlayerId` keys which ingestion rewrites to Touchline UUIDs (`...PlayerId`).
 */
export interface CanonicalEvent {
  providerEventId: string;
  sequenceIndex: number;
  period: number;
  clockSeconds: number;
  minute: number;
  second: number;
  typeKey: string;
  providerTypeName: string;
  teamProviderId: string | null;
  playerProviderId: string | null;
  positionName: string | null;
  possessionId: number;
  possessionTeamProviderId: string | null;
  playPattern: string | null;
  x: number | null;
  y: number | null;
  endX: number | null;
  endY: number | null;
  rawX: number | null;
  rawY: number | null;
  rawEndX: number | null;
  rawEndY: number | null;
  outcome: string | null;
  underPressure: boolean;
  counterpress: boolean;
  duration: number | null;
  relatedProviderEventIds: string[];
  detail: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface CanonicalFreezeFrame {
  providerEventId: string;
  visibleArea: Array<[number, number]>;
  frame: Array<{ x: number; y: number; teammate: boolean; actor: boolean; keeper: boolean }>;
}

export interface NormalizedEvents {
  events: CanonicalEvent[];
  quality: DataQualityReport;
}

export interface ProviderNormalizer {
  readonly provider: ProviderKey;
  readonly taxonomyVersion: number;
  readonly schemaVersion: string;
  normalizeCompetitions(raw: unknown): CanonicalCompetitionSeason[];
  normalizeMatches(raw: unknown): CanonicalMatch[];
  normalizeLineups(raw: unknown): CanonicalLineup[];
  normalizeEvents(raw: unknown): NormalizedEvents;
  normalizeFreezeFrames(raw: unknown): CanonicalFreezeFrame[];
}
