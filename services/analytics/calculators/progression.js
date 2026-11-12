import { distanceToGoal, inZone14, LANES, laneOf, PITCH } from "../../../utils/pitch.js";
import { evidenceOf } from "../evidence.js";
import { hasEnd, isCarry, isCompleted, isOpenPlayPass, isPass } from "../context.js";
import { xtDelta, XT_GRID_ID } from "../xt.js";
import { round } from "./calculator.js";
/**
 * Touchline v1 progressive action (Wyscout-style thresholds): completed open-play pass or carry that reduces the
 * distance to the goal centre by >= 30 m (own half to own half), >= 15 m (own half to opponent half) or >= 10 m
 * (opponent half to opponent half).
 */
export function isProgressive(e) {
  if (!isCompleted(e) || !hasEnd(e)) return false;
  if (isPass(e) && !isOpenPlayPass(e)) return false;
  if (!isPass(e) && !isCarry(e)) return false;
  const gain = distanceToGoal({ x: e.x, y: e.y }) - distanceToGoal({ x: e.endX, y: e.endY });
  const startOwn = e.x < PITCH.halfway;
  const endOwn = e.endX < PITCH.halfway;
  if (startOwn && endOwn) return gain >= 30;
  if (startOwn && !endOwn) return gain >= 15;
  if (!startOwn && !endOwn) return gain >= 10;
  return false;
}
const laneShares = (events, weight) => {
  const totals = Object.fromEntries(LANES.map((l) => [l, 0]));
  let sum = 0;
  for (const e of events) {
    const w = weight(e);
    if (w <= 0 || e.endY === null) continue;
    totals[laneOf(e.endY)] += w;
    sum += w;
  }
  return Object.fromEntries(LANES.map((l) => [l, sum ? round(totals[l] / sum, 3) : 0]));
};
/** Progressive passes/carries, progressive distance, progression lanes, zone 14 receptions. */
export class ProgressionCalculator {
  constructor() {
    this.key = "progression";
    this.version = 1;
    this.requires = { events: true };
    this.produces = [
      "progression.progressive_passes",
      "progression.progressive_carries",
      "progression.progressive_distance_m",
      "progression.by_lane",
      "progression.zone14_receptions",
    ];
  }
  compute(ctx) {
    const out = [];
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        out.push(...this.metrics({ metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) }, v.own));
      }
      const full = ctx.view("full", teamId);
      const players = new Set(full.own.map((e) => e.playerId).filter((p) => Boolean(p)));
      for (const playerId of players) {
        const own = full.own.filter((e) => e.playerId === playerId);
        // Zone 14 receptions are credited to the recipient, not the passer.
        const received = full.own.filter((e) => e.detail.recipientPlayerId === playerId);
        out.push(
          ...this.metrics(
            { metricVersion: this.version, scope: "full", teamId, playerId, minutes: ctx.playerMinutes(playerId) },
            own,
            received,
          ),
        );
      }
    }
    return out;
  }
  metrics(base, own, received) {
    const moves = own.filter((e) => (isPass(e) || isCarry(e)) && isCompleted(e) && hasEnd(e));
    const prog = moves.filter(isProgressive);
    const progPasses = prog.filter(isPass);
    const progCarries = prog.filter(isCarry);
    const distance = moves.reduce(
      (s, e) => s + Math.max(0, distanceToGoal({ x: e.x, y: e.y }) - distanceToGoal({ x: e.endX, y: e.endY })),
      0,
    );
    const z14 = (received ?? own).filter((e) => isPass(e) && isCompleted(e) && hasEnd(e) && inZone14({ x: e.endX, y: e.endY }));
    const drafts = [
      {
        ...base,
        metricKey: "progression.progressive_passes",
        value: progPasses.length,
        sampleSize: moves.filter(isPass).length,
        coverageLabel: "calculated",
        evidence: evidenceOf(progPasses),
      },
      {
        ...base,
        metricKey: "progression.progressive_carries",
        value: progCarries.length,
        sampleSize: moves.filter(isCarry).length,
        coverageLabel: "calculated",
        evidence: evidenceOf(progCarries),
      },
      {
        ...base,
        metricKey: "progression.progressive_distance_m",
        value: round(distance, 1),
        sampleSize: moves.length,
        coverageLabel: "calculated",
        evidence: { eventIds: [], totalEvents: moves.length },
      },
      {
        ...base,
        metricKey: "progression.zone14_receptions",
        value: z14.length,
        sampleSize: z14.length,
        coverageLabel: "calculated",
        evidence: evidenceOf(z14, { zones: ["zone_14"] }),
      },
    ];
    if (base.playerId === null) {
      drafts.push({
        ...base,
        metricKey: "progression.by_lane",
        value: null,
        valueJson: { shares: laneShares(prog, () => 1), counts: prog.length },
        sampleSize: prog.length,
        coverageLabel: "calculated",
        evidence: evidenceOf(prog),
      });
    }
    return drafts;
  }
}
/** xT added (net) per team and player, and positive xT split by lane. Model estimate: coverage 'inferred'. */
export class XtCalculator {
  constructor() {
    this.key = "xt";
    this.version = 1;
    this.requires = { events: true };
    this.produces = ["possession.xt_added", "possession.xt_by_lane"];
  }
  compute(ctx) {
    const out = [];
    const delta = (e) => xtDelta(e.x, e.y, e.endX, e.endY);
    const summarize = (moves) => {
      const deltas = moves.map((e) => ({ e, d: delta(e) }));
      const positive = deltas.filter((x) => x.d > 0);
      return {
        net: deltas.reduce((s, x) => s + x.d, 0),
        positive: positive.reduce((s, x) => s + x.d, 0),
        top: positive
          .sort((a, b) => b.d - a.d)
          .slice(0, 20)
          .map((x) => x.e),
      };
    };
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const moves = v.own.filter((e) => (isPass(e) || isCarry(e)) && isCompleted(e) && hasEnd(e));
        const s = summarize(moves);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };
        out.push({
          ...base,
          metricKey: "possession.xt_added",
          value: round(s.net, 4),
          valueJson: { positive: round(s.positive, 4), grid: XT_GRID_ID },
          sampleSize: moves.length,
          coverageLabel: "inferred",
          evidence: evidenceOf(s.top, { note: "top 20 actions by xT gained" }),
        });
        out.push({
          ...base,
          metricKey: "possession.xt_by_lane",
          value: null,
          valueJson: { shares: laneShares(moves, (e) => Math.max(0, delta(e))) },
          sampleSize: moves.length,
          coverageLabel: "inferred",
          evidence: { eventIds: [], totalEvents: moves.length },
        });
      }
      const full = ctx.view("full", teamId);
      const moves = full.own.filter((e) => (isPass(e) || isCarry(e)) && isCompleted(e) && hasEnd(e) && e.playerId);
      const byPlayer = new Map();
      for (const m of moves) byPlayer.set(m.playerId, [...(byPlayer.get(m.playerId) ?? []), m]);
      for (const [playerId, pm] of byPlayer) {
        const s = summarize(pm);
        out.push({
          metricKey: "possession.xt_added",
          metricVersion: this.version,
          scope: "full",
          teamId,
          playerId,
          minutes: ctx.playerMinutes(playerId),
          value: round(s.net, 4),
          valueJson: { positive: round(s.positive, 4), grid: XT_GRID_ID },
          sampleSize: pm.length,
          coverageLabel: "inferred",
          evidence: evidenceOf(s.top),
        });
      }
    }
    return out;
  }
}
