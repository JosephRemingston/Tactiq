import { evidenceOf } from "../evidence.js";
/** Starting formation and the timeline of tactical shifts and substitutions (observed). */
export class ShapeCalculator {
  constructor() {
    this.key = "shape";
    this.version = 1;
    this.requires = { events: true };
    this.produces = ["shape.starting_formation", "shape.formation_timeline"];
  }
  compute(ctx) {
    const out = [];
    for (const teamId of ctx.teams) {
      const xi = ctx.events.find((e) => e.typeKey === "starting_xi" && e.teamId === teamId);
      const timelineEvents = ctx.events.filter(
        (e) => e.teamId === teamId && ["starting_xi", "tactical_shift", "substitution"].includes(e.typeKey),
      );
      const base = { metricVersion: this.version, scope: "full", teamId, playerId: null };
      if (xi) {
        out.push({
          ...base,
          metricKey: "shape.starting_formation",
          value: null,
          valueJson: { formation: xi.detail.formation ?? null },
          sampleSize: 1,
          coverageLabel: "observed",
          evidence: evidenceOf([xi]),
        });
      }
      const timeline = timelineEvents.map((e) => {
        if (e.typeKey === "substitution") {
          const replacement = e.detail.replacementPlayerId;
          return {
            kind: "substitution",
            eventId: e.id,
            period: e.period,
            minute: e.minute,
            playerOffId: e.playerId,
            playerOff: e.playerId ? ctx.playerName(e.playerId) : null,
            playerOnId: replacement,
            playerOn: replacement ? ctx.playerName(replacement) : null,
            reason: e.detail.reason ?? null,
          };
        }
        return {
          kind: e.typeKey === "starting_xi" ? "starting_formation" : "tactical_shift",
          eventId: e.id,
          period: e.period,
          minute: e.minute,
          formation: e.detail.formation ?? null,
        };
      });
      out.push({
        ...base,
        metricKey: "shape.formation_timeline",
        value: timeline.filter((t) => t.kind === "tactical_shift").length,
        valueJson: { timeline },
        sampleSize: timeline.length,
        coverageLabel: "observed",
        evidence: evidenceOf(timelineEvents),
      });
    }
    return out;
  }
}
