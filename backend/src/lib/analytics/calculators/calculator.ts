import type { MatchContext } from '../context';
import type { CoverageRequirement, MetricDraft } from '../types';

/** One metric family. Pure: reads the match context, returns drafts. Versioned so outputs are traceable. */
export interface MetricCalculator {
  readonly key: string;
  readonly version: number;
  readonly requires: CoverageRequirement;
  readonly produces: readonly string[];
  compute(ctx: MatchContext): MetricDraft[];
}

export const round = (v: number, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;
export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
export const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
