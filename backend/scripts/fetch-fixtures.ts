/**
 * Downloads the StatsBomb Open Data files used by the test suite into test/fixtures/statsbomb.
 * Usage: pnpm fixtures:download
 *
 * StatsBomb Open Data is licensed for non-commercial use with attribution (see LICENSE.statsbomb.md).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BASE = process.env.STATSBOMB_OPEN_DATA_BASE_URL ?? 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';
const OUT = join(__dirname, '..', 'test', 'fixtures', 'statsbomb');

/** Matches are resolved by competition/season and team names so that a wrong id fails loudly. */
const FIXTURE_MATCHES = [
  { competitionId: 43, seasonId: 106, home: 'Argentina', away: 'France', expectedId: 3869685 }, // 2022 World Cup final
  { competitionId: 43, seasonId: 3, home: 'France', away: 'Croatia', expectedId: 8658 }, // 2018 World Cup final
];

async function fetchText(path: string): Promise<string | null> {
  const res = await fetch(`${BASE}/${path}`, { headers: { 'user-agent': 'Touchline-dev/0.1 (fixtures)' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.text();
}

async function save(path: string, body: string): Promise<void> {
  const file = join(OUT, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  console.log(`saved ${path} (${(body.length / 1024).toFixed(0)} KiB)`);
}

async function main(): Promise<void> {
  const competitions = await fetchText('competitions.json');
  if (!competitions) throw new Error('competitions.json missing');
  await save('competitions.json', competitions);

  for (const f of FIXTURE_MATCHES) {
    const matchesPath = `matches/${f.competitionId}/${f.seasonId}.json`;
    const matchesBody = await fetchText(matchesPath);
    if (!matchesBody) throw new Error(`${matchesPath} missing`);
    await save(matchesPath, matchesBody);

    const matches = JSON.parse(matchesBody) as Array<{ match_id: number; home_team: { home_team_name: string }; away_team: { away_team_name: string }; competition_stage?: { name: string } }>;
    const match = matches.find((m) => m.home_team.home_team_name === f.home && m.away_team.away_team_name === f.away && m.competition_stage?.name === 'Final');
    if (!match) throw new Error(`Could not find ${f.home} v ${f.away} final in ${matchesPath}`);
    if (match.match_id !== f.expectedId) console.warn(`note: ${f.home} v ${f.away} resolved to ${match.match_id}, expected ${f.expectedId}`);

    for (const kind of ['lineups', 'events', 'three-sixty'] as const) {
      const body = await fetchText(`${kind}/${match.match_id}.json`);
      if (body) await save(`${kind}/${match.match_id}.json`, body);
      else console.log(`no ${kind} file for ${match.match_id}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
