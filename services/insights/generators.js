export const fmt = (v, dp = 1) => (v === null || v === undefined ? "n/a" : Number(v.toFixed(dp)).toString());
const pct = (v) => `${fmt(v, 0)}%`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function advanced(meta, keys, extra = "") {
  const parts = keys.map((k) => {
    const d = meta.definitions[k];
    return d ? `${d.name} (${k} v1): ${d.formula}.${d.caveat ? ` Caveat: ${d.caveat}` : ""}` : k;
  });
  return `${extra ? `${extra} ` : ""}${parts.join(" ")} Source: ${meta.coverage.provider ?? "unknown"} event data.`;
}
function candidate(meta, c) {
  const { view, scope, metricKeys, advancedExtra, ...rest } = c;
  return {
    ...rest,
    exploreLink: {
      view,
      matchId: meta.matchId,
      ...(c.teamId ? { teamId: c.teamId } : {}),
      ...(c.playerId ? { playerId: c.playerId } : {}),
      ...(scope ? { scope } : {}),
      metricKeys,
    },
    depth: {
      quick: `${c.headline}.`,
      explore: `${c.whatHappened} ${c.whyItMatters}`,
      advanced: advanced(meta, metricKeys, advancedExtra),
    },
  };
}
const teamsOf = (meta) => [meta.homeTeamId, meta.awayTeamId];
const other = (meta, t) => (t === meta.homeTeamId ? meta.awayTeamId : meta.homeTeamId);
const highPress = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const ppda = idx.get("pressing.ppda", t);
    const oppPpda = idx.value("pressing.ppda", other(meta, t));
    const actions = ppda?.valueJson?.defensiveActions ?? 0;
    if (!ppda || ppda.value === null || ppda.value > 8 || actions < 15 || oppPpda === null || oppPpda / ppda.value < 1.5) return [];
    const team = meta.teamNames[t];
    const opp = meta.teamNames[other(meta, t)];
    const ht = idx.value("pressing.high_turnovers", t) ?? 0;
    return [
      candidate(meta, {
        kind: "pressing.high_press_dominance",
        family: "pressing",
        teamId: t,
        playerId: null,
        salience: clamp01(oppPpda / ppda.value - 1),
        sampleSize: actions,
        sampleThreshold: 15,
        coverageLabel: "calculated",
        headline: `${team} pressed high and disrupted ${opp}'s build-up`,
        whatHappened: `${opp} made only ${fmt(ppda.value)} passes in their own half and a bit beyond for every ${team} tackle, interception or foul there, against ${fmt(oppPpda)} the other way.`,
        whyItMatters: `Pressing like this takes away time on the ball; ${team} won possession ${ht} times within 40 m of goal.`,
        evidence: {
          ...ppda.evidence,
          metrics: [idx.ref("pressing.ppda", t), idx.ref("pressing.ppda", other(meta, t)), idx.ref("pressing.high_turnovers", t)],
        },
        templateKey: "high_press_dominance",
        view: "pressing",
        metricKeys: ["pressing.ppda", "pressing.high_turnovers"],
      }),
    ];
  });
const highTurnoverThreat = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const ht = idx.get("pressing.high_turnovers", t);
    const shots = idx.value("pressing.shots_after_high_turnover", t) ?? 0;
    if (!ht || (ht.value ?? 0) < 6 || shots < 2) return [];
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "pressing.high_turnover_threat",
        family: "pressing",
        teamId: t,
        playerId: null,
        salience: clamp01(shots / 4),
        sampleSize: ht.value ?? 0,
        sampleThreshold: 6,
        coverageLabel: "calculated",
        headline: `${team} turned high regains into chances`,
        whatHappened: `${team} won the ball within 40 m of goal ${ht.value} times and took ${shots} shots from those possessions.`,
        whyItMatters: "Winning the ball high catches the opponent before they can reorganise, so chances come against an unset defence.",
        evidence: { ...ht.evidence, metrics: [idx.ref("pressing.high_turnovers", t), idx.ref("pressing.shots_after_high_turnover", t)] },
        templateKey: "high_turnover_threat",
        view: "pressing",
        metricKeys: ["pressing.high_turnovers", "pressing.shots_after_high_turnover"],
      }),
    ];
  });
const SIDE = { left: ["wide_left", "halfspace_left"], right: ["wide_right", "halfspace_right"] };
const flankDominance = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const lanes = idx.get("progression.by_lane", t);
    const v = lanes?.valueJson;
    if (!lanes || !v || v.counts < 15) return [];
    const left = SIDE.left.reduce((s, l) => s + (v.shares[l] ?? 0), 0);
    const right = SIDE.right.reduce((s, l) => s + (v.shares[l] ?? 0), 0);
    const side = left >= right ? "left" : "right";
    const share = Math.max(left, right);
    if (share < 0.55) return [];
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "progression.flank_dominance",
        family: "progression",
        teamId: t,
        playerId: null,
        salience: clamp01((share - 0.4) / 0.3),
        sampleSize: v.counts,
        sampleThreshold: 15,
        coverageLabel: "calculated",
        headline: `${team} moved the ball forward mainly down the ${side}`,
        whatHappened: `${pct(share * 100)} of ${team}'s ${v.counts} progressive passes and carries ended on their ${side} side (wing or half-space).`,
        whyItMatters: `Repeatedly using one flank can create overloads there, but it also makes the attack easier to predict and to block.`,
        evidence: { ...lanes.evidence, metrics: [idx.ref("progression.by_lane", t)] },
        templateKey: "flank_dominance",
        view: "progression",
        metricKeys: ["progression.by_lane", "progression.progressive_passes", "progression.progressive_carries"],
      }),
    ];
  });
const centralAccess = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const z = idx.get("progression.zone14_receptions", t);
    if (!z || (z.value ?? 0) < 8) return [];
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "progression.central_access",
        family: "progression",
        teamId: t,
        playerId: null,
        salience: clamp01((z.value ?? 0) / 15),
        sampleSize: z.value ?? 0,
        sampleThreshold: 8,
        coverageLabel: "calculated",
        headline: `${team} kept finding players just outside the box`,
        whatHappened: `${team} completed ${z.value} passes into zone 14, the central area in front of the penalty box.`,
        whyItMatters:
          "A player receiving there can shoot, slip a through ball or combine, which forces defenders to step out of their line.",
        evidence: { ...z.evidence, metrics: [idx.ref("progression.zone14_receptions", t)] },
        templateKey: "central_access",
        view: "progression",
        metricKeys: ["progression.zone14_receptions"],
      }),
    ];
  });
const controlWithoutThreat = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const share = idx.value("possession.share", t);
    const xg = idx.value("shooting.xg", t);
    const oppXg = idx.value("shooting.xg", other(meta, t));
    if (share === null || xg === null || oppXg === null || share < 60 || xg > oppXg) return [];
    const team = meta.teamNames[t];
    const opp = meta.teamNames[other(meta, t)];
    const boxEntries = idx.value("possession.box_entries", t) ?? 0;
    return [
      candidate(meta, {
        kind: "possession.control_without_threat",
        family: "possession",
        teamId: t,
        playerId: null,
        salience: clamp01((share - 50) * 0.04),
        sampleSize: idx.get("possession.share", t)?.sampleSize ?? 0,
        sampleThreshold: 300,
        coverageLabel: "inferred",
        headline: `${team} had the ball but not the better chances`,
        whatHappened: `${team} had ${pct(share)} of possession yet created ${fmt(xg, 2)} xG to ${opp}'s ${fmt(oppXg, 2)}, reaching the box in ${boxEntries} possessions.`,
        whyItMatters: `${opp} were comfortable without the ball and made their own, fewer attacks count.`,
        evidence: {
          eventIds: [],
          totalEvents: 0,
          metrics: [
            idx.ref("possession.share", t),
            idx.ref("shooting.xg", t),
            idx.ref("shooting.xg", other(meta, t)),
            idx.ref("possession.box_entries", t),
          ],
        },
        templateKey: "control_without_threat",
        view: "shot-map",
        metricKeys: ["possession.share", "shooting.xg", "possession.box_entries"],
      }),
    ];
  });
const finishingVariance = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const diff = idx.get("shooting.goals_minus_xg", t);
    const xg = idx.value("shooting.xg", t);
    const shots = idx.value("shooting.shots", t) ?? 0;
    if (!diff || diff.value === null || Math.abs(diff.value) < 1 || xg === null) return [];
    const team = meta.teamNames[t];
    const clinical = diff.value > 0;
    const goals = Math.round(diff.value + xg);
    return [
      candidate(meta, {
        kind: "shooting.finishing_variance",
        family: "shooting",
        teamId: t,
        playerId: null,
        salience: clamp01(Math.abs(diff.value) / 2),
        sampleSize: shots,
        sampleThreshold: 8,
        coverageLabel: "inferred",
        headline: clinical ? `${team} finished far better than their chances suggested` : `${team} wasted good chances`,
        whatHappened: `${team} scored ${goals} from chances worth ${fmt(xg, 2)} expected goals across ${shots} shots.`,
        whyItMatters: clinical
          ? "Scoring well above xG in one match usually reflects excellent finishing or goalkeeping errors and is rarely repeatable."
          : "The chances were good enough to score more; over many matches finishing tends to move back towards xG.",
        evidence: {
          ...diff.evidence,
          metrics: [idx.ref("shooting.goals_minus_xg", t), idx.ref("shooting.xg", t), idx.ref("shooting.shots", t)],
        },
        templateKey: clinical ? "finishing_clinical" : "finishing_wasteful",
        view: "shot-map",
        metricKeys: ["shooting.xg", "shooting.goals_minus_xg"],
        advancedExtra: "Single-match goal/xG gaps are noisy; treat as a description, not a skill estimate.",
      }),
    ];
  });
const secondHalfShift = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const team = meta.teamNames[t];
    const p1 = idx.get("pressing.ppda", t, "1H");
    const p2 = idx.get("pressing.ppda", t, "2H");
    const x1 = idx.value("possession.xt_added", t, "1H");
    const x2 = idx.value("possession.xt_added", t, "2H");
    const a1 = p1?.valueJson?.defensiveActions ?? 0;
    const a2 = p2?.valueJson?.defensiveActions ?? 0;
    const out = [];
    if (p1?.value && p2?.value && a1 >= 8 && a2 >= 8) {
      const rel = (p2.value - p1.value) / p1.value;
      if (Math.abs(rel) >= 0.35) {
        const more = rel < 0;
        out.push(
          candidate(meta, {
            kind: "halves.second_half_shift",
            family: "halves",
            teamId: t,
            playerId: null,
            salience: clamp01(Math.abs(rel)),
            sampleSize: Math.min(a1, a2),
            sampleThreshold: 8,
            coverageLabel: "calculated",
            headline: more ? `${team} pressed much harder after half-time` : `${team} dropped off after half-time`,
            whatHappened: `${team}'s PPDA went from ${fmt(p1.value)} in the first half to ${fmt(p2.value)} in the second (lower means more aggressive pressing).`,
            whyItMatters: more
              ? "Pressing higher changes where the ball is won and puts the opponent under more pressure in build-up."
              : "Sitting off lets the opponent build up more freely and moves the game towards their half.",
            evidence: { ...p2.evidence, periods: [1, 2], metrics: [idx.ref("pressing.ppda", t, "1H"), idx.ref("pressing.ppda", t, "2H")] },
            templateKey: more ? "second_half_press_up" : "second_half_press_down",
            view: "pressing",
            scope: "2H",
            metricKeys: ["pressing.ppda"],
          }),
        );
      }
    }
    if (out.length === 0 && x1 !== null && x2 !== null && x1 > 0.05 && x2 > 0) {
      const ratio = x2 / x1;
      if (ratio >= 1.5 || ratio <= 0.66) {
        const up = ratio >= 1.5;
        out.push(
          candidate(meta, {
            kind: "halves.second_half_shift",
            family: "halves",
            teamId: t,
            playerId: null,
            salience: clamp01(up ? ratio - 1 : 1 / ratio - 1),
            sampleSize: idx.get("possession.xt_added", t, "2H")?.sampleSize ?? 0,
            sampleThreshold: 100,
            coverageLabel: "inferred",
            headline: up ? `${team} became much more threatening after half-time` : `${team}'s attacking threat faded after half-time`,
            whatHappened: `The threat ${team} created with passes and carries (xT) went from ${fmt(x1, 2)} in the first half to ${fmt(x2, 2)} in the second.`,
            whyItMatters: up
              ? "Something changed at the break, from tactics to substitutions or the game state, that let them reach dangerous areas more often."
              : "They moved the ball into dangerous areas less often, so the game drifted away from their attack.",
            evidence: {
              eventIds: [],
              totalEvents: 0,
              periods: [1, 2],
              metrics: [idx.ref("possession.xt_added", t, "1H"), idx.ref("possession.xt_added", t, "2H")],
            },
            templateKey: up ? "second_half_threat_up" : "second_half_threat_down",
            view: "progression",
            scope: "2H",
            metricKeys: ["possession.xt_added"],
          }),
        );
      }
    }
    return out;
  });
const scoreStateResponse = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const tr = idx.get("possession.xt_added", t, "trailing");
    const dr = idx.get("possession.xt_added", t, "drawing");
    if (!tr || !dr || tr.value === null || dr.value === null) return [];
    const mt = tr.minutes;
    const md = dr.minutes;
    if (!mt || !md || mt < 10 || md < 10 || dr.value <= 0) return [];
    const perT = tr.value / mt;
    const perD = dr.value / md;
    if (perT < 1.5 * perD) return [];
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "score_state.response",
        family: "score_state",
        teamId: t,
        playerId: null,
        salience: clamp01(perT / perD - 1),
        sampleSize: tr.sampleSize,
        sampleThreshold: 40,
        coverageLabel: "inferred",
        headline: `${team} attacked with far more threat when behind`,
        whatHappened: `While trailing (${fmt(mt, 0)} minutes) ${team} generated ${fmt(perT * 90, 2)} xT per 90 minutes, against ${fmt(perD * 90, 2)} while level.`,
        whyItMatters: "Teams often take more risks when behind; how much they change shows how much they held back before.",
        evidence: {
          ...tr.evidence,
          metrics: [idx.ref("possession.xt_added", t, "trailing"), idx.ref("possession.xt_added", t, "drawing")],
        },
        templateKey: "score_state_response",
        view: "progression",
        scope: "trailing",
        metricKeys: ["possession.xt_added"],
      }),
    ];
  });
const formationChange = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const tl = idx.get("shape.formation_timeline", t);
    const entries = tl?.valueJson?.timeline ?? [];
    const start = entries.find((e) => e.kind === "starting_formation");
    const shifts = entries.filter((e) => e.kind === "tactical_shift" && e.formation && e.formation !== start?.formation);
    if (!tl || !start || !shifts.length) return [];
    const first = shifts[0];
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "shape.formation_change",
        family: "shape",
        teamId: t,
        playerId: null,
        salience: clamp01(0.5 + 0.1 * shifts.length),
        sampleSize: shifts.length,
        sampleThreshold: 1,
        coverageLabel: "observed",
        headline: `${team} switched from a ${start.formation} to a ${first.formation} in the ${ordinal(first.minute)} minute`,
        whatHappened: `${team} started in a ${start.formation} and changed shape ${shifts.length} time${shifts.length > 1 ? "s" : ""}, first to a ${first.formation} after ${first.minute} minutes.`,
        whyItMatters: "A change of shape alters who covers which space; compare pressing and progression before and after the switch.",
        evidence: { ...tl.evidence, metrics: [idx.ref("shape.formation_timeline", t)] },
        templateKey: "formation_change",
        view: "shape",
        metricKeys: ["shape.formation_timeline"],
      }),
    ];
  });
const progressionHub = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const teamTotal = (idx.value("progression.progressive_passes", t) ?? 0) + (idx.value("progression.progressive_carries", t) ?? 0);
    if (teamTotal < 15) return [];
    const players = idx
      .players("progression.progressive_passes", t)
      .map((m) => ({
        playerId: m.playerId,
        n: (m.value ?? 0) + (idx.value("progression.progressive_carries", t, "full", m.playerId) ?? 0),
        evidence: m.evidence,
      }));
    const top = players.sort((a, b) => b.n - a.n)[0];
    if (!top || top.n < 8 || top.n / teamTotal < 0.3) return [];
    const name = meta.playerNames[top.playerId] ?? "A player";
    const team = meta.teamNames[t];
    return [
      candidate(meta, {
        kind: "player.progression_hub",
        family: "player",
        teamId: t,
        playerId: top.playerId,
        salience: clamp01(top.n / teamTotal),
        sampleSize: top.n,
        sampleThreshold: 8,
        coverageLabel: "calculated",
        headline: `${name} drove ${team} forward`,
        whatHappened: `${name} made ${top.n} of ${team}'s ${teamTotal} progressive passes and carries (${pct((top.n / teamTotal) * 100)}).`,
        whyItMatters:
          "When one player carries this much of the progression, stopping them is the opponent’s clearest way to slow the team down.",
        evidence: {
          ...top.evidence,
          metrics: [
            idx.ref("progression.progressive_passes", t, "full", top.playerId),
            idx.ref("progression.progressive_carries", t, "full", top.playerId),
          ],
        },
        templateKey: "progression_hub",
        view: "player",
        metricKeys: ["progression.progressive_passes", "progression.progressive_carries"],
      }),
    ];
  });
const chanceCreator = (idx, meta) =>
  teamsOf(meta).flatMap((t) => {
    const best = idx
      .players("passing.key_passes", t)
      .map((m) => ({ m, xa: idx.value("passing.xa", t, "full", m.playerId) ?? 0 }))
      .filter(({ m, xa }) => (m.value ?? 0) >= 3 || xa >= 0.5)
      .sort((a, b) => b.xa - a.xa || (b.m.value ?? 0) - (a.m.value ?? 0))[0];
    if (!best) return [];
    const name = meta.playerNames[best.m.playerId] ?? "A player";
    return [
      candidate(meta, {
        kind: "player.chance_creator",
        family: "player",
        teamId: t,
        playerId: best.m.playerId,
        salience: clamp01(Math.max((best.m.value ?? 0) / 5, best.xa)),
        sampleSize: best.m.value ?? 0,
        sampleThreshold: 3,
        coverageLabel: "inferred",
        headline: `${name} created ${meta.teamNames[t]}'s best chances`,
        whatHappened: `${name} played ${best.m.value} passes that led to shots, worth ${fmt(best.xa, 2)} expected assists.`,
        whyItMatters: "Expected assists credit the quality of the chance created, whether or not the shot went in.",
        evidence: {
          ...best.m.evidence,
          metrics: [idx.ref("passing.key_passes", t, "full", best.m.playerId), idx.ref("passing.xa", t, "full", best.m.playerId)],
        },
        templateKey: "chance_creator",
        view: "player",
        metricKeys: ["passing.key_passes", "passing.xa"],
      }),
    ];
  });
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
/** Generator order doubles as the tie-break priority. */
export const GENERATORS = [
  ["pressing.high_press_dominance", highPress],
  ["shooting.finishing_variance", finishingVariance],
  ["halves.second_half_shift", secondHalfShift],
  ["shape.formation_change", formationChange],
  ["possession.control_without_threat", controlWithoutThreat],
  ["pressing.high_turnover_threat", highTurnoverThreat],
  ["progression.flank_dominance", flankDominance],
  ["progression.central_access", centralAccess],
  ["score_state.response", scoreStateResponse],
  ["player.progression_hub", progressionHub],
  ["player.chance_creator", chanceCreator],
];
