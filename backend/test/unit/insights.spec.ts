import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCalculators } from '../../src/lib/analytics/calculators';
import { generateInsights } from '../../src/lib/analytics/insights/engine';
import { contextFromStatsBombFiles } from '../../src/lib/analytics/offline';
import { styleLabels, seriesStats } from '../../src/lib/analytics/style';
import { metaFromContext, toStored } from '../support/insight-meta';
import { miniMatch } from '../support/mini-match';

const FIXTURES = join(__dirname, '..', 'fixtures', 'statsbomb');

describe('insight engine on the 2022 final', () => {
  const ctx = contextFromStatsBombFiles(FIXTURES, '43', '106', '3869685');
  const metrics = toStored(runCalculators(ctx).drafts);
  const out = generateInsights(metrics, metaFromContext(ctx));

  it('selects at most three key patterns from distinct families', () => {
    const key = out.insights.filter((i) => i.keyPattern);
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(3);
    expect(new Set(key.map((k) => k.family)).size).toBe(key.length);
    expect(out.insights.map((i) => i.rank)).toEqual(out.insights.map((_, i) => i + 1));
  });

  it('every insight follows the card format and cites evidence', () => {
    for (const i of out.insights) {
      expect(i.headline.length).toBeGreaterThan(10);
      expect(i.whatHappened).toMatch(/\d/);
      expect(i.whyItMatters.length).toBeGreaterThan(10);
      expect(i.evidence.metrics.length).toBeGreaterThan(0);
      expect(i.depth.advanced).toContain('v1');
      expect(['high', 'medium', 'low']).toContain(i.confidence);
    }
  });

  it('writes a full story with result, approaches, changes and players', () => {
    expect(out.story.kind).toBe('full');
    expect(out.story.shortVersion).toContain('Argentina and France drew 3-3 after extra time; Argentina won 4-2 on penalties.');
    expect(out.story.teamApproaches.map((t) => t.formation)).toEqual(['4-3-3', '4-2-3-1']);
    expect(out.story.whatChanged.filter((w) => w.kind === 'goal')).toHaveLength(6);
    expect(out.story.keyPlayers.length).toBeGreaterThan(0);
    expect(out.story.coverageStatement).toContain('Tracking data is not available');
    // Print once for human review of the wording.
    console.log(JSON.stringify({ short: out.story.shortVersion, approaches: out.story.teamApproaches.map((t) => t.summary), patterns: out.insights.filter((i) => i.keyPattern).map((i) => `${i.headline} | ${i.whatHappened}`), players: out.story.keyPlayers.map((p) => p.text) }, null, 2));
  });

  it('is deterministic', () => {
    expect(JSON.stringify(generateInsights(metrics, metaFromContext(ctx)))).toBe(JSON.stringify(out));
  });
});

describe('honest degradation', () => {
  it('produces a recap with no insights when events are missing', () => {
    const ctx = miniMatch();
    const out = generateInsights([], metaFromContext(ctx, { hasEvents: false, eventsCount: 0 }));
    expect(out.insights).toEqual([]);
    expect(out.story.kind).toBe('recap');
    expect(out.story.coverageStatement).toMatch(/cannot be assessed/);
  });

  it('drops model-based insights and lowers confidence for partial coverage', () => {
    const ctx = contextFromStatsBombFiles(FIXTURES, '43', '106', '3869685');
    const out = generateInsights(toStored(runCalculators(ctx).drafts), metaFromContext(ctx, { partial: true }));
    expect(out.insights.every((i) => i.coverageLabel !== 'inferred')).toBe(true);
    expect(out.insights.every((i) => i.confidence === 'low')).toBe(true);
    expect(out.story.coverageStatement).toMatch(/partial/);
  });
});

describe('team season style', () => {
  it('labels only with enough consistent matches', () => {
    const comp = Array.from({ length: 40 }, (_, i) => 5 + i * 0.5);
    const stats = { 'pressing.ppda': seriesStats([6, 6.5, 7, 6.2, 6.8], comp)! };
    expect(styleLabels(stats, 5).map((l) => l.label)).toEqual(['presses high']);
    expect(styleLabels(stats, 4)).toEqual([]);
  });
});
