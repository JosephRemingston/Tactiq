import type { MatchContext } from '../context';
import type { MetricDraft } from '../types';
import type { MetricCalculator } from './calculator';
import { PassingCalculator } from './passing';
import { PlayerCalculator } from './player';
import { PossessionCalculator } from './possession';
import { PressingCalculator } from './pressing';
import { ProgressionCalculator, XtCalculator } from './progression';
import { ShapeCalculator } from './shape';
import { ShootingCalculator } from './shooting';
import { TransitionCalculator } from './transitions';

export const CALCULATORS: readonly MetricCalculator[] = [
  new PossessionCalculator(),
  new PassingCalculator(),
  new ProgressionCalculator(),
  new XtCalculator(),
  new PressingCalculator(),
  new TransitionCalculator(),
  new ShootingCalculator(),
  new ShapeCalculator(),
  new PlayerCalculator(),
];

export interface RunResult {
  drafts: MetricDraft[];
  ran: Record<string, number>;
  skipped: Array<{ key: string; reason: string }>;
}

/** Runs every calculator whose coverage requirement the match meets (PDF: data availability is a runtime capability). */
export function runCalculators(ctx: MatchContext, calculators: readonly MetricCalculator[] = CALCULATORS): RunResult {
  const drafts: MetricDraft[] = [];
  const ran: Record<string, number> = {};
  const skipped: RunResult['skipped'] = [];
  for (const c of calculators) {
    const missing = (['events', 'lineups', 'freezeFrames', 'tracking'] as const).filter((k) => c.requires[k] && !ctx.coverage[k === 'events' ? 'hasEvents' : k === 'lineups' ? 'hasLineups' : k === 'freezeFrames' ? 'hasFreezeFrames' : 'hasTracking']);
    if (missing.length) {
      skipped.push({ key: c.key, reason: `missing ${missing.join(', ')}` });
      continue;
    }
    drafts.push(...c.compute(ctx));
    ran[c.key] = c.version;
  }
  return { drafts, ran, skipped };
}
