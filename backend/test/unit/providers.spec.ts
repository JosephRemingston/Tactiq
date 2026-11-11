import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { statsBombToCanonical } from '../../src/lib/pitch';
import { type ProviderAdapter, ProviderNotConfiguredError, ProviderSchemaError } from '../../src/lib/providers/provider';
import { SportmonksAdapter } from '../../src/lib/providers/sportmonks/adapter';
import { StatsBombOpenDataAdapter } from '../../src/lib/providers/statsbomb/adapter';
import { StatsBombNormalizer } from '../../src/lib/providers/statsbomb/normalizer';
import { LocalDirTransport } from '../../src/lib/providers/statsbomb/transport';

const FIXTURES = join(__dirname, '..', 'fixtures', 'statsbomb');
const json = (p: string) => JSON.parse(readFileSync(join(FIXTURES, p), 'utf8')) as unknown;
const FINAL_2022 = '3869685';
const FINAL_2018 = '8658';

/** Every adapter must expose the same contract, whatever the provider. */
function adapterContract(name: string, make: () => ProviderAdapter) {
  describe(`${name} adapter contract`, () => {
    it('declares capabilities with a licence id and coordinate system', () => {
      const caps = make().capabilities();
      expect(caps.licenceId).toBeTruthy();
      expect(caps.coordinateSystem.length).toBeGreaterThan(0);
      expect(typeof caps.tracking).toBe('boolean');
    });
    it('implements every fetch method', () => {
      const a = make();
      for (const m of ['listCompetitions', 'listMatches', 'getLineups', 'getEvents', 'getFreezeFrames'] as const) expect(typeof a[m]).toBe('function');
    });
  });
}

adapterContract('StatsBomb', () => new StatsBombOpenDataAdapter(new LocalDirTransport(FIXTURES)));
adapterContract('Sportmonks', () => new SportmonksAdapter(undefined));

describe('StatsBomb adapter (local transport)', () => {
  const adapter = new StatsBombOpenDataAdapter(new LocalDirTransport(FIXTURES));

  it('returns raw payloads with hash, etag and licence', async () => {
    const p = await adapter.listCompetitions();
    expect(p.kind).toBe('competitions');
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.licenceId).toBe('statsbomb-open-data');
    expect(p.notModified).toBe(false);
    const again = await adapter.listCompetitions({ etag: p.etag });
    expect(again.notModified).toBe(true);
  });

  it('treats a missing three-sixty file as absent, not an error', async () => {
    expect(await adapter.getFreezeFrames(FINAL_2018)).toBeNull();
    expect(await adapter.getFreezeFrames(FINAL_2022)).not.toBeNull();
  });

  it('fails loudly for missing required payloads', async () => {
    await expect(adapter.getEvents('999999999')).rejects.toThrow(/not found/);
  });
});

describe('Sportmonks stub', () => {
  it('fails with ProviderNotConfiguredError until implemented', async () => {
    const a = new SportmonksAdapter(undefined);
    await expect(a.listCompetitions()).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(a.getEvents('1')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

describe('pitch landmark mapping (StatsBomb 120x80 -> 105x68 m)', () => {
  it('maps goal, box and halfway landmarks exactly', () => {
    expect(statsBombToCanonical(120, 40)).toEqual({ x: 105, y: 34 });
    expect(statsBombToCanonical(102, 18)).toEqual({ x: 88.5, y: 13.84 });
    expect(statsBombToCanonical(60, 62)).toEqual({ x: 52.5, y: 54.16 });
    expect(statsBombToCanonical(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('StatsBomb normalizer', () => {
  const n = new StatsBombNormalizer();

  it('normalizes competitions', () => {
    const comps = n.normalizeCompetitions(json('competitions.json'));
    const wc = comps.find((c) => c.competition.id === '43' && c.season.id === '106');
    expect(wc?.competition.name).toBe('FIFA World Cup');
    expect(wc?.season.name).toBe('2022');
    expect(wc?.competition.isInternational).toBe(true);
  });

  it('normalizes matches including the 2022 final', () => {
    const matches = n.normalizeMatches(json('matches/43/106.json'));
    const final = matches.find((m) => m.ref.id === FINAL_2022)!;
    expect(final.home.name).toBe('Argentina');
    expect(final.away.name).toBe('France');
    expect([final.homeScore, final.awayScore]).toEqual([3, 3]);
    expect(final.status).toBe('played');
    expect(final.stage).toBe('Final');
    expect(final.home.isNationalTeam).toBe(true);
    expect(final.freezeFrameStatus).toBe('available');
  });

  it('normalizes lineups with starters and substitutes', () => {
    const lineups = n.normalizeLineups(json(`lineups/${FINAL_2022}.json`));
    const byTeam = (name: string) => lineups.filter((l) => l.team.name === name);
    expect(byTeam('Argentina').filter((l) => l.isStarter)).toHaveLength(11);
    expect(byTeam('France').filter((l) => l.isStarter)).toHaveLength(11);
    const thuram = lineups.find((l) => l.player.name === 'Marcus Thuram')!;
    expect(thuram.isStarter).toBe(false);
    expect(thuram.minuteOn).toBe(41);
    expect(thuram.cards[0]?.type).toBe('yellow_card');
    expect(lineups.find((l) => l.positionName === 'Goalkeeper')?.positionGroup).toBe('GK');
  });

  it('normalizes every event with mapped types, canonical coordinates and a quality report', () => {
    const raw = json(`events/${FINAL_2022}.json`) as unknown[];
    const { events, quality } = n.normalizeEvents(raw);
    expect(events).toHaveLength(raw.length);
    expect(events.filter((e) => e.typeKey === 'unknown')).toHaveLength(0);
    expect(quality.unknownTypeNames).toEqual([]);
    for (const e of events) {
      if (e.x !== null) {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.x).toBeLessThanOrEqual(105);
        expect(e.y!).toBeGreaterThanOrEqual(0);
        expect(e.y!).toBeLessThanOrEqual(68);
      }
    }
    const sorted = [...events].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.possessionId).toBeGreaterThanOrEqual(sorted[i - 1]!.possessionId);
    expect(quality.hasExtraTime).toBe(true);
    expect(quality.hasShootout).toBe(true);
    expect(quality.partial).toBe(false);
    expect(quality.xgSource).toBe('provider:statsbomb');

    const shot = events.find((e) => e.typeKey === 'shot')!;
    expect(shot.detail.xg).toBeGreaterThan(0);
    const pass = events.find((e) => e.typeKey === 'pass' && e.outcome === 'complete')!;
    expect(pass.detail.recipientProviderPlayerId).toBeTruthy();
    const xi = events.find((e) => e.typeKey === 'starting_xi')!;
    expect(xi.detail.formation).toBe('4-3-3');
    const shiftTs = events.find((e) => e.typeKey === 'tactical_shift')!;
    expect(shiftTs.clockSeconds).toBeCloseTo(41 * 60 + 20.088, 2);
  });

  it('normalizes 360 freeze frames for the 2022 final', () => {
    const frames = n.normalizeFreezeFrames(json(`three-sixty/${FINAL_2022}.json`));
    expect(frames.length).toBe(3683);
    expect(frames[0]!.frame.length).toBeGreaterThan(0);
  });

  it('rejects payloads that drift from the expected schema', () => {
    expect(() => n.normalizeEvents([{ id: 'not-a-uuid', index: 'x' }])).toThrow(ProviderSchemaError);
  });

  it('handles the 2018 final (no extra time, no 360)', () => {
    const { quality } = n.normalizeEvents(json(`events/${FINAL_2018}.json`));
    expect(quality.hasExtraTime).toBe(false);
    expect(quality.periodsPresent).toEqual([1, 2]);
  });
});
