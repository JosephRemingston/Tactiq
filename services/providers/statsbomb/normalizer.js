import { statsBombToCanonical } from "../../../utils/pitch.js";
import { ProviderSchemaError } from "../provider.js";
import { sbCompetitionsSchema, sbEventsSchema, sbLineupSchema, sbMatchesSchema, sbThreeSixtySchema } from "./schemas.js";
import { formatFormation, normalizeOutcome, positionGroup, snake, STATSBOMB_TAXONOMY_VERSION, STATSBOMB_TYPE_MAP } from "./taxonomy.js";
export const STATSBOMB_SCHEMA_VERSION = "sb-open-v4";
function parse(schema, raw, what) {
  const res = schema.safeParse(raw);
  if (!res.success) {
    const first = res.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ProviderSchemaError(`StatsBomb ${what} payload failed validation (${res.error.issues.length} issues): ${first.join("; ")}`);
  }
  return res.data;
}
const toDate = (s) => (s ? new Date(s.endsWith("Z") ? s : `${s}Z`) : null);
const gender = (g) => (g === "male" || g === "female" ? g : null);
/** "86:24" -> 86 */
const minuteOf = (t) => (t ? Number.parseInt(t.split(":")[0], 10) : null);
/** "00:41:20.088" -> 2480.088 seconds since the start of the period. */
const clock = (ts) => {
  const [h, m, s] = ts.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
const nameOf = (o) => (o && typeof o === "object" && "name" in o ? String(o.name) : null);
const idOf = (o) => (o && typeof o === "object" && "id" in o ? String(o.id) : null);
const snakeName = (o) => {
  const n = nameOf(o);
  return n ? snake(n) : null;
};
function pt(loc) {
  if (!loc || loc.length < 2) return null;
  const c = statsBombToCanonical(loc[0], loc[1]);
  return { x: c.x, y: c.y, rawX: loc[0], rawY: loc[1] };
}
/** Type-specific detail with provider player ids under `*ProviderPlayerId` keys (rewritten at ingestion). */
function detailOf(e) {
  const pass = e.pass;
  if (pass) {
    return {
      recipientProviderPlayerId: idOf(pass.recipient),
      height: snakeName(pass.height),
      passType: snakeName(pass.type),
      bodyPart: snakeName(pass.body_part),
      technique: snakeName(pass.technique),
      cross: Boolean(pass.cross),
      switch: Boolean(pass.switch),
      throughBall: Boolean(pass.through_ball),
      cutBack: Boolean(pass.cut_back),
      shotAssist: Boolean(pass.shot_assist),
      goalAssist: Boolean(pass.goal_assist),
      assistedShotProviderEventId: pass.assisted_shot_id ?? null,
      aerialWon: Boolean(pass.aerial_won),
    };
  }
  const shot = e.shot;
  if (shot) {
    const end = shot.end_location;
    const frame = shot.freeze_frame ?? [];
    return {
      xg: typeof shot.statsbomb_xg === "number" ? shot.statsbomb_xg : null,
      xgModel: "statsbomb",
      endZ: end.length > 2 ? end[2] : null,
      shotType: snakeName(shot.type),
      technique: snakeName(shot.technique),
      bodyPart: snakeName(shot.body_part),
      firstTime: Boolean(shot.first_time),
      keyPassProviderEventId: shot.key_pass_id ?? null,
      freezeFrame: frame.map((p) => ({
        ...statsBombToCanonical(p.location[0], p.location[1]),
        teammate: p.teammate,
        positionName: p.position?.name ?? null,
        providerPlayerId: String(p.player?.id ?? ""),
      })),
    };
  }
  const tactics = e.tactics;
  if (tactics) {
    return {
      formation: formatFormation(tactics.formation),
      lineup: tactics.lineup.map((l) => ({
        providerPlayerId: String(l.player.id),
        positionName: l.position.name,
        jerseyNumber: l.jersey_number,
      })),
    };
  }
  const sub = e.substitution;
  if (sub) return { replacementProviderPlayerId: String(sub.replacement.id), reason: snakeName(sub.outcome) };
  const pick = (key, map) => {
    const o = e[key];
    return o ? map(o) : null;
  };
  return (
    pick("duel", (o) => ({ duelType: snakeName(o.type) })) ??
    pick("goalkeeper", (o) => ({ gkType: snakeName(o.type), technique: snakeName(o.technique), bodyPart: snakeName(o.body_part) })) ??
    pick("foul_committed", (o) => ({ card: snakeName(o.card), penalty: Boolean(o.penalty), advantage: Boolean(o.advantage) })) ??
    pick("foul_won", (o) => ({ penalty: Boolean(o.penalty), advantage: Boolean(o.advantage), defensive: Boolean(o.defensive) })) ??
    pick("ball_recovery", (o) => ({ recoveryFailure: Boolean(o.recovery_failure), offensive: Boolean(o.offensive) })) ??
    pick("dribble", (o) => ({ nutmeg: Boolean(o.nutmeg), overrun: Boolean(o.overrun) })) ??
    pick("clearance", (o) => ({ aerialWon: Boolean(o.aerial_won), bodyPart: snakeName(o.body_part) })) ??
    pick("block", (o) => ({ deflection: Boolean(o.deflection), offensive: Boolean(o.offensive), saveBlock: Boolean(o.save_block) })) ??
    pick("bad_behaviour", (o) => ({ card: snakeName(o.card) })) ??
    {}
  );
}
function outcomeOf(e, typeKey) {
  for (const key of ["pass", "shot", "duel", "interception", "dribble", "goalkeeper", "50_50", "ball_receipt"]) {
    const o = e[key];
    if (o?.outcome) return normalizeOutcome(o.outcome.name);
  }
  if (typeKey === "pass" || typeKey === "carry" || typeKey === "ball_receipt") return "complete";
  if (typeKey === "ball_recovery") return e.ball_recovery?.recovery_failure ? "failure" : "success";
  return null;
}
export class StatsBombNormalizer {
  constructor() {
    this.provider = "statsbomb";
    this.taxonomyVersion = STATSBOMB_TAXONOMY_VERSION;
    this.schemaVersion = STATSBOMB_SCHEMA_VERSION;
  }
  normalizeCompetitions(raw) {
    return parse(sbCompetitionsSchema, raw, "competitions").map((c) => ({
      competition: {
        id: String(c.competition_id),
        name: c.competition_name,
        countryName: c.country_name ?? null,
        gender: gender(c.competition_gender),
        isYouth: Boolean(c.competition_youth),
        isInternational: Boolean(c.competition_international),
      },
      season: { id: String(c.season_id), name: c.season_name },
      matchesUpdatedAt: toDate(c.match_updated),
    }));
  }
  normalizeMatches(raw) {
    return parse(sbMatchesSchema, raw, "matches").map((m) => {
      const team = (side) => {
        const t = m[`${side}_team`];
        const name = String(t[`${side}_team_name`]);
        const country = t.country?.name ?? null;
        return {
          id: String(t[`${side}_team_id`]),
          name,
          countryName: country,
          gender: gender(t[`${side}_team_gender`]),
          isNationalTeam: Boolean(m.competition && country && name.replace(/ (Women's|U\d+)$/, "") === country),
          managerName: t.managers?.[0]?.nickname ?? t.managers?.[0]?.name ?? null,
        };
      };
      const kick = m.kick_off ? m.kick_off.slice(0, 8) : "00:00:00";
      const played = m.match_status === "available" && m.home_score != null && m.away_score != null;
      return {
        ref: { id: String(m.match_id), name: `${String(m.home_team.home_team_name)} v ${String(m.away_team.away_team_name)}` },
        competition: { id: String(m.competition.competition_id), name: m.competition.competition_name },
        season: { id: String(m.season.season_id), name: m.season.season_name },
        home: team("home"),
        away: team("away"),
        kickoffAt: new Date(`${m.match_date}T${kick}Z`),
        matchDate: m.match_date,
        status: played ? "played" : "scheduled",
        homeScore: m.home_score ?? null,
        awayScore: m.away_score ?? null,
        matchWeek: m.match_week ?? null,
        stage: m.competition_stage?.name ?? null,
        stadiumName: m.stadium?.name ?? null,
        refereeName: m.referee?.name ?? null,
        providerUpdatedAt: toDate(m.last_updated),
        providerUpdated360At: toDate(m.last_updated_360),
        freezeFrameStatus: m.match_status_360 ?? null,
      };
    });
  }
  normalizeLineups(raw) {
    const out = [];
    for (const team of parse(sbLineupSchema, raw, "lineups")) {
      for (const p of team.lineup) {
        const positions = p.positions;
        const first = positions[0];
        const last = positions[positions.length - 1];
        const isStarter = first?.start_reason === "Starting XI";
        out.push({
          team: { id: String(team.team_id), name: team.team_name },
          player: {
            id: String(p.player_id),
            name: p.player_name,
            knownName: p.player_nickname ?? null,
            countryName: p.country?.name ?? null,
          },
          jerseyNumber: p.jersey_number ?? null,
          positionName: first?.position ?? null,
          positionGroup: positionGroup(first?.position),
          isStarter,
          minuteOn: positions.length === 0 ? null : isStarter ? 0 : minuteOf(first?.from),
          minuteOff: last?.to ? minuteOf(last.to) : null,
          cards: (p.cards ?? []).map((c) => ({ minute: minuteOf(c.time) ?? 0, type: snake(c.card_type), reason: c.reason })),
        });
      }
    }
    return out;
  }
  normalizeEvents(raw) {
    const parsed = parse(sbEventsSchema, raw, "events");
    const unknownTypes = new Set();
    let missingLocation = 0;
    let locatable = 0;
    let withoutPlayer = 0;
    const periods = new Set();
    let hasXg = false;
    const events = parsed.map((e) => {
      const typeName = e.type.name;
      const typeKey = STATSBOMB_TYPE_MAP[typeName] ?? "unknown";
      if (typeKey === "unknown") unknownTypes.add(typeName);
      periods.add(e.period);
      const start = pt(e.location);
      const endLoc = e.pass?.end_location ?? e.carry?.end_location ?? e.shot?.end_location;
      const end = pt(endLoc);
      const onBall = ![
        "starting_xi",
        "tactical_shift",
        "half_start",
        "half_end",
        "substitution",
        "injury_stoppage",
        "player_on",
        "player_off",
        "bad_behaviour",
        "camera_on",
        "camera_off",
      ].includes(typeKey);
      if (onBall) {
        locatable++;
        if (!start) missingLocation++;
        if (!e.player) withoutPlayer++;
      }
      if (typeKey === "shot" && typeof e.shot?.statsbomb_xg === "number") hasXg = true;
      return {
        providerEventId: e.id,
        sequenceIndex: e.index,
        period: e.period,
        clockSeconds: Math.round(clock(e.timestamp) * 1000) / 1000,
        minute: e.minute,
        second: e.second,
        typeKey,
        providerTypeName: typeName,
        teamProviderId: String(e.team.id),
        playerProviderId: e.player ? String(e.player.id) : null,
        positionName: e.position?.name ?? null,
        possessionId: e.possession,
        possessionTeamProviderId: String(e.possession_team.id),
        playPattern: snake(e.play_pattern.name),
        x: start?.x ?? null,
        y: start?.y ?? null,
        endX: end?.x ?? null,
        endY: end?.y ?? null,
        rawX: start?.rawX ?? null,
        rawY: start?.rawY ?? null,
        rawEndX: end?.rawX ?? null,
        rawEndY: end?.rawY ?? null,
        outcome: outcomeOf(e, typeKey),
        underPressure: Boolean(e.under_pressure),
        counterpress: Boolean(e.counterpress),
        duration: e.duration ?? null,
        relatedProviderEventIds: e.related_events ?? [],
        detail: detailOf(e),
        raw: e,
      };
    });
    const missingLocationPct = locatable ? missingLocation / locatable : 0;
    const periodsPresent = [...periods].sort();
    const notes = [];
    if (events.length < 1500) notes.push(`Only ${events.length} events: coverage may be partial.`);
    if (missingLocationPct > 0.1) notes.push(`${Math.round(missingLocationPct * 100)}% of on-ball events have no location.`);
    if (!periods.has(1) || !periods.has(2)) notes.push("Regular-time periods are incomplete.");
    if (unknownTypes.size) notes.push(`Unmapped event types: ${[...unknownTypes].join(", ")}`);
    const quality = {
      missingLocationPct: Math.round(missingLocationPct * 10_000) / 10_000,
      eventsWithoutPlayer: withoutPlayer,
      periodsPresent,
      hasExtraTime: periods.has(3) || periods.has(4),
      hasShootout: periods.has(5),
      unknownTypeNames: [...unknownTypes],
      xgSource: hasXg ? "provider:statsbomb" : null,
      partial: events.length < 1500 || missingLocationPct > 0.1 || !periods.has(1) || !periods.has(2),
      notes,
    };
    return { events, quality };
  }
  normalizeFreezeFrames(raw) {
    return parse(sbThreeSixtySchema, raw, "three-sixty").map((f) => {
      const area = [];
      const va = f.visible_area ?? [];
      for (let i = 0; i + 1 < va.length; i += 2) {
        const c = statsBombToCanonical(va[i], va[i + 1]);
        area.push([c.x, c.y]);
      }
      return {
        providerEventId: f.event_uuid,
        visibleArea: area,
        frame: f.freeze_frame.map((p) => ({
          ...statsBombToCanonical(p.location[0], p.location[1]),
          teammate: p.teammate,
          actor: p.actor,
          keeper: p.keeper,
        })),
      };
    });
  }
}
