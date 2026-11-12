import { evidenceOf } from "../evidence.js";
import { hasEnd, hasStart, isCompleted, isPass } from "../context.js";
import { ratio, round } from "./calculator.js";
/** Passing network (PDF free tier) built from completed passes; positions = mean pass start/end locations. */
export function buildNetwork(ctx, passes) {
  const pos = new Map();
  const edges = new Map();
  const add = (pid, x, y, kind) => {
    const p = pos.get(pid) ?? { sx: 0, sy: 0, n: 0, passes: 0, receptions: 0 };
    p.sx += x;
    p.sy += y;
    p.n += 1;
    p[kind] += 1;
    pos.set(pid, p);
  };
  for (const e of passes) {
    if (!e.playerId || !hasStart(e)) continue;
    add(e.playerId, e.x, e.y, "passes");
    const recipient = e.detail.recipientPlayerId;
    if (isCompleted(e) && recipient && hasEnd(e)) {
      add(recipient, e.endX, e.endY, "receptions");
      const key = `${e.playerId}>${recipient}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return {
    nodes: [...pos.entries()].map(([playerId, p]) => ({
      playerId,
      name: ctx.playerName(playerId),
      x: round(p.sx / p.n, 1),
      y: round(p.sy / p.n, 1),
      passes: p.passes,
      receptions: p.receptions,
      positionName: ctx.lineup(playerId)?.positionName ?? null,
    })),
    edges: [...edges.entries()].map(([k, count]) => {
      const [from, to] = k.split(">");
      return { from, to, count };
    }),
  };
}
/** Passes attempted, completion, passing network and average positions. */
export class PassingCalculator {
  constructor() {
    this.key = "passing";
    this.version = 1;
    this.requires = { events: true };
    this.produces = ["passing.passes_attempted", "passing.pass_completion", "passing.network", "shape.avg_positions"];
  }
  compute(ctx) {
    const out = [];
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const passes = v.own.filter(isPass);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };
        out.push(...this.passMetrics(base, passes));
        if (scope === "full" || scope === "1H" || scope === "2H") {
          const net = buildNetwork(ctx, passes);
          const extra = {};
          if (scope === "full") {
            const firstSub = ctx.events.find((e) => e.typeKey === "substitution" && e.teamId === teamId);
            if (firstSub) {
              const until = passes.filter(
                (p) => p.period < firstSub.period || (p.period === firstSub.period && p.sequenceIndex < firstSub.sequenceIndex),
              );
              extra.untilFirstSub = { minute: firstSub.minute, ...buildNetwork(ctx, until) };
            }
          }
          out.push({
            ...base,
            metricKey: "passing.network",
            value: null,
            valueJson: { ...net, ...extra },
            sampleSize: passes.length,
            coverageLabel: "calculated",
            evidence: { eventIds: [], totalEvents: passes.length, query: { types: ["pass"], teamId, scope } },
          });
          out.push({
            ...base,
            metricKey: "shape.avg_positions",
            value: null,
            valueJson: { nodes: net.nodes },
            sampleSize: passes.length,
            coverageLabel: "calculated",
            evidence: { eventIds: [], totalEvents: passes.length, note: "On-ball positions only; full positioning needs tracking." },
          });
        }
      }
      // Player level (full match).
      const full = ctx.view("full", teamId);
      const byPlayer = new Map();
      for (const p of full.own.filter(isPass)) if (p.playerId) byPlayer.set(p.playerId, [...(byPlayer.get(p.playerId) ?? []), p]);
      for (const [playerId, passes] of byPlayer) {
        out.push(
          ...this.passMetrics(
            { metricVersion: this.version, scope: "full", teamId, playerId, minutes: ctx.playerMinutes(playerId) },
            passes,
          ),
        );
      }
    }
    return out;
  }
  passMetrics(base, passes) {
    const known = passes.filter((p) => p.outcome !== "unknown");
    const completed = known.filter(isCompleted);
    const pct = ratio(completed.length, known.length);
    return [
      {
        ...base,
        metricKey: "passing.passes_attempted",
        value: passes.length,
        sampleSize: passes.length,
        coverageLabel: "observed",
        evidence: { eventIds: [], totalEvents: passes.length, query: { types: ["pass"] } },
      },
      {
        ...base,
        metricKey: "passing.pass_completion",
        value: pct === null ? null : round(pct * 100, 1),
        valueJson: { completed: completed.length, attempted: known.length },
        sampleSize: known.length,
        coverageLabel: "calculated",
        evidence: evidenceOf(
          known.filter((p) => !isCompleted(p)),
          { note: "incomplete passes" },
        ),
      },
    ];
  }
}
