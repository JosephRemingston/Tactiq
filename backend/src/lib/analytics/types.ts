import type { CoverageLabel, EvidenceJson, Scope } from '../../db/schema/analytics';

export type { CoverageLabel, EvidenceJson, Scope };

/** The subset of an event row the analytics engine reads. Coordinates are canonical metres (attacking +x). */
export interface AEvent {
  id: string;
  sequenceIndex: number;
  period: number;
  clockSeconds: number;
  minute: number;
  second: number;
  typeKey: string;
  teamId: string | null;
  playerId: string | null;
  positionName: string | null;
  possessionId: number;
  possessionTeamId: string | null;
  playPattern: string | null;
  x: number | null;
  y: number | null;
  endX: number | null;
  endY: number | null;
  outcome: string | null;
  underPressure: boolean;
  counterpress: boolean;
  duration: number | null;
  detail: Record<string, unknown>;
}

export interface ALineup {
  teamId: string;
  playerId: string;
  playerName: string;
  positionName: string | null;
  positionGroup: 'GK' | 'DEF' | 'MID' | 'FWD' | null;
  isStarter: boolean;
  minuteOn: number | null;
  minuteOff: number | null;
}

export interface AMatchMeta {
  matchId: string;
  competitionId: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number | null;
  awayScore: number | null;
}

export interface ACoverage {
  hasEvents: boolean;
  hasLineups: boolean;
  hasFreezeFrames: boolean;
  hasTracking: boolean;
  partial: boolean;
}

export interface MetricDraft {
  metricKey: string;
  metricVersion: number;
  scope: Scope;
  teamId: string | null;
  playerId: string | null;
  value: number | null;
  valueJson?: unknown;
  sampleSize: number;
  minutes?: number | null;
  coverageLabel: CoverageLabel;
  evidence: EvidenceJson;
}

export interface CoverageRequirement {
  events?: boolean;
  lineups?: boolean;
  freezeFrames?: boolean;
  tracking?: boolean;
}
