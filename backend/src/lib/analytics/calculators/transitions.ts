import { evidenceOf } from '../evidence';
import type { MatchContext, PossessionChain } from '../context';
import type { MetricDraft } from '../types';
import { median, type MetricCalculator, ratio, round } from './calculator';

const WINDOWS = [3, 5, 8] as const;
const OPEN_PLAY = new Set(['regular_play', 'from_counter']);

/** Counterpress regains (3/5/8 s), counter-attack shots, regain-to-shot time. */
export class TransitionCalculator implements MetricCalculator {
  readonly key = 'transitions';
  readonly version = 1;
  readonly requires = { events: true };
  readonly produces = ['transition.counterpress_regains', 'transition.counterpress_regain_rate', 'transition.counter_shots', 'transition.regain_to_shot_seconds'] as const;

  compute(ctx: MatchContext): MetricDraft[] {
    const out: MetricDraft[] = [];
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };

        const turnovers = v.chains.filter((c) => c.endType === 'turnover');
        const regainsBy: Record<number, PossessionChain[]> = { 3: [], 5: [], 8: [] };
        for (const lost of turnovers) {
          const oppChain = ctx.nextChainOf(lost, (c) => c.teamId !== teamId);
          if (!oppChain) continue;
          const regain = ctx.nextChainOf(oppChain, (c) => c.teamId === teamId);
          if (!regain) continue;
          const dt = regain.startAbs - oppChain.startAbs;
          for (const w of WINDOWS) if (dt <= w) regainsBy[w]!.push(regain);
        }
        const r5 = regainsBy[5]!;
        const windows = Object.fromEntries(WINDOWS.map((w) => [`${w}s`, regainsBy[w]!.length]));
        out.push({ ...base, metricKey: 'transition.counterpress_regains', value: r5.length, valueJson: { windows, turnovers: turnovers.length }, sampleSize: turnovers.length, coverageLabel: 'calculated', evidence: evidenceOf(r5.map((c) => c.start)) });
        const rate = ratio(r5.length, turnovers.length);
        out.push({
          ...base,
          metricKey: 'transition.counterpress_regain_rate',
          value: rate === null ? null : round(rate * 100, 1),
          valueJson: { windows: Object.fromEntries(WINDOWS.map((w) => [`${w}s`, turnovers.length ? round((regainsBy[w]!.length / turnovers.length) * 100, 1) : null])), turnovers: turnovers.length },
          sampleSize: turnovers.length,
          coverageLabel: 'calculated',
          evidence: evidenceOf(r5.map((c) => c.start)),
        });

        const counterShots = v.chains.filter((c) => c.playPattern === 'from_counter').flatMap((c) => c.shots);
        out.push({ ...base, metricKey: 'transition.counter_shots', value: counterShots.length, sampleSize: counterShots.length, coverageLabel: 'observed', evidence: evidenceOf(counterShots) });

        const shotChains = v.chains.filter((c) => OPEN_PLAY.has(c.playPattern ?? '') && c.shots.length);
        const times = shotChains.map((c) => c.shots[0]!.clockSeconds - c.startClock).filter((t) => t >= 0);
        const med = median(times);
        out.push({ ...base, metricKey: 'transition.regain_to_shot_seconds', value: med === null ? null : round(med, 1), sampleSize: times.length, coverageLabel: 'calculated', evidence: evidenceOf(shotChains.map((c) => c.shots[0]!)) });
      }
    }
    return out;
  }
}
