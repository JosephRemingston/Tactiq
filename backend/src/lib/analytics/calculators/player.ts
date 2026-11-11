import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distance, inBox, inFinalThird } from '../../pitch';
import { evidenceOf } from '../evidence';
import { hasEnd, hasStart, isCarry, isCompleted, isPass, isPenalty, isShot, isTackle, type MatchContext, xgOf } from '../context';
import type { AEvent, MetricDraft } from '../types';
import { xtDelta } from '../xt';
import { type MetricCalculator, round } from './calculator';
import { isProgressive } from './progression';

const DATA = join(__dirname, '..', '..', '..', '..', 'data');
interface ArchetypeFile {
  id: string;
  features: string[];
  families: Record<string, string[]>;
  archetypes: Record<string, { label: string; centroid: Record<string, number> }>;
}
export interface ReferenceStats {
  id: string;
  provisional: boolean;
  source: string;
  players: number;
  features: Record<string, { mean: number; std: number }>;
}
const ARCHETYPES = JSON.parse(readFileSync(join(DATA, 'role_archetypes_v1.json'), 'utf8')) as ArchetypeFile;
let reference: ReferenceStats | null = null;
function referenceStats(): ReferenceStats {
  reference ??= JSON.parse(readFileSync(join(DATA, 'role_reference_stats_v1.json'), 'utf8')) as ReferenceStats;
  return reference;
}

export const MIN_ROLE_MINUTES = 30;
const TOUCH_TYPES = new Set(['pass', 'ball_receipt', 'carry', 'shot', 'dribble']);

/** Per-90 feature vector for one player (plus location means). Shared by the calculator and the reference builder. */
export function playerFeatures(ctx: MatchContext, playerId: string): Record<string, number> | null {
  const minutes = ctx.playerMinutes(playerId);
  if (!minutes || minutes < MIN_ROLE_MINUTES) return null;
  const own = ctx.events.filter((e) => e.playerId === playerId && e.period <= 4);
  const per90 = (n: number) => (n * 90) / minutes;
  const passes = own.filter(isPass);
  const moves = own.filter((e) => (isPass(e) || isCarry(e)) && isCompleted(e) && hasEnd(e));
  const touches = own.filter((e) => TOUCH_TYPES.has(e.typeKey) && hasStart(e)) as Array<AEvent & { x: number; y: number }>;
  const shots = own.filter(isShot);
  const located = passes.filter(hasEnd);
  const mean = (vals: number[]) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0);
  return {
    passes: per90(passes.length),
    prog_passes: per90(moves.filter((e) => isPass(e) && isProgressive(e)).length),
    prog_carries: per90(moves.filter((e) => isCarry(e) && isProgressive(e)).length),
    xt: per90(moves.reduce((s, e) => s + xtDelta(e.x!, e.y!, e.endX!, e.endY!), 0)),
    final_third_touches: per90(touches.filter((e) => inFinalThird(e)).length),
    box_touches: per90(touches.filter((e) => inBox(e)).length),
    shots: per90(shots.length),
    npxg: per90(shots.filter((s) => !isPenalty(s)).reduce((s, e) => s + xgOf(e), 0)),
    key_passes: per90(passes.filter((p) => p.detail.shotAssist === true || p.detail.goalAssist === true).length),
    pressures: per90(own.filter((e) => e.typeKey === 'pressure').length),
    tackles_interceptions: per90(own.filter((e) => isTackle(e) || e.typeKey === 'interception').length),
    recoveries: per90(own.filter((e) => e.typeKey === 'ball_recovery' && e.outcome !== 'failure').length),
    aerials: per90(own.filter((e) => e.detail.aerialWon === true || e.detail.duelType === 'aerial_lost').length),
    crosses: per90(passes.filter((p) => p.detail.cross === true).length),
    mean_x: mean(touches.map((t) => t.x)),
    mean_abs_y: mean(touches.map((t) => Math.abs(t.y - 34))),
    mean_pass_length: mean(located.map((p) => distance({ x: p.x!, y: p.y! }, { x: p.endX!, y: p.endY! }))),
  };
}

function family(positionName: string | null, group: string | null): keyof ArchetypeFile['families'] | null {
  if (group === 'GK') return 'GK';
  if (group === 'DEF') return /Center Back/.test(positionName ?? '') ? 'CB' : 'FB';
  if (group === 'MID') return 'MID';
  if (group === 'FWD') return 'FWD';
  return null;
}

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, v, i) => s + v * b[i]!, 0);
  const na = Math.hypot(...a);
  const nb = Math.hypot(...b);
  return na && nb ? dot / (na * nb) : 0;
};

/** Nearest role archetypes for a feature vector within the position family. */
export function classifyRole(features: Record<string, number>, positionName: string | null, group: string | null) {
  const fam = family(positionName, group);
  if (!fam) return null;
  const ref = referenceStats();
  const z = ARCHETYPES.features.map((f) => {
    const s = ref.features[f];
    return s ? (features[f]! - s.mean) / Math.max(s.std, 1e-6) : 0;
  });
  const ranked = ARCHETYPES.families[fam]!.map((key) => {
    const c = ARCHETYPES.archetypes[key]!;
    return { key, label: c.label, similarity: round(cosine(z, ARCHETYPES.features.map((f) => c.centroid[f] ?? 0)), 3) };
  }).sort((a, b) => b.similarity - a.similarity);
  return { family: fam, best: ranked[0]!, second: ranked[1] ?? null, z: Object.fromEntries(ARCHETYPES.features.map((f, i) => [f, round(z[i]!, 2)])), reference: { id: ref.id, provisional: ref.provisional } };
}

/** Minutes played and role profiles (inferred). */
export class PlayerCalculator implements MetricCalculator {
  readonly key = 'player';
  readonly version = 1;
  readonly requires = { events: true, lineups: true };
  readonly produces = ['player.minutes', 'player.role_profile'] as const;

  compute(ctx: MatchContext): MetricDraft[] {
    const out: MetricDraft[] = [];
    for (const l of ctx.lineups) {
      const minutes = ctx.playerMinutes(l.playerId);
      if (minutes === null) continue;
      const base = { metricVersion: this.version, scope: 'full' as const, teamId: l.teamId, playerId: l.playerId, minutes };
      out.push({ ...base, metricKey: 'player.minutes', value: minutes, sampleSize: 1, coverageLabel: 'observed', evidence: { eventIds: [], totalEvents: 0 } });
      const features = playerFeatures(ctx, l.playerId);
      if (!features) continue;
      const role = classifyRole(features, l.positionName, l.positionGroup);
      if (!role) continue;
      const own = ctx.events.filter((e) => e.playerId === l.playerId && e.period <= 4);
      const topFeatures = Object.entries(role.z)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([f]) => f);
      out.push({
        ...base,
        metricKey: 'player.role_profile',
        value: role.best.similarity,
        valueJson: { role: role.best.key, roleLabel: role.best.label, secondRole: role.second?.key ?? null, secondRoleLabel: role.second?.label ?? null, similarity: role.best.similarity, secondSimilarity: role.second?.similarity ?? null, family: role.family, positionName: l.positionName, features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, round(v, 2)])), z: role.z, topFeatures, reference: role.reference },
        sampleSize: own.length,
        coverageLabel: 'inferred',
        evidence: evidenceOf(own.filter((e) => ['pass', 'carry', 'shot', 'pressure', 'duel', 'interception'].includes(e.typeKey)).slice(0, 50), { note: 'sample of the player actions behind the profile' }),
      });
    }
    return out;
  }
}
