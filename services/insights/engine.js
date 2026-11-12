import { INSIGHTS_VERSION } from "../analytics/version.js";
import { fmt, GENERATORS } from "./generators.js";
import { MetricIndex } from "./metricIndex.js";
const COVERAGE_WEIGHT = { observed: 1, calculated: 0.9, inferred: 0.7 };
const KEY_PATTERNS = 3;
const confidenceOf = (c, partial) => {
  if (partial) return "low";
  const sampleOk = c.sampleSize >= c.sampleThreshold;
  if (c.coverageLabel !== "inferred" && sampleOk) return "high";
  if (c.sampleSize >= c.sampleThreshold * 0.5) return "medium";
  return "low";
};
/**
 * Deterministic: same metrics in, same insights and story out. Never invents a narrative for low-coverage matches.
 */
export function generateInsights(metrics, meta) {
  if (!meta.coverage.hasEvents) return { insights: [], story: recapStory(meta) };
  const idx = new MetricIndex(metrics);
  const priority = new Map(GENERATORS.map(([k], i) => [k, i]));
  let candidates = GENERATORS.flatMap(([, gen]) => gen(idx, meta));
  if (meta.coverage.partial) candidates = candidates.filter((c) => c.coverageLabel !== "inferred");
  const scored = candidates
    .map((c) => ({
      c,
      score: Math.round(c.salience * COVERAGE_WEIGHT[c.coverageLabel] * Math.min(1, c.sampleSize / c.sampleThreshold) * 1000) / 1000,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        priority.get(a.c.kind) - priority.get(b.c.kind) ||
        Number(b.c.teamId === meta.homeTeamId) - Number(a.c.teamId === meta.homeTeamId),
    );
  // Key patterns: at most one per family; both teams represented when both have candidates.
  const selected = [];
  const families = new Set();
  for (const s of scored) {
    if (selected.length >= KEY_PATTERNS) break;
    if (families.has(s.c.family)) continue;
    selected.push(s);
    families.add(s.c.family);
  }
  const teamsWithCandidates = new Set(scored.map((s) => s.c.teamId));
  const selectedTeams = new Set(selected.map((s) => s.c.teamId));
  if (selected.length === KEY_PATTERNS && teamsWithCandidates.size > 1 && selectedTeams.size === 1) {
    const missingTeam = [...teamsWithCandidates].find((t) => !selectedTeams.has(t));
    const replacement = scored.find(
      (s) =>
        s.c.teamId === missingTeam && !selected.includes(s) && !selected.slice(0, KEY_PATTERNS - 1).some((x) => x.c.family === s.c.family),
    );
    if (replacement) selected[KEY_PATTERNS - 1] = replacement;
  }
  const ordered = [...selected, ...scored.filter((s) => !selected.includes(s))];
  const completeness = meta.coverage.partial ? 0.5 : 1;
  const insights = ordered.map((s, i) => ({
    ...s.c,
    rank: i + 1,
    score: s.score,
    confidence: confidenceOf(s.c, meta.coverage.partial),
    completeness,
    keyPattern: i < selected.length,
  }));
  return { insights, story: fullStory(idx, meta, insights) };
}
function resultLine(meta, idx) {
  const home = meta.teamNames[meta.homeTeamId];
  const away = meta.teamNames[meta.awayTeamId];
  const hs = meta.homeScore;
  const as = meta.awayScore;
  if (hs === null || as === null) return `${home} v ${away}.`;
  const et = idx?.get("shooting.goals", meta.homeTeamId, "ET") ? " after extra time" : "";
  const hPens = idx?.value("shooting.shootout", meta.homeTeamId);
  const aPens = idx?.value("shooting.shootout", meta.awayTeamId);
  const pens =
    hPens !== null && hPens !== undefined && aPens !== null && aPens !== undefined
      ? `; ${hPens > aPens ? home : away} won ${Math.max(hPens, aPens)}-${Math.min(hPens, aPens)} on penalties`
      : "";
  if (hs === as) return `${home} and ${away} drew ${hs}-${as}${et}${pens}.`;
  const [w, l, ws, ls] = hs > as ? [home, away, hs, as] : [away, home, as, hs];
  return `${w} beat ${l} ${ws}-${ls}${et}.`;
}
function coverageStatement(meta) {
  const c = meta.coverage;
  if (!c.hasEvents && !c.hasLineups)
    return "Only the fixture and result are available for this match, so no tactical analysis is possible.";
  if (!c.hasEvents) return "Event data is not available for this match; pressing, progression and chance quality cannot be assessed.";
  const parts = [
    `Based on ${c.provider ?? "provider"} event data (${c.eventsCount.toLocaleString("en-GB")} events${c.hasFreezeFrames ? ", with freeze frames for selected moments" : ""}).`,
  ];
  if (!c.hasTracking) parts.push("Tracking data is not available, so team shape, off-ball runs and physical load are not assessed.");
  if (c.partial) parts.push("Coverage for this match is partial, so conclusions are marked low confidence.");
  return parts.join(" ");
}
function recapStory(meta) {
  return {
    kind: meta.coverage.hasLineups ? "recap" : "unavailable",
    shortVersion: resultLine(meta),
    teamApproaches: [],
    keyPatternKinds: [],
    whatChanged: meta.goals.map((g) => ({
      kind: "goal",
      minute: g.minute,
      text: `${g.ownGoal ? "Own goal" : "Goal"} for ${meta.teamNames[g.teamId]}${g.playerName ? ` (${g.playerName})` : ""}`,
      teamId: g.teamId,
    })),
    keyPlayers: [],
    evidenceLinks: [],
    coverageStatement: coverageStatement(meta),
    generatorVersion: INSIGHTS_VERSION,
  };
}
const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
const SIDE_LABEL = { left: "down the left", right: "down the right", central: "through the middle" };
function approach(idx, meta, teamId) {
  const formation = idx.json("shape.starting_formation", teamId)?.formation ?? null;
  const share = idx.value("possession.share", teamId);
  const ppda = idx.value("pressing.ppda", teamId);
  const chainPasses = idx.value("possession.avg_chain_passes", teamId);
  const lanes = idx.json("progression.by_lane", teamId)?.shares;
  const labels = [];
  if (ppda !== null) labels.push(ppda <= 8 ? "pressed high" : ppda <= 13 ? "mid-block" : "sat deep");
  if (chainPasses !== null) labels.push(chainPasses >= 5 ? "patient build-up" : chainPasses <= 3 ? "direct" : "mixed build-up");
  let side = null;
  if (lanes) {
    const left = (lanes.wide_left ?? 0) + (lanes.halfspace_left ?? 0);
    const right = (lanes.wide_right ?? 0) + (lanes.halfspace_right ?? 0);
    const central = lanes.central ?? 0;
    side = central >= left && central >= right ? "central" : left >= right ? "left" : "right";
    labels.push(`attacked ${SIDE_LABEL[side]}`);
  }
  const pressText =
    ppda === null
      ? ""
      : ppda <= 8
        ? `pressed high (PPDA ${fmt(ppda)})`
        : ppda <= 13
          ? `defended in a mid-block (PPDA ${fmt(ppda)})`
          : `mostly sat deep (PPDA ${fmt(ppda)})`;
  const parts = [
    formation ? `Started in a ${formation}` : "Started",
    share !== null ? `had ${fmt(share, 0)}% of the ball` : null,
    pressText || null,
    side ? `progressed mostly ${SIDE_LABEL[side]}` : null,
  ].filter(Boolean);
  return { teamId, teamName: meta.teamNames[teamId], formation, summary: `${parts.join(", ")}.`, labels };
}
function fullStory(idx, meta, insights) {
  const key = insights.filter((i) => i.keyPattern);
  const top = key[0];
  const shortVersion = `${resultLine(meta, idx)}${top ? ` ${top.headline}.` : ""}`;
  const whatChanged = [];
  for (const g of meta.goals)
    whatChanged.push({
      kind: "goal",
      minute: g.minute,
      text: `${g.ownGoal ? "Own goal" : "Goal"} for ${meta.teamNames[g.teamId]}${g.playerName ? ` (${g.playerName})` : ""}`,
      teamId: g.teamId,
    });
  for (const i of insights.filter((x) => x.family === "halves" || x.family === "shape" || x.family === "score_state")) {
    whatChanged.push({
      kind: i.family,
      minute: i.family === "halves" ? 45 : null,
      text: i.headline,
      insightKind: i.kind,
      teamId: i.teamId,
    });
  }
  for (const teamId of [meta.homeTeamId, meta.awayTeamId]) {
    const tl = idx.json("shape.formation_timeline", teamId)?.timeline ?? [];
    for (const s of tl.filter((e) => e.kind === "substitution"))
      whatChanged.push({
        kind: "substitution",
        minute: s.minute,
        text: `${meta.teamNames[teamId]}: ${s.playerOn ?? "?"} replaced ${s.playerOff ?? "?"}`,
        teamId,
      });
  }
  whatChanged.sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
  const keyPlayers = [];
  for (const i of insights.filter((x) => x.playerId).slice(0, 2)) {
    const role = idx.json("player.role_profile", i.teamId, "full", i.playerId)?.roleLabel ?? null;
    keyPlayers.push({
      playerId: i.playerId,
      playerName: meta.playerNames[i.playerId] ?? "Unknown",
      teamId: i.teamId,
      role,
      text: i.whatHappened,
    });
  }
  const byXt = idx.metrics
    .filter(
      (m) =>
        m.metricKey === "possession.xt_added" && m.playerId && m.scope === "full" && !keyPlayers.some((k) => k.playerId === m.playerId),
    )
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, Math.max(0, 3 - keyPlayers.length));
  for (const m of byXt) {
    const role = idx.json("player.role_profile", m.teamId, "full", m.playerId)?.roleLabel ?? null;
    keyPlayers.push({
      playerId: m.playerId,
      playerName: meta.playerNames[m.playerId] ?? "Unknown",
      teamId: m.teamId,
      role,
      text: `${meta.playerNames[m.playerId] ?? "This player"}${role ? `, playing as ${article(role)} ${role.toLowerCase()},` : ""} added ${fmt(m.value, 2)} expected threat with passes and carries, among the most in the match.`,
    });
  }
  return {
    kind: "full",
    shortVersion,
    teamApproaches: [approach(idx, meta, meta.homeTeamId), approach(idx, meta, meta.awayTeamId)],
    keyPatternKinds: key.map((k) => ({ kind: k.kind, teamId: k.teamId, playerId: k.playerId })),
    whatChanged,
    keyPlayers,
    evidenceLinks: [...new Set(insights.flatMap((i) => i.exploreLink.metricKeys))],
    coverageStatement: coverageStatement(meta),
    generatorVersion: INSIGHTS_VERSION,
  };
}
