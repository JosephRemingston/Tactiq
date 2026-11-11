import type { CoverageLabel, EvidenceJson, ExploreLink, InsightDepth } from '../../../db/schema/analytics';
import type { Scope } from '../types';

export interface StoredMetric {
  metricKey: string;
  metricVersion: number;
  scope: Scope;
  teamId: string | null;
  playerId: string | null;
  value: number | null;
  valueJson: unknown;
  sampleSize: number;
  minutes: number | null;
  coverageLabel: CoverageLabel;
  evidence: EvidenceJson;
}

export interface InsightMeta {
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  teamNames: Record<string, string>;
  playerNames: Record<string, string>;
  homeScore: number | null;
  awayScore: number | null;
  coverage: { hasEvents: boolean; hasLineups: boolean; hasFreezeFrames: boolean; hasTracking: boolean; partial: boolean; eventsCount: number; provider: string | null };
  /** metric key -> formula / caveat text for the Advanced depth. */
  definitions: Record<string, { formula: string; caveat: string | null; name: string }>;
  goals: Array<{ teamId: string; minute: number; playerName: string | null; ownGoal: boolean }>;
}

export interface InsightCandidate {
  kind: string;
  family: string;
  teamId: string | null;
  playerId: string | null;
  salience: number;
  sampleSize: number;
  sampleThreshold: number;
  coverageLabel: CoverageLabel;
  headline: string;
  whatHappened: string;
  whyItMatters: string;
  evidence: EvidenceJson & { metrics: Array<{ key: string; version: number; scope: Scope; value: number | null; teamId?: string | null }> };
  exploreLink: ExploreLink;
  depth: InsightDepth;
  templateKey: string;
}

export interface RankedInsight extends InsightCandidate {
  rank: number;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  completeness: number;
  keyPattern: boolean;
}
