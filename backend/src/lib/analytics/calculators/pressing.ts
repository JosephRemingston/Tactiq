import { distanceToGoal } from '../../pitch';
import { evidenceOf } from '../evidence';
import { hasStart, isOpenPlayPass, isPpdaDefensiveAction, isTackle, type MatchContext } from '../context';
import type { AEvent, MetricDraft } from '../types';
import { type MetricCalculator, ratio, round } from './calculator';

/** Opponent's own 60% in their frame (x <= 63 m) equals x >= 42 m in ours. */
const OPP_BUILDUP_MAX_X = 63;
const OUR_PRESS_MIN_X = 105 - OPP_BUILDUP_MAX_X;
const HIGH_TURNOVER_DISTANCE_M = 40;
const OPEN_PLAY = new Set(['regular_play', 'from_counter']);

/** PPDA (+ variant with pressures), pressures, pressure regains, high turnovers, defensive action height. */
export class PressingCalculator implements MetricCalculator {
  readonly key = 'pressing';
  readonly version = 1;
  readonly requires = { events: true };
  readonly produces = [
    'pressing.ppda',
    'pressing.ppda_incl_pressures',
    'pressing.pressures',
    'pressing.pressure_regains_5s',
    'pressing.high_turnovers',
    'pressing.shots_after_high_turnover',
    'pressing.defensive_action_height_m',
  ] as const;

  compute(ctx: MatchContext): MetricDraft[] {
    const out: MetricDraft[] = [];
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };

        const oppPasses = v.opp.filter((e) => isOpenPlayPass(e) && hasStart(e) && e.x <= OPP_BUILDUP_MAX_X);
        const defActions = v.own.filter((e) => isPpdaDefensiveAction(e) && hasStart(e) && e.x >= OUR_PRESS_MIN_X);
        const pressuresInZone = v.own.filter((e) => e.typeKey === 'pressure' && hasStart(e) && e.x >= OUR_PRESS_MIN_X);
        const ppda = ratio(oppPasses.length, defActions.length);
        const ppdaP = ratio(oppPasses.length, defActions.length + pressuresInZone.length);
        const ppdaEvidence = (actions: AEvent[]) =>
          evidenceOf(actions, { query: { opponentPasses: { teamId: v.opponentId, types: ['pass'], openPlay: true, maxX: OPP_BUILDUP_MAX_X } }, note: ppda === null ? 'No defensive actions in zone: PPDA undefined.' : undefined });
        out.push({ ...base, metricKey: 'pressing.ppda', value: ppda === null ? null : round(ppda, 2), valueJson: { opponentPasses: oppPasses.length, defensiveActions: defActions.length }, sampleSize: defActions.length, coverageLabel: 'calculated', evidence: ppdaEvidence(defActions) });
        out.push({
          ...base,
          metricKey: 'pressing.ppda_incl_pressures',
          value: ppdaP === null ? null : round(ppdaP, 2),
          valueJson: { opponentPasses: oppPasses.length, defensiveActions: defActions.length, pressures: pressuresInZone.length },
          sampleSize: defActions.length + pressuresInZone.length,
          coverageLabel: 'calculated',
          evidence: ppdaEvidence([...defActions, ...pressuresInZone]),
        });

        const pressures = v.own.filter((e) => e.typeKey === 'pressure');
        out.push({ ...base, metricKey: 'pressing.pressures', value: pressures.length, sampleSize: pressures.length, coverageLabel: 'observed', evidence: evidenceOf(pressures) });
        const regains = pressures.filter((p) => ctx.chains.some((c) => c.teamId === teamId && c.period === p.period && c.startClock > p.clockSeconds && c.startClock <= p.clockSeconds + 5));
        out.push({ ...base, metricKey: 'pressing.pressure_regains_5s', value: regains.length, sampleSize: pressures.length, coverageLabel: 'calculated', evidence: evidenceOf(regains) });

        const high = v.chains.filter((c) => OPEN_PLAY.has(c.playPattern ?? '') && c.firstLocated && distanceToGoal({ x: c.firstLocated.x!, y: c.firstLocated.y! }) <= HIGH_TURNOVER_DISTANCE_M);
        const highShots = high.filter((c) => c.shots.length > 0);
        out.push({ ...base, metricKey: 'pressing.high_turnovers', value: high.length, sampleSize: v.chains.length, coverageLabel: 'calculated', evidence: evidenceOf(high.map((c) => c.firstLocated!), { note: 'first event of each high-turnover possession' }) });
        out.push({ ...base, metricKey: 'pressing.shots_after_high_turnover', value: highShots.length, sampleSize: high.length, coverageLabel: 'calculated', evidence: evidenceOf(highShots.flatMap((c) => c.shots)) });

        const heightActions = v.own.filter((e) => hasStart(e) && (isTackle(e) || ['interception', 'foul_committed', 'ball_recovery', 'pressure'].includes(e.typeKey)));
        const height = ratio(heightActions.reduce((s, e) => s + e.x!, 0), heightActions.length);
        out.push({ ...base, metricKey: 'pressing.defensive_action_height_m', value: height === null ? null : round(height, 1), sampleSize: heightActions.length, coverageLabel: 'calculated', evidence: { eventIds: [], totalEvents: heightActions.length, note: 'Event-based proxy; line height needs tracking.' } });
      }
      // Player-level pressing contribution (full match).
      const full = ctx.view('full', teamId);
      const byPlayer = new Map<string, AEvent[]>();
      for (const e of full.own) if (e.playerId && (e.typeKey === 'pressure' || isPpdaDefensiveAction(e) || e.typeKey === 'ball_recovery')) byPlayer.set(e.playerId, [...(byPlayer.get(e.playerId) ?? []), e]);
      for (const [playerId, evs] of byPlayer) {
        const pressures = evs.filter((e) => e.typeKey === 'pressure');
        out.push({ metricKey: 'pressing.pressures', metricVersion: this.version, scope: 'full', teamId, playerId, minutes: ctx.playerMinutes(playerId), value: pressures.length, sampleSize: pressures.length, coverageLabel: 'observed', evidence: evidenceOf(pressures) });
      }
    }
    return out;
  }
}
