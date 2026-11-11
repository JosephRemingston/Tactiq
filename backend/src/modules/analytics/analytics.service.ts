import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import { assertFound, Errors } from '../../common/errors';
import { decodeCursor, toPage } from '../../common/pagination';
import type { Db } from '../../db/client';
import { lineups, matches, matchPossessions, metricDefinitions, players, type Scope, SCOPES } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { CacheService } from '../../infra/redis/cache.service';
import type { StoredMetric } from '../../lib/analytics/insights/types';
import { FootballService } from '../football/football.service';
import { ANALYTICS_REPOSITORY, type AnalyticsRepository, type MetricFilter } from './analytics.repository';

const RUN_TTL = 6 * 3600;
const PRESSING_KEYS = ['pressing.ppda', 'pressing.ppda_incl_pressures', 'pressing.pressures', 'pressing.pressure_regains_5s', 'pressing.high_turnovers', 'pressing.shots_after_high_turnover', 'pressing.defensive_action_height_m'];
const TRANSITION_KEYS = ['transition.counterpress_regains', 'transition.counterpress_regain_rate', 'transition.counter_shots', 'transition.regain_to_shot_seconds'];
export const COMPARE_KEYS = [
  'possession.share',
  'passing.pass_completion',
  'progression.progressive_passes',
  'progression.progressive_carries',
  'possession.xt_added',
  'possession.box_entries',
  'shooting.shots',
  'shooting.xg',
  'shooting.goals',
  'pressing.ppda',
  'pressing.high_turnovers',
  'transition.counterpress_regain_rate',
];

const shape = (m: StoredMetric) => ({
  key: m.metricKey,
  version: m.metricVersion,
  scope: m.scope,
  teamId: m.teamId,
  playerId: m.playerId,
  value: m.value,
  valueJson: m.valueJson ?? undefined,
  sampleSize: m.sampleSize,
  minutes: m.minutes,
  coverageLabel: m.coverageLabel,
  evidence: m.evidence,
});

/** Read models over analysed matches. Every response says which run produced it and what coverage it rests on. */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ANALYTICS_REPOSITORY) private readonly repo: AnalyticsRepository,
    private readonly cache: CacheService,
    private readonly football: FootballService,
  ) {}

  /** Current analysis run for a match, or a clear status when there is none yet. */
  async currentRun(matchId: string): Promise<{ runId: string; analyticsVersion: number; analysedAt: Date | null } > {
    const run = await this.cache.wrap(`cache:match:${matchId}:run`, 60, async () => {
      const [m] = await this.db
        .select({ runId: matches.analysisRunId, analyticsVersion: matches.analyticsVersion, analysedAt: matches.analysedAt, status: matches.analysisStatus })
        .from(matches)
        .where(eq(matches.id, matchId));
      return assertFound(m, 'Match');
    });
    if (!run.runId) {
      const summary = await this.football.getMatch(matchId);
      throw Errors.conflict(summary.coverage.hasEvents ? `Analysis is ${run.status === 'failed' ? 'unavailable (failed)' : 'not finished yet'} for this match` : 'This match has no event data, so tactical metrics are not available');
    }
    return { runId: run.runId, analyticsVersion: run.analyticsVersion ?? 1, analysedAt: run.analysedAt };
  }

  private async cached<T>(matchId: string, view: string, load: (run: { runId: string; analyticsVersion: number; analysedAt: Date | null }) => Promise<T>) {
    const run = await this.currentRun(matchId);
    return this.cache.wrap(`cache:match:${matchId}:run:${run.runId}:${view}`, RUN_TTL, async () => ({ matchId, analysisRunId: run.runId, analyticsVersion: run.analyticsVersion, analysedAt: run.analysedAt, ...(await load(run)) }));
  }

  async metrics(matchId: string, q: MetricFilter & { includeDefinitions?: boolean }) {
    const view = `metrics:${q.scope ?? '*'}:${q.teamId ?? '*'}:${q.playerId === null ? 'team' : (q.playerId ?? '*')}:${(q.keys ?? []).join(',')}:${q.includeDefinitions ? 'd' : ''}`;
    return this.cached(matchId, view, async () => {
      const rows = await this.repo.getMatchMetrics(matchId, q);
      const keys = [...new Set(rows.map((r) => r.metricKey))];
      const definitions = q.includeDefinitions && keys.length
        ? await this.db
            .select({ key: metricDefinitions.key, version: metricDefinitions.version, name: metricDefinitions.name, unit: metricDefinitions.unit, direction: metricDefinitions.direction, descriptionQuick: metricDefinitions.descriptionQuick, coverageLabel: metricDefinitions.coverageLabel })
            .from(metricDefinitions)
            .where(inArray(metricDefinitions.key, keys))
        : undefined;
      return { data: rows.map(shape), ...(definitions ? { definitions } : {}) };
    });
  }

  private byTeam(rows: StoredMetric[], teamIds: string[], keys: string[], scopes: Scope[]) {
    return teamIds.map((teamId) => ({
      teamId,
      scopes: Object.fromEntries(
        scopes.map((s) => [
          s,
          Object.fromEntries(
            keys.map((k) => {
              const m = rows.find((r) => r.teamId === teamId && r.metricKey === k && r.scope === s && r.playerId === null);
              return [k, m ? { value: m.value, valueJson: m.valueJson ?? undefined, sampleSize: m.sampleSize, coverageLabel: m.coverageLabel, evidence: m.evidence } : null];
            }),
          ),
        ]),
      ),
    }));
  }

  private async teamIds(matchId: string): Promise<[string, string]> {
    const summary = await this.football.getMatch(matchId);
    return [summary.home.id, summary.away.id];
  }

  /** Formations, passing networks and average positions. Tracking-based shape metrics are reported as unavailable. */
  async tacticalShape(matchId: string, scope: 'full' | '1H' | '2H') {
    return this.cached(matchId, `shape:${scope}`, async () => {
      const teams = await this.teamIds(matchId);
      const rows = await this.repo.getMatchMetrics(matchId, { keys: ['shape.starting_formation', 'shape.formation_timeline', 'passing.network', 'shape.avg_positions'], playerId: null });
      const pick = (teamId: string, key: string, s: Scope = 'full') => rows.find((r) => r.teamId === teamId && r.metricKey === key && r.scope === s)?.valueJson ?? null;
      const summary = await this.football.getMatch(matchId);
      return {
        scope,
        teams: teams.map((teamId) => ({
          teamId,
          startingFormation: (pick(teamId, 'shape.starting_formation') as { formation?: string } | null)?.formation ?? null,
          formationTimeline: (pick(teamId, 'shape.formation_timeline') as { timeline?: unknown[] } | null)?.timeline ?? [],
          passingNetwork: pick(teamId, 'passing.network', scope),
          averagePositions: (pick(teamId, 'shape.avg_positions', scope) as { nodes?: unknown[] } | null)?.nodes ?? [],
        })),
        unavailable: summary.coverage.hasTracking ? [] : [{ metrics: ['shape.team_width_m', 'shape.compactness_m2', 'shape.defensive_line_height_m'], reason: 'Needs continuous tracking data, which this match does not have.' }],
        note: 'Positions come from on-ball events (passes and receptions), not full player tracking.',
      };
    });
  }

  async pressing(matchId: string) {
    return this.cached(matchId, 'pressing', async () => {
      const teams = await this.teamIds(matchId);
      const rows = await this.repo.getMatchMetrics(matchId, { keys: PRESSING_KEYS, playerId: null });
      const players = await this.repo.getMatchMetrics(matchId, { keys: ['pressing.pressures'], scope: 'full' });
      const scopes = [...new Set(rows.map((r) => r.scope))] as Scope[];
      return {
        teams: this.byTeam(rows, teams, PRESSING_KEYS, SCOPES.filter((s) => scopes.includes(s))),
        topPressers: teams.map((teamId) => ({
          teamId,
          players: players
            .filter((p) => p.teamId === teamId && p.playerId)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .slice(0, 5)
            .map((p) => ({ playerId: p.playerId, pressures: p.value })),
        })),
      };
    });
  }

  async transitions(matchId: string) {
    return this.cached(matchId, 'transitions', async () => {
      const teams = await this.teamIds(matchId);
      const rows = await this.repo.getMatchMetrics(matchId, { keys: TRANSITION_KEYS, playerId: null });
      const scopes = [...new Set(rows.map((r) => r.scope))] as Scope[];
      return { teams: this.byTeam(rows, teams, TRANSITION_KEYS, SCOPES.filter((s) => scopes.includes(s))) };
    });
  }

  async possessions(matchId: string, q: { teamId?: string; endType?: string; limit: number; cursor?: string }) {
    await this.currentRun(matchId);
    const conds: SQL[] = [eq(matchPossessions.matchId, matchId)];
    if (q.teamId) conds.push(eq(matchPossessions.teamId, q.teamId));
    if (q.endType) conds.push(eq(matchPossessions.endType, q.endType as never));
    const cursor = decodeCursor(q.cursor);
    if (cursor) conds.push(gt(matchPossessions.possessionId, Number(cursor[0])));
    const rows = await this.db.select().from(matchPossessions).where(and(...conds)).orderBy(asc(matchPossessions.possessionId)).limit(q.limit + 1);
    return toPage(rows, q.limit, (r) => [r.possessionId, String(r.possessionId)]);
  }

  async player(matchId: string, playerId: string) {
    return this.cached(matchId, `player:${playerId}`, async () => {
      const [lu] = await this.db
        .select({ teamId: lineups.teamId, positionName: lineups.positionName, positionGroup: lineups.positionGroup, isStarter: lineups.isStarter, minuteOn: lineups.minuteOn, minuteOff: lineups.minuteOff, name: players.fullName, knownName: players.knownName })
        .from(lineups)
        .innerJoin(players, eq(players.id, lineups.playerId))
        .where(and(eq(lineups.matchId, matchId), eq(lineups.playerId, playerId)));
      const lineup = assertFound(lu, 'Player in this match');
      const rows = await this.repo.getMatchMetrics(matchId, { playerId });
      const role = rows.find((r) => r.metricKey === 'player.role_profile');
      return {
        playerId,
        name: lineup.knownName ?? lineup.name,
        teamId: lineup.teamId,
        positionName: lineup.positionName,
        positionGroup: lineup.positionGroup,
        isStarter: lineup.isStarter,
        minutes: rows.find((r) => r.metricKey === 'player.minutes')?.value ?? null,
        role: role ? { ...(role.valueJson as object), coverageLabel: role.coverageLabel } : null,
        metrics: rows.filter((r) => r.metricKey !== 'player.role_profile').map(shape),
      };
    });
  }

  /** Side-by-side key metrics for two matches (optionally one team's view in each). */
  async compare(a: string, b: string, teamId?: string) {
    const side = async (matchId: string) => {
      const summary = await this.football.getMatch(matchId);
      const teams = teamId ? [teamId] : [summary.home.id, summary.away.id];
      if (teamId && ![summary.home.id, summary.away.id].includes(teamId)) throw Errors.validation([{ path: 'teamId', message: `team did not play in match ${matchId}` }]);
      await this.currentRun(matchId);
      const rows = await this.repo.getMatchMetrics(matchId, { keys: COMPARE_KEYS, scope: 'full', playerId: null });
      return {
        matchId,
        kickoffAt: summary.kickoffAt,
        home: summary.home,
        away: summary.away,
        competition: summary.competition,
        coverage: summary.coverage.level,
        teams: teams.map((t) => ({ teamId: t, metrics: Object.fromEntries(COMPARE_KEYS.map((k) => [k, rows.find((r) => r.teamId === t && r.metricKey === k)?.value ?? null])) })),
      };
    };
    return { keys: COMPARE_KEYS, matches: [await side(a), await side(b)] };
  }
}
