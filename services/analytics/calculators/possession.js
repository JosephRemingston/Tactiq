import { evidenceOf } from "../evidence.js";
import { isPass } from "../context.js";
import { ratio, round } from "./calculator.js";
const BUILDUP_PATTERNS = new Set(["regular_play", "from_goal_kick", "from_keeper"]);
/** Possession share, chains, final-third and box entries, build-up success. */
export class PossessionCalculator {
  constructor() {
    this.key = "possession";
    this.version = 1;
    this.requires = { events: true };
    this.produces = [
      "possession.share",
      "possession.chains_count",
      "possession.avg_chain_passes",
      "possession.final_third_entries",
      "possession.box_entries",
      "buildup.success_rate",
    ];
  }
  compute(ctx) {
    const out = [];
    for (const teamId of ctx.teams) {
      for (const scope of ctx.scopes()) {
        const v = ctx.view(scope, teamId);
        const base = { metricVersion: this.version, scope, teamId, playerId: null, minutes: round(v.minutes, 1) };
        const ownPasses = v.own.filter(isPass);
        const oppPasses = v.opp.filter(isPass);
        const share = ratio(ownPasses.length, ownPasses.length + oppPasses.length);
        out.push({
          ...base,
          metricKey: "possession.share",
          value: share === null ? null : round(share * 100, 1),
          sampleSize: ownPasses.length + oppPasses.length,
          coverageLabel: "calculated",
          evidence: { eventIds: [], totalEvents: ownPasses.length + oppPasses.length, query: { types: ["pass"], scope } },
        });
        const chainEvidence = (chains) =>
          evidenceOf(
            chains.map((c) => c.start),
            { note: "chain start events" },
          );
        out.push({
          ...base,
          metricKey: "possession.chains_count",
          value: v.chains.length,
          sampleSize: v.chains.length,
          coverageLabel: "observed",
          evidence: chainEvidence(v.chains),
        });
        const avg = ratio(
          v.chains.reduce((s, c) => s + c.nPasses, 0),
          v.chains.length,
        );
        out.push({
          ...base,
          metricKey: "possession.avg_chain_passes",
          value: avg === null ? null : round(avg, 2),
          sampleSize: v.chains.length,
          coverageLabel: "calculated",
          evidence: { eventIds: [], totalEvents: v.chains.length },
        });
        const f3 = v.chains.filter((c) => c.reachedFinalThird);
        out.push({
          ...base,
          metricKey: "possession.final_third_entries",
          value: f3.length,
          sampleSize: v.chains.length,
          coverageLabel: "calculated",
          evidence: chainEvidence(f3),
        });
        const box = v.chains.filter((c) => c.reachedBox);
        out.push({
          ...base,
          metricKey: "possession.box_entries",
          value: box.length,
          sampleSize: v.chains.length,
          coverageLabel: "calculated",
          evidence: chainEvidence(box),
        });
        const buildup = v.chains.filter((c) => c.firstLocated && c.firstLocated.x < 35 && BUILDUP_PATTERNS.has(c.playPattern ?? ""));
        const success = buildup.filter((c) => c.reachedFinalThird);
        const rate = ratio(success.length, buildup.length);
        out.push({
          ...base,
          metricKey: "buildup.success_rate",
          value: rate === null ? null : round(rate * 100, 1),
          valueJson: { attempts: buildup.length, reachedFinalThird: success.length },
          sampleSize: buildup.length,
          coverageLabel: "calculated",
          evidence: chainEvidence(success),
        });
      }
    }
    return out;
  }
}
