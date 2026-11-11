import { distanceToGoal, inBox, inFinalThird } from '../pitch';
import type { AEvent, ACoverage, ALineup, AMatchMeta, Scope } from './types';
import { xtDelta } from './xt';

/** Seconds from kick-off at which each period starts, for absolute time across periods. */
const PERIOD_OFFSET: Record<number, number> = { 1: 0, 2: 45 * 60, 3: 90 * 60, 4: 105 * 60, 5: 120 * 60 };
export const absTime = (e: { period: number; clockSeconds: number }) => (PERIOD_OFFSET[e.period] ?? 0) + e.clockSeconds;

export const SET_PIECE_PASS_TYPES = new Set(['corner', 'free_kick', 'throw_in', 'goal_kick', 'kick_off']);
export const SET_PIECE_PATTERNS = new Set(['from_corner', 'from_free_kick', 'from_throw_in']);
export const DEFENSIVE_ACTION_TYPES = new Set(['interception', 'foul_committed']);

export const isPass = (e: AEvent) => e.typeKey === 'pass';
export const isCarry = (e: AEvent) => e.typeKey === 'carry';
export const isCompleted = (e: AEvent) => e.outcome === 'complete';
export const isOpenPlayPass = (e: AEvent) => isPass(e) && !SET_PIECE_PASS_TYPES.has(String(e.detail.passType ?? ''));
export const isTackle = (e: AEvent) => e.typeKey === 'duel' && e.detail.duelType === 'tackle';
/** PPDA defensive actions (Touchline v1): tackles (any outcome), interceptions, fouls committed. */
export const isPpdaDefensiveAction = (e: AEvent) => isTackle(e) || DEFENSIVE_ACTION_TYPES.has(e.typeKey);
export const isRegularTime = (e: AEvent) => e.period <= 4;
export const isShot = (e: AEvent) => e.typeKey === 'shot' && e.period <= 4;
export const isGoalShot = (e: AEvent) => isShot(e) && e.outcome === 'goal';
export const xgOf = (e: AEvent) => (typeof e.detail.xg === 'number' ? e.detail.xg : 0);
export const isPenalty = (e: AEvent) => e.detail.shotType === 'penalty';
export const hasStart = (e: AEvent): e is AEvent & { x: number; y: number } => e.x !== null && e.y !== null;
export const hasEnd = (e: AEvent): e is AEvent & { x: number; y: number; endX: number; endY: number } => hasStart(e) && e.endX !== null && e.endY !== null;

export type PossessionEndType = 'shot' | 'goal' | 'turnover' | 'out' | 'foul' | 'half_end' | 'other';

export interface PossessionChain {
  possessionId: number;
  teamId: string | null;
  period: number;
  events: AEvent[];
  own: AEvent[];
  start: AEvent;
  end: AEvent;
  startClock: number;
  endClock: number;
  startAbs: number;
  firstLocated: AEvent | null;
  playPattern: string | null;
  endType: PossessionEndType;
  nPasses: number;
  reachedFinalThird: boolean;
  reachedBox: boolean;
  xtNet: number;
  xgTotal: number;
  shots: AEvent[];
}

interface Goal {
  teamId: string;
  abs: number;
  sequenceIndex: number;
  period: number;
}

/**
 * Everything calculators need about one match, built once: indexed events, possession chains,
 * a goal timeline for score-state labelling, scope filters and minutes per scope.
 */
export class MatchContext {
  readonly events: AEvent[];
  readonly teams: [string, string];
  readonly chains: PossessionChain[];
  readonly goals: Goal[];
  readonly periods: number[];
  private readonly periodLength = new Map<number, number>();
  private readonly lineupByPlayer = new Map<string, ALineup>();

  constructor(
    readonly meta: AMatchMeta,
    events: AEvent[],
    readonly lineups: ALineup[],
    readonly coverage: ACoverage,
  ) {
    this.events = [...events].sort((a, b) => a.period - b.period || a.sequenceIndex - b.sequenceIndex);
    this.teams = [meta.homeTeamId, meta.awayTeamId];
    for (const l of lineups) this.lineupByPlayer.set(l.playerId, l);
    for (const e of this.events) this.periodLength.set(e.period, Math.max(this.periodLength.get(e.period) ?? 0, e.clockSeconds + (e.duration ?? 0)));
    this.periods = [...this.periodLength.keys()].sort();
    this.goals = this.buildGoals();
    this.chains = this.buildChains();
  }

  opponent(teamId: string): string {
    return teamId === this.teams[0] ? this.teams[1] : this.teams[0];
  }

  teamName(teamId: string): string {
    return teamId === this.meta.homeTeamId ? this.meta.homeTeamName : this.meta.awayTeamName;
  }

  lineup(playerId: string): ALineup | undefined {
    return this.lineupByPlayer.get(playerId);
  }

  playerName(playerId: string): string {
    return this.lineupByPlayer.get(playerId)?.playerName ?? 'Unknown player';
  }

  hasExtraTime(): boolean {
    return this.periods.includes(3) || this.periods.includes(4);
  }

  /** Shot goals plus "own goal for" events, excluding the shoot-out; ordered in time. */
  private buildGoals(): Goal[] {
    const goals: Goal[] = [];
    for (const e of this.events) {
      if (e.period > 4 || !e.teamId) continue;
      if (isGoalShot(e) || e.typeKey === 'own_goal_for') goals.push({ teamId: e.teamId, abs: absTime(e), sequenceIndex: e.sequenceIndex, period: e.period });
    }
    return goals.sort((a, b) => a.period - b.period || a.sequenceIndex - b.sequenceIndex);
  }

  /** Score before the event (a goal event itself is labelled with the state it was scored in). */
  scoreBefore(e: { period: number; sequenceIndex: number }): Record<string, number> {
    const score: Record<string, number> = { [this.teams[0]]: 0, [this.teams[1]]: 0 };
    for (const g of this.goals) {
      if (g.period < e.period || (g.period === e.period && g.sequenceIndex < e.sequenceIndex)) score[g.teamId] = (score[g.teamId] ?? 0) + 1;
    }
    return score;
  }

  scoreState(e: { period: number; sequenceIndex: number }, teamId: string): 'leading' | 'drawing' | 'trailing' {
    const s = this.scoreBefore(e);
    const diff = (s[teamId] ?? 0) - (s[this.opponent(teamId)] ?? 0);
    return diff > 0 ? 'leading' : diff < 0 ? 'trailing' : 'drawing';
  }

  scopes(): Scope[] {
    const base: Scope[] = ['full', '1H', '2H'];
    if (this.hasExtraTime()) base.push('ET');
    return [...base, 'leading', 'drawing', 'trailing'];
  }

  /** Whether an event belongs to a scope, from the perspective of `teamId` for score states. */
  inScope(e: { period: number; sequenceIndex: number }, scope: Scope, teamId: string): boolean {
    if (e.period > 4) return false;
    switch (scope) {
      case 'full':
        return true;
      case '1H':
        return e.period === 1;
      case '2H':
        return e.period === 2;
      case 'ET':
        return e.period === 3 || e.period === 4;
      default:
        return this.scoreState(e, teamId) === scope;
    }
  }

  /** Minutes of play covered by a scope (score-state minutes come from the goal timeline). */
  minutes(scope: Scope, teamId: string): number {
    const len = (p: number) => (this.periodLength.get(p) ?? 0) / 60;
    switch (scope) {
      case 'full':
        return [1, 2, 3, 4].reduce((s, p) => s + len(p), 0);
      case '1H':
        return len(1);
      case '2H':
        return len(2);
      case 'ET':
        return len(3) + len(4);
      default: {
        let total = 0;
        for (const p of [1, 2, 3, 4]) {
          if (!this.periodLength.has(p)) continue;
          const goalsIn = this.goals.filter((g) => g.period === p);
          const boundaries = [0, ...goalsIn.map((g) => g.abs - (PERIOD_OFFSET[p] ?? 0)), this.periodLength.get(p)!];
          for (let i = 0; i + 1 < boundaries.length; i++) {
            const seq = i === 0 ? -1 : goalsIn[i - 1]!.sequenceIndex;
            const state = this.scoreState({ period: p, sequenceIndex: seq + 1 }, teamId);
            if (state === scope) total += (boundaries[i + 1]! - boundaries[i]!) / 60;
          }
        }
        return total;
      }
    }
  }

  /** Minutes on the pitch per player, from lineup on/off minutes; null when the player did not play. */
  playerMinutes(playerId: string): number | null {
    const l = this.lineupByPlayer.get(playerId);
    if (!l || (!l.isStarter && l.minuteOn === null)) return null;
    const end = this.hasExtraTime() ? 120 : Math.max(90, Math.round(this.minutes('full', this.teams[0])));
    return Math.max(0, (l.minuteOff ?? end) - (l.minuteOn ?? 0));
  }

  view(scope: Scope, teamId: string): TeamView {
    const opp = this.opponent(teamId);
    const events = this.events.filter((e) => this.inScope(e, scope, teamId));
    return {
      scope,
      teamId,
      opponentId: opp,
      events,
      own: events.filter((e) => e.teamId === teamId),
      opp: events.filter((e) => e.teamId === opp),
      chains: this.chains.filter((c) => c.teamId === teamId && this.inScope(c.start, scope, teamId)),
      oppChains: this.chains.filter((c) => c.teamId === opp && this.inScope(c.start, scope, teamId)),
      minutes: this.minutes(scope, teamId),
    };
  }

  private buildChains(): PossessionChain[] {
    const groups = new Map<number, AEvent[]>();
    for (const e of this.events) {
      if (e.period > 4 || ['starting_xi', 'half_start', 'tactical_shift', 'substitution', 'player_on', 'player_off', 'injury_stoppage'].includes(e.typeKey)) continue;
      const list = groups.get(e.possessionId) ?? [];
      list.push(e);
      groups.set(e.possessionId, list);
    }
    const chains: PossessionChain[] = [];
    const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    for (const [possessionId, evs] of ordered) {
      const teamId = evs[0]!.possessionTeamId;
      const own = evs.filter((e) => e.teamId === teamId);
      const firstLocated = own.find(hasStart) ?? null;
      const completedMoves = own.filter((e) => (isPass(e) || isCarry(e)) && isCompleted(e) && hasEnd(e));
      const shots = own.filter(isShot);
      const reachedFinalThird = own.some((e) => hasStart(e) && inFinalThird(e)) || completedMoves.some((e) => e.endX! >= 70);
      const reachedBox = own.some((e) => hasStart(e) && inBox(e)) || completedMoves.some((e) => inBox({ x: e.endX!, y: e.endY! }));
      const xtNet = completedMoves.reduce((s, e) => s + xtDelta(e.x!, e.y!, e.endX!, e.endY!), 0);
      chains.push({
        possessionId,
        teamId,
        period: evs[0]!.period,
        events: evs,
        own,
        start: evs[0]!,
        end: evs[evs.length - 1]!,
        startClock: evs[0]!.clockSeconds,
        endClock: evs[evs.length - 1]!.clockSeconds,
        startAbs: absTime(evs[0]!),
        firstLocated,
        playPattern: evs[0]!.playPattern,
        endType: 'other',
        nPasses: own.filter(isPass).length,
        reachedFinalThird,
        reachedBox,
        xtNet,
        xgTotal: shots.reduce((s, e) => s + xgOf(e), 0),
        shots,
      });
    }
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i]!;
      const next = chains[i + 1];
      const lastOwn = c.own[c.own.length - 1];
      if (c.shots.length) c.endType = c.shots.some((s) => s.outcome === 'goal') ? 'goal' : 'shot';
      else if (c.events.some((e) => e.typeKey === 'half_end')) c.endType = 'half_end';
      else if (lastOwn && (lastOwn.outcome === 'out' || (lastOwn as { detail: Record<string, unknown> }).detail.out === true)) c.endType = 'out';
      else if (c.events.some((e) => e.typeKey === 'foul_won' && e.teamId === c.teamId)) c.endType = 'foul';
      else if (next && next.period === c.period && next.teamId !== c.teamId) c.endType = 'turnover';
      else if (!next || next.period !== c.period) c.endType = 'half_end';
    }
    return chains;
  }

  /** Chains in the same period ordered by time, for transition windows. */
  nextChainOf(chain: PossessionChain, predicate: (c: PossessionChain) => boolean): PossessionChain | undefined {
    const idx = this.chains.indexOf(chain);
    for (let i = idx + 1; i < this.chains.length; i++) {
      const c = this.chains[i]!;
      if (c.period !== chain.period) return undefined;
      if (predicate(c)) return c;
    }
    return undefined;
  }
}

export interface TeamView {
  scope: Scope;
  teamId: string;
  opponentId: string;
  events: AEvent[];
  own: AEvent[];
  opp: AEvent[];
  chains: PossessionChain[];
  oppChains: PossessionChain[];
  minutes: number;
}

export const goalDistance = (e: { x: number; y: number }) => distanceToGoal(e);
