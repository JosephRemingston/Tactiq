import { evidenceOf } from '../evidence';
import { isGoalShot, isPass, isPenalty, isShot, type MatchContext, SET_PIECE_PATTERNS, xgOf } from '../context';
import type { AEvent, MetricDraft } from '../types';
import { type MetricCalculator, ratio, round } from './calculator';

const ON_TARGET = new Set(['goal', 'saved', 'saved_to_post']);

/** Shots, goals, provider xG (StatsBomb model), npxG, set-piece share, shot map, shoot-out, key passes and xA. */
export class ShootingCalculator implements MetricCalculator {
  readonly key = 'shooting';
  readonly version = 1;
  readonly requires = { events: true };
  readonly produces = [
    'shooting.shots',
    'shooting.shots_on_target',
    'shooting.goals',
    'shooting.xg',
    'shooting.npxg',
    'shooting.xg_per_shot',
    'shooting.goals_minus_xg',
    'shooting.set_piece_xg_share',
    'shooting.shot_map',
    'shooting.shootout',
    'passing.key_passes',
    'passing.xa',
  ] as const;

  compute(ctx: MatchContext): MetricDraft[] {
    const out: MetricDraft[] = [];
    const shotById = new Map(ctx.events.filter((e) => e.typeKey === 'shot').map((e) => [e.id, e]));
    const chainOf = new Map<string, string | null>();
    for (const c of ctx.chains) for (const e of c.events) chainOf.set(e.id, c.playPattern);

    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };
        const ownGoals = v.own.filter((e) => e.typeKey === 'own_goal_for');
        out.push(...this.shotMetrics(base, v.own.filter(isShot), ownGoals, chainOf));
        out.push(...this.creation(base, v.own, shotById));
        if (scope === 'full') {
          out.push({ ...base, metricKey: 'shooting.shot_map', value: null, valueJson: { shots: v.own.filter(isShot).map((s) => this.shotPoint(ctx, s)) }, sampleSize: v.own.filter(isShot).length, coverageLabel: 'observed', evidence: evidenceOf(v.own.filter(isShot)) });
          const kicks = ctx.events.filter((e) => e.typeKey === 'shot' && e.period === 5 && e.teamId === teamId);
          if (kicks.length) {
            out.push({
              ...base,
              metricKey: 'shooting.shootout',
              value: kicks.filter((k) => k.outcome === 'goal').length,
              valueJson: { kicks: kicks.map((k) => ({ eventId: k.id, playerId: k.playerId, playerName: k.playerId ? ctx.playerName(k.playerId) : null, outcome: k.outcome })) },
              sampleSize: kicks.length,
              coverageLabel: 'observed',
              evidence: evidenceOf(kicks),
            });
          }
        }
      }
      const full = ctx.view('full', teamId);
      const players = new Set(full.own.map((e) => e.playerId).filter((p): p is string => Boolean(p)));
      for (const playerId of players) {
        const own = full.own.filter((e) => e.playerId === playerId);
        const base = { metricVersion: this.version, scope: 'full' as const, teamId, playerId, minutes: ctx.playerMinutes(playerId) };
        const shots = own.filter(isShot);
        if (shots.length) out.push(...this.shotMetrics(base, shots, [], chainOf).filter((m) => ['shooting.shots', 'shooting.goals', 'shooting.xg', 'shooting.npxg', 'shooting.shots_on_target'].includes(m.metricKey)));
        const creation = this.creation(base, own, shotById);
        if (creation.some((m) => (m.value ?? 0) > 0)) out.push(...creation);
      }
    }
    return out;
  }

  private shotPoint(ctx: MatchContext, s: AEvent) {
    return {
      eventId: s.id,
      minute: s.minute,
      period: s.period,
      x: s.x,
      y: s.y,
      xg: round(xgOf(s), 4),
      outcome: s.outcome,
      bodyPart: s.detail.bodyPart ?? null,
      shotType: s.detail.shotType ?? null,
      playerId: s.playerId,
      playerName: s.playerId ? ctx.playerName(s.playerId) : null,
      underPressure: s.underPressure,
    };
  }

  private shotMetrics(base: Omit<MetricDraft, 'metricKey' | 'value' | 'sampleSize' | 'coverageLabel' | 'evidence'>, shots: AEvent[], ownGoalsFor: AEvent[], chainOf: Map<string, string | null>): MetricDraft[] {
    const goals = shots.filter(isGoalShot);
    const onTarget = shots.filter((s) => ON_TARGET.has(s.outcome ?? ''));
    const xg = shots.reduce((s, e) => s + xgOf(e), 0);
    const np = shots.filter((s) => !isPenalty(s));
    const npxg = np.reduce((s, e) => s + xgOf(e), 0);
    const spXg = np.filter((s) => SET_PIECE_PATTERNS.has(chainOf.get(s.id) ?? '')).reduce((s, e) => s + xgOf(e), 0);
    const perShot = ratio(npxg, np.length);
    const spShare = ratio(spXg, npxg);
    return [
      { ...base, metricKey: 'shooting.shots', value: shots.length, sampleSize: shots.length, coverageLabel: 'observed', evidence: evidenceOf(shots) },
      { ...base, metricKey: 'shooting.shots_on_target', value: onTarget.length, sampleSize: shots.length, coverageLabel: 'observed', evidence: evidenceOf(onTarget) },
      { ...base, metricKey: 'shooting.goals', value: goals.length + ownGoalsFor.length, valueJson: { shotGoals: goals.length, ownGoalsFor: ownGoalsFor.length }, sampleSize: shots.length, coverageLabel: 'observed', evidence: evidenceOf([...goals, ...ownGoalsFor]) },
      { ...base, metricKey: 'shooting.xg', value: round(xg, 3), sampleSize: shots.length, coverageLabel: 'inferred', evidence: evidenceOf(shots, { note: 'provider model: StatsBomb xG' }) },
      { ...base, metricKey: 'shooting.npxg', value: round(npxg, 3), sampleSize: np.length, coverageLabel: 'inferred', evidence: evidenceOf(np) },
      { ...base, metricKey: 'shooting.xg_per_shot', value: perShot === null ? null : round(perShot, 3), sampleSize: np.length, coverageLabel: 'inferred', evidence: evidenceOf(np) },
      { ...base, metricKey: 'shooting.goals_minus_xg', value: round(goals.length - xg, 3), sampleSize: shots.length, coverageLabel: 'inferred', evidence: evidenceOf(goals) },
      { ...base, metricKey: 'shooting.set_piece_xg_share', value: spShare === null ? null : round(spShare * 100, 1), sampleSize: np.length, coverageLabel: 'inferred', evidence: { eventIds: [], totalEvents: np.length } },
    ];
  }

  /** Key passes = passes that set up a shot; xA = xG of those shots. */
  private creation(base: Omit<MetricDraft, 'metricKey' | 'value' | 'sampleSize' | 'coverageLabel' | 'evidence'>, own: AEvent[], shotById: Map<string, AEvent>): MetricDraft[] {
    const keyPasses = own.filter((e) => isPass(e) && (e.detail.shotAssist === true || e.detail.goalAssist === true) && e.period <= 4);
    const xa = keyPasses.reduce((s, p) => s + xgOf(shotById.get(String(p.detail.assistedShotEventId)) ?? ({ detail: {} } as AEvent)), 0);
    return [
      { ...base, metricKey: 'passing.key_passes', value: keyPasses.length, valueJson: { assists: keyPasses.filter((p) => p.detail.goalAssist === true).length }, sampleSize: keyPasses.length, coverageLabel: 'observed', evidence: evidenceOf(keyPasses) },
      { ...base, metricKey: 'passing.xa', value: round(xa, 3), sampleSize: keyPasses.length, coverageLabel: 'inferred', evidence: evidenceOf(keyPasses) },
    ];
  }
}
