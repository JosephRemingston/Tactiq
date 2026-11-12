/**
 * Team season style (PDF 4.11 "Team tactical identity"): plain labels backed by medians, spread and percentiles.
 * Labels appear only with enough matches and a consistent pattern; the sample size is always reported.
 */
export const STYLE_MIN_MATCHES = 5;
const MAX_SPREAD = 0.6;
export function quantile(sorted, q) {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function seriesStats(values, competition) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const median = quantile(v, 0.5);
  const comp = competition.filter((x) => Number.isFinite(x));
  const competitionPercentile = comp.length >= 10 ? Math.round((comp.filter((x) => x < median).length / comp.length) * 100) : null;
  const r = (x) => Math.round(x * 1000) / 1000;
  return { median: r(median), p25: r(quantile(v, 0.25)), p75: r(quantile(v, 0.75)), n: v.length, competitionPercentile };
}
const RULES = [
  { key: "pressing.ppda", low: "presses high", high: "sits deeper without the ball" },
  { key: "possession.share", high: "dominates the ball", low: "comfortable without the ball" },
  { key: "possession.avg_chain_passes", high: "builds patiently", low: "plays directly" },
  { key: "shooting.xg_per_shot", high: "creates high-quality chances" },
  { key: "transition.counterpress_regain_rate", high: "wins the ball back quickly after losing it" },
  { key: "transition.counter_shots", high: "attacks quickly after regaining the ball" },
  { key: "pressing.high_turnovers", high: "wins the ball high up the pitch" },
];
export function styleLabels(stats, matches) {
  if (matches < STYLE_MIN_MATCHES) return [];
  const labels = [];
  for (const rule of RULES) {
    const s = stats[rule.key];
    if (!s || s.competitionPercentile === null) continue;
    const spread = Math.abs(s.median) > 1e-9 ? (s.p75 - s.p25) / Math.abs(s.median) : Infinity;
    if (spread > MAX_SPREAD) continue;
    if (rule.high && s.competitionPercentile >= 70)
      labels.push({ label: rule.high, metricKey: rule.key, percentile: s.competitionPercentile, sample: s.n });
    if (rule.low && s.competitionPercentile <= 30)
      labels.push({ label: rule.low, metricKey: rule.key, percentile: s.competitionPercentile, sample: s.n });
  }
  return labels;
}
export const STYLE_METRICS = RULES.map((r) => r.key).concat([
  "possession.xt_added",
  "possession.box_entries",
  "shooting.xg",
  "buildup.success_rate",
]);
