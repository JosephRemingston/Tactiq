/**
 * Builds data/role_reference_stats_v1.json: mean and standard deviation of each per-90 role feature over a corpus.
 *
 *   node -r @swc-node/register scripts/build-role-reference.ts --local test/fixtures/statsbomb --season 43:106 --season 43:3
 *   node -r @swc-node/register scripts/build-role-reference.ts --github --season 43:106 --season 55:43
 *
 * With --local only matches whose files exist are used; the output is marked provisional below 300 player-matches.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { playerFeatures, type ReferenceStats } from '../src/lib/analytics/calculators/player';
import { contextFromStatsBombFiles } from '../src/lib/analytics/offline';

const { values } = parseArgs({
  options: { local: { type: 'string' }, github: { type: 'boolean', default: false }, season: { type: 'string', multiple: true, default: [] }, cache: { type: 'string', default: '.statsbomb-cache' } },
});
const BASE = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';

async function ensureLocal(dir: string, path: string): Promise<boolean> {
  const file = join(dir, path);
  if (existsSync(file)) return true;
  if (!values.github) return false;
  const res = await fetch(`${BASE}/${path}`, { headers: { 'user-agent': 'Touchline-dev/0.1 (role reference)' } });
  if (!res.ok) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  await new Promise((r) => setTimeout(r, 500)); // stay polite to GitHub raw
  return true;
}

async function main() {
  const dir = values.local ?? values.cache!;
  const rows: Array<Record<string, number>> = [];
  let matchesUsed = 0;
  for (const pair of values.season!) {
    const [comp, season] = pair.split(':') as [string, string];
    if (!(await ensureLocal(dir, `matches/${comp}/${season}.json`))) throw new Error(`matches/${comp}/${season}.json not available`);
    const matches = JSON.parse(readFileSync(join(dir, `matches/${comp}/${season}.json`), 'utf8')) as Array<{ match_id: number }>;
    for (const m of matches) {
      const id = String(m.match_id);
      if (!(await ensureLocal(dir, `lineups/${id}.json`)) || !(await ensureLocal(dir, `events/${id}.json`))) continue;
      const ctx = contextFromStatsBombFiles(dir, comp, season, id);
      for (const l of ctx.lineups) {
        if (l.positionGroup === 'GK') continue;
        const f = playerFeatures(ctx, l.playerId);
        if (f) rows.push(f);
      }
      matchesUsed++;
      process.stdout.write(`\r${matchesUsed} matches, ${rows.length} player-matches`);
    }
  }
  if (!rows.length) throw new Error('no player-matches found');
  const features = Object.fromEntries(
    Object.keys(rows[0]!).map((k) => {
      const vals = rows.map((r) => r[k]!);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1));
      return [k, { mean: Math.round(mean * 1e4) / 1e4, std: Math.round(std * 1e4) / 1e4 }];
    }),
  );
  const out: ReferenceStats = {
    id: 'role_reference_stats_v1',
    provisional: rows.length < 300,
    source: `StatsBomb Open Data ${values.season!.join(', ')} (${matchesUsed} matches, outfield players >= 30 min)`,
    players: rows.length,
    features,
  };
  writeFileSync(join(__dirname, '..', 'data', 'role_reference_stats_v1.json'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\nwrote data/role_reference_stats_v1.json (${rows.length} player-matches, provisional=${out.provisional})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
