import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MatchContext, isGoalShot } from '../../src/lib/analytics/context';
import type { InsightMeta, StoredMetric } from '../../src/lib/analytics/insights/types';
import type { MetricDraft } from '../../src/lib/analytics/types';

const defs = JSON.parse(readFileSync(join(__dirname, '..', '..', 'data', 'metric_definitions.json'), 'utf8')) as Array<{ key: string; name: string; formula: string; providerCaveats: Record<string, string> }>;

export const toStored = (drafts: MetricDraft[]): StoredMetric[] => drafts.map((d) => ({ ...d, valueJson: d.valueJson ?? null, minutes: d.minutes ?? null }));

export function metaFromContext(ctx: MatchContext, coverage: Partial<InsightMeta['coverage']> = {}): InsightMeta {
  return {
    matchId: ctx.meta.matchId,
    homeTeamId: ctx.meta.homeTeamId,
    awayTeamId: ctx.meta.awayTeamId,
    teamNames: { [ctx.meta.homeTeamId]: ctx.meta.homeTeamName, [ctx.meta.awayTeamId]: ctx.meta.awayTeamName },
    playerNames: Object.fromEntries(ctx.lineups.map((l) => [l.playerId, l.playerName])),
    homeScore: ctx.meta.homeScore,
    awayScore: ctx.meta.awayScore,
    coverage: { hasEvents: true, hasLineups: true, hasFreezeFrames: false, hasTracking: false, partial: false, eventsCount: ctx.events.length, provider: 'statsbomb', ...coverage },
    definitions: Object.fromEntries(defs.map((d) => [d.key, { name: d.name, formula: d.formula, caveat: d.providerCaveats.statsbomb ?? null }])),
    goals: ctx.events
      .filter((e) => e.period <= 4 && (isGoalShot(e) || e.typeKey === 'own_goal_for'))
      .map((e) => ({ teamId: e.teamId!, minute: e.minute, playerName: e.playerId ? ctx.playerName(e.playerId) : null, ownGoal: e.typeKey === 'own_goal_for' })),
  };
}
