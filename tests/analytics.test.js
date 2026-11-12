import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "./support/expect.js";
import { CALCULATORS, runCalculators } from "../services/analytics/calculators/index.js";
import { isProgressive } from "../services/analytics/calculators/progression.js";
import { contextFromStatsBombFiles } from "./support/offline.js";
import { xtAt } from "../services/analytics/xt.js";
import { inBox, inZone14, laneOf } from "../utils/pitch.js";
import { miniMatch } from "./support/miniMatch.js";
const FIXTURES = join(import.meta.dirname, "fixtures", "statsbomb");
const pick = (drafts, key, teamId, scope = "full", playerId = null) =>
  drafts.find((d) => d.metricKey === key && d.teamId === teamId && d.scope === scope && d.playerId === playerId);
const value = (drafts, key, teamId, scope = "full") => pick(drafts, key, teamId, scope)?.value;
describe("pitch zones", () => {
  it("classifies box, zone 14 and lanes", () => {
    expect(inBox({ x: 90, y: 34 })).toBe(true);
    expect(inBox({ x: 88, y: 34 })).toBe(false);
    expect(inZone14({ x: 80, y: 30 })).toBe(true);
    expect(inZone14({ x: 90, y: 34 })).toBe(false);
    expect(laneOf(5)).toBe("wide_left");
    expect(laneOf(34)).toBe("central");
    expect(laneOf(67.9)).toBe("wide_right");
  });
  it("xT increases towards goal", () => {
    expect(xtAt(100, 34)).toBeGreaterThan(xtAt(50, 34));
    expect(xtAt(0, 0)).toBeGreaterThan(0);
  });
});
describe("calculators on the hand-built mini match (exact values)", () => {
  const ctx = miniMatch();
  const { drafts } = runCalculators(ctx);
  it("builds possession chains with end types", () => {
    expect(ctx.chains.map((c) => `${c.possessionId}:${c.teamId}:${c.endType}`)).toEqual([
      "1:H:goal",
      "2:A:turnover",
      "3:H:shot",
      "4:A:turnover",
      "5:H:turnover",
      "6:A:turnover",
      "7:H:half_end",
    ]);
  });
  it("labels score states from the goal timeline", () => {
    expect(ctx.scoreState(ctx.events[3], "H")).toBe("drawing"); // the goal itself is scored while drawing
    expect(ctx.scoreState(ctx.events[4], "H")).toBe("leading");
    expect(ctx.scoreState(ctx.events[4], "A")).toBe("trailing");
  });
  it("possession share, entries and build-up", () => {
    expect(value(drafts, "possession.share", "H")).toBe(57.1); // H 4 passes, A 3 passes
    expect(value(drafts, "possession.chains_count", "H")).toBe(4);
    expect(value(drafts, "possession.final_third_entries", "H")).toBe(4);
    expect(value(drafts, "possession.box_entries", "H")).toBe(1);
    expect(value(drafts, "buildup.success_rate", "H")).toBe(100); // chain 1 starts at x=20 and reaches the final third
  });
  it("progressive actions and zone 14", () => {
    expect(isProgressive(ctx.events[0])).toBe(true); // 20 -> 60: own -> opp half, gain 40 m
    expect(isProgressive(ctx.events[2])).toBe(false); // gain ~4.7 m
    expect(value(drafts, "progression.progressive_passes", "H")).toBe(2);
    expect(value(drafts, "progression.progressive_carries", "H")).toBe(1);
    expect(value(drafts, "progression.zone14_receptions", "H")).toBe(1);
    expect(pick(drafts, "progression.zone14_receptions", "H", "full", "h3")?.value).toBe(1); // credited to the receiver
  });
  it("PPDA = opponent open-play passes in their own 60% / tackles + interceptions + fouls in that zone", () => {
    const ppda = pick(drafts, "pressing.ppda", "H");
    expect(ppda.valueJson).toEqual({ opponentPasses: 2, defensiveActions: 2 });
    expect(ppda.value).toBe(1);
    expect(value(drafts, "pressing.ppda", "A")).toBeNull(); // no defensive actions: undefined, not zero
  });
  it("high turnovers and shots after them", () => {
    expect(value(drafts, "pressing.high_turnovers", "H")).toBe(3);
    expect(value(drafts, "pressing.shots_after_high_turnover", "H")).toBe(1);
  });
  it("counterpress regains within 3/5/8 s", () => {
    const h = pick(drafts, "transition.counterpress_regains", "H");
    expect(h.value).toBe(1);
    expect(h.valueJson).toEqual({ windows: { "3s": 1, "5s": 1, "8s": 1 }, turnovers: 1 });
    expect(value(drafts, "transition.counterpress_regain_rate", "H")).toBe(100);
    expect(value(drafts, "transition.counterpress_regain_rate", "A")).toBe(33.3);
  });
  it("shooting, xG, key passes and xA", () => {
    expect(value(drafts, "shooting.shots", "H")).toBe(2);
    expect(value(drafts, "shooting.goals", "H")).toBe(1);
    expect(value(drafts, "shooting.shots_on_target", "H")).toBe(2);
    expect(value(drafts, "shooting.xg", "H")).toBe(0.4);
    expect(value(drafts, "shooting.goals_minus_xg", "H")).toBe(0.6);
    expect(pick(drafts, "passing.xa", "H", "full", "h2")?.value).toBe(0.1);
    expect(value(drafts, "shooting.shots", "H", "leading")).toBe(1);
  });
  it("xT added equals the sum of grid deltas of completed passes and carries", () => {
    const expected = [ctx.events[0], ctx.events[1], ctx.events[2], ctx.events[7]].reduce(
      (s, e) => s + xtAt(e.endX, e.endY) - xtAt(e.x, e.y),
      0,
    );
    expect(value(drafts, "possession.xt_added", "H")).toBeCloseTo(expected, 4);
  });
  it("passing network edges count completed passes between pairs", () => {
    const net = pick(drafts, "passing.network", "H").valueJson;
    expect(net.edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))).toEqual([
      { from: "h1", to: "h2", count: 1 },
      { from: "h1", to: "h3", count: 1 },
      { from: "h2", to: "h3", count: 1 },
    ]);
  });
  it("every metric carries evidence and a coverage label", () => {
    for (const d of drafts) {
      expect(d.evidence.totalEvents).toBeGreaterThanOrEqual(d.evidence.eventIds.length);
      expect(["observed", "calculated", "inferred"]).toContain(d.coverageLabel);
    }
  });
});
describe("calculators on real StatsBomb fixtures", () => {
  const final2022 = contextFromStatsBombFiles(FIXTURES, "43", "106", "3869685");
  const run = runCalculators(final2022);
  const ARG = final2022.meta.homeTeamId;
  const FRA = final2022.meta.awayTeamId;
  it("reproduces the 2022 final score (3-3 after extra time) and the shoot-out (4-2)", () => {
    expect(value(run.drafts, "shooting.goals", ARG)).toBe(3);
    expect(value(run.drafts, "shooting.goals", FRA)).toBe(3);
    expect(value(run.drafts, "shooting.shootout", ARG)).toBe(4);
    expect(value(run.drafts, "shooting.shootout", FRA)).toBe(2);
    expect(final2022.scopes()).toContain("ET");
  });
  it("matches provider xG summed from the raw file", () => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, "events/3869685.json"), "utf8"));
    const rawXg = raw
      .filter((e) => e.type.name === "Shot" && e.period <= 4 && String(e.team.id) === ARG)
      .reduce((s, e) => s + (e.shot?.statsbomb_xg ?? 0), 0);
    expect(value(run.drafts, "shooting.xg", ARG)).toBeCloseTo(rawXg, 2);
  });
  it("produces plausible values", () => {
    for (const team of [ARG, FRA]) {
      expect(value(run.drafts, "shooting.shots", team)).toBeGreaterThanOrEqual(5);
      expect(value(run.drafts, "shooting.shots", team)).toBeLessThanOrEqual(30);
      const ppda = value(run.drafts, "pressing.ppda", team);
      expect(ppda).toBeGreaterThan(2);
      expect(ppda).toBeLessThan(30);
      const share = value(run.drafts, "possession.share", team);
      expect(share).toBeGreaterThan(30);
      expect(share).toBeLessThan(70);
    }
    expect(value(run.drafts, "possession.share", ARG) + value(run.drafts, "possession.share", FRA)).toBeCloseTo(100, 0);
    expect(pick(run.drafts, "shape.starting_formation", ARG).valueJson.formation).toBe("4-3-3");
    expect(pick(run.drafts, "shape.starting_formation", FRA).valueJson.formation).toBe("4-2-3-1");
  });
  it("only emits metric keys that have a seeded definition", () => {
    const defined = new Set(
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "metric_definitions.json"), "utf8")).map((d) => d.key),
    );
    const emitted = new Set(run.drafts.map((d) => d.metricKey));
    expect([...emitted].filter((k) => !defined.has(k))).toEqual([]);
    for (const c of CALCULATORS) for (const k of c.produces) expect(defined.has(k)).toBe(true);
  });
  it("is deterministic", () => {
    const again = runCalculators(contextFromStatsBombFiles(FIXTURES, "43", "106", "3869685"));
    expect(JSON.stringify(again.drafts)).toBe(JSON.stringify(run.drafts));
  });
  it("assigns role profiles within the position family", () => {
    const profiles = run.drafts.filter((d) => d.metricKey === "player.role_profile");
    expect(profiles.length).toBeGreaterThan(20);
    const gk = profiles.find((p) => p.valueJson.family === "GK");
    expect(gk.valueJson.role).toBe("goalkeeper");
    for (const p of profiles) {
      const v = p.valueJson;
      if (v.family === "CB") expect(["ball_playing_cb", "stopper_cb"]).toContain(v.role);
    }
  });
  it("counts own goals for the benefiting team (2018 final, France 4-2 Croatia)", () => {
    const final2018 = contextFromStatsBombFiles(FIXTURES, "43", "3", "8658");
    const r = runCalculators(final2018);
    const fra = final2018.meta.homeTeamName === "France" ? final2018.meta.homeTeamId : final2018.meta.awayTeamId;
    const cro = final2018.opponent(fra);
    const g = pick(r.drafts, "shooting.goals", fra);
    expect(g.value).toBe(4);
    expect(g.valueJson.ownGoalsFor).toBe(1);
    expect(value(r.drafts, "shooting.goals", cro)).toBe(2);
    expect(final2018.scopes()).not.toContain("ET");
  });
});
