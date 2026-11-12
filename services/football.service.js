import { aliasedTable, and, asc, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import ApiError, { assertFound } from "../utils/ApiError.js";
import { decodeCursor, toPage } from "../utils/pagination.js";
import {
  competitions,
  dataLicences,
  events,
  lineups,
  matchCoverage,
  matches,
  matchParticipants,
  metricDefinitions,
  players,
  playerTeamAssignments,
  seasons,
  tacticalConcepts,
  teams,
} from "../models/index.js";
const homeTeam = aliasedTable(teams, "home_team");
const awayTeam = aliasedTable(teams, "away_team");
/** Coverage label shown to clients before they expect advanced features (PDF section 3). */
export function coverageLevel(c) {
  if (!c) return "fixtures_only";
  if (c.hasTracking) return "tracking";
  if (c.hasFreezeFrames) return "events_and_freeze_frames";
  if (c.hasEvents) return "events";
  return "fixtures_only";
}
/** Read models for shared football data. Public, read-only, never filtered by user. */
export class FootballService {
  constructor(db, cache, config) {
    this.db = db;
    this.cache = cache;
    this.config = config;
  }
  async listCompetitions(q) {
    const rows = await this.db
      .select({
        id: competitions.id,
        name: competitions.name,
        countryName: competitions.countryName,
        gender: competitions.gender,
        isInternational: competitions.isInternational,
        seasons: sql`coalesce(json_agg(json_build_object('id', ${seasons.id}, 'name', ${seasons.name}) order by ${seasons.name} desc) filter (where ${seasons.id} is not null), '[]')`,
      })
      .from(competitions)
      .leftJoin(seasons, eq(seasons.competitionId, competitions.id))
      .where(q ? ilike(competitions.name, `%${q}%`) : undefined)
      .groupBy(competitions.id)
      .orderBy(asc(competitions.name));
    return { data: rows };
  }
  async getCompetition(id) {
    const [c] = await this.db.select().from(competitions).where(eq(competitions.id, id));
    assertFound(c, "Competition");
    const seasonRows = await this.db.execute(sql`
      select s.id, s.name,
             count(m.id)::int as matches,
             count(m.id) filter (where mc.has_events)::int as with_events,
             count(m.id) filter (where m.analysis_status = 'complete')::int as analysed
      from ${seasons} s
      left join ${matches} m on m.season_id = s.id
      left join ${matchCoverage} mc on mc.match_id = m.id
      where s.competition_id = ${id}
      group by s.id, s.name order by s.name desc`);
    return {
      id: c.id,
      name: c.name,
      countryName: c.countryName,
      gender: c.gender,
      isInternational: c.isInternational,
      seasons: seasonRows.rows.map((s) => ({
        id: s.id,
        name: s.name,
        coverage: { matches: s.matches, withEvents: s.with_events, analysed: s.analysed },
      })),
    };
  }
  async listTeams(query) {
    const conds = [];
    if (query.q) conds.push(ilike(teams.name, `%${query.q}%`));
    if (query.competitionId || query.seasonId) {
      conds.push(sql`exists (select 1 from ${matches} m where (m.home_team_id = ${teams.id} or m.away_team_id = ${teams.id})
        ${query.competitionId ? sql`and m.competition_id = ${query.competitionId}` : sql``}
        ${query.seasonId ? sql`and m.season_id = ${query.seasonId}` : sql``})`);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) conds.push(sql`(${teams.name}, ${teams.id}) > (${String(cursor[0])}, ${cursor[1]})`);
    const rows = await this.db
      .select({ id: teams.id, name: teams.name, countryName: teams.countryName, isNationalTeam: teams.isNationalTeam })
      .from(teams)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(teams.name), asc(teams.id))
      .limit(query.limit + 1);
    return toPage(rows, query.limit, (r) => [r.name, r.id]);
  }
  async getTeam(id) {
    const [t] = await this.db.select().from(teams).where(eq(teams.id, id));
    assertFound(t, "Team");
    const recent = await this.listMatches({ teamId: id, limit: 5 });
    const seasonsPlayed = await this.db.execute(sql`
      select s.id as season_id, s.name as season_name, c.id as competition_id, c.name as competition_name, count(*)::int as matches
      from ${matches} m join ${seasons} s on s.id = m.season_id join ${competitions} c on c.id = m.competition_id
      where m.home_team_id = ${id} or m.away_team_id = ${id}
      group by s.id, s.name, c.id, c.name order by s.name desc`);
    return {
      id: t.id,
      name: t.name,
      countryName: t.countryName,
      isNationalTeam: t.isNationalTeam,
      gender: t.gender,
      seasons: seasonsPlayed.rows.map((r) => ({
        seasonId: r.season_id,
        seasonName: r.season_name,
        competitionId: r.competition_id,
        competitionName: r.competition_name,
        matches: r.matches,
      })),
      recentMatches: recent.data,
    };
  }
  async teamPlayers(teamId, seasonId) {
    await this.getTeamOrThrow(teamId);
    const rows = await this.db
      .selectDistinctOn([players.id], {
        id: players.id,
        name: players.fullName,
        knownName: players.knownName,
        countryName: players.countryName,
        jerseyNumber: playerTeamAssignments.jerseyNumber,
        seasonId: playerTeamAssignments.seasonId,
      })
      .from(playerTeamAssignments)
      .innerJoin(players, eq(players.id, playerTeamAssignments.playerId))
      .where(and(eq(playerTeamAssignments.teamId, teamId), seasonId ? eq(playerTeamAssignments.seasonId, seasonId) : undefined))
      .orderBy(players.id, desc(playerTeamAssignments.createdAt));
    const positions = await this.db.execute(sql`
      select l.player_id, mode() within group (order by l.position_group) as position_group, count(*)::int as appearances, count(*) filter (where l.is_starter)::int as starts
      from ${lineups} l join ${matches} m on m.id = l.match_id
      where l.team_id = ${teamId} ${seasonId ? sql`and m.season_id = ${seasonId}` : sql``}
      group by l.player_id`);
    const byPlayer = new Map(positions.rows.map((p) => [p.player_id, p]));
    return {
      data: rows
        .map((r) => ({
          ...r,
          positionGroup: byPlayer.get(r.id)?.position_group ?? null,
          appearances: byPlayer.get(r.id)?.appearances ?? 0,
          starts: byPlayer.get(r.id)?.starts ?? 0,
        }))
        .sort((a, b) => b.appearances - a.appearances || a.name.localeCompare(b.name)),
    };
  }
  /** Which seasons and data types exist for a team (PDF: never imply data that does not exist). */
  async teamCoverage(teamId) {
    await this.getTeamOrThrow(teamId);
    const rows = await this.db.execute(sql`
      select s.id as season_id, s.name as season_name, c.name as competition_name,
             count(*)::int as fixtures,
             count(*) filter (where mc.has_events)::int as events,
             count(*) filter (where mc.has_freeze_frames)::int as freeze_frames,
             count(*) filter (where mc.has_tracking)::int as tracking,
             count(*) filter (where mc.has_video)::int as video,
             count(*) filter (where m.analysis_status = 'complete')::int as analysed,
             array_remove(array_agg(distinct mc.event_provider), null) as providers
      from ${matches} m
      join ${seasons} s on s.id = m.season_id join ${competitions} c on c.id = m.competition_id
      left join ${matchCoverage} mc on mc.match_id = m.id
      where m.home_team_id = ${teamId} or m.away_team_id = ${teamId}
      group by s.id, s.name, c.name order by s.name desc`);
    return {
      teamId,
      seasons: rows.rows.map((r) => ({
        seasonId: r.season_id,
        seasonName: r.season_name,
        competitionName: r.competition_name,
        matches: {
          fixtures: r.fixtures,
          events: r.events,
          freezeFrames: r.freeze_frames,
          tracking: r.tracking,
          video: r.video,
          analysed: r.analysed,
        },
        providers: r.providers ?? [],
      })),
    };
  }
  async getTeamOrThrow(teamId) {
    const [t] = await this.db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
    return assertFound(t, "Team");
  }
  async getPlayer(id) {
    const [p] = await this.db.select().from(players).where(eq(players.id, id));
    assertFound(p, "Player");
    const spells = await this.db
      .select({
        teamId: teams.id,
        teamName: teams.name,
        seasonId: seasons.id,
        seasonName: seasons.name,
        jerseyNumber: playerTeamAssignments.jerseyNumber,
      })
      .from(playerTeamAssignments)
      .innerJoin(teams, eq(teams.id, playerTeamAssignments.teamId))
      .innerJoin(seasons, eq(seasons.id, playerTeamAssignments.seasonId))
      .where(eq(playerTeamAssignments.playerId, id))
      .orderBy(desc(seasons.name));
    const [apps] = (
      await this.db.execute(sql`
      select count(*)::int as appearances, count(*) filter (where is_starter)::int as starts,
             mode() within group (order by position_group) as position_group, mode() within group (order by position_name) as position_name
      from ${lineups} where player_id = ${id}`)
    ).rows;
    return {
      id: p.id,
      name: p.fullName,
      knownName: p.knownName,
      countryName: p.countryName,
      positionGroup: apps?.position_group ?? null,
      positionName: apps?.position_name ?? null,
      appearances: apps?.appearances ?? 0,
      starts: apps?.starts ?? 0,
      teams: spells,
    };
  }
  async playerMatches(playerId, limit, cursor) {
    const [p] = await this.db.select({ id: players.id }).from(players).where(eq(players.id, playerId));
    assertFound(p, "Player");
    const ids = this.db.select({ id: lineups.matchId }).from(lineups).where(eq(lineups.playerId, playerId));
    return this.listMatches({ limit, cursor }, inArray(matches.id, ids));
  }
  async search(q, types, limit = 8) {
    const out = {};
    const like = `%${q}%`;
    if (types.includes("competition")) {
      out.competitions = await this.db
        .select({ id: competitions.id, name: competitions.name, countryName: competitions.countryName })
        .from(competitions)
        .where(or(ilike(competitions.name, like), sql`similarity(${competitions.name}, ${q}) > 0.3`))
        .orderBy(sql`similarity(${competitions.name}, ${q}) desc`)
        .limit(limit);
    }
    if (types.includes("team")) {
      out.teams = await this.db
        .select({ id: teams.id, name: teams.name, countryName: teams.countryName, isNationalTeam: teams.isNationalTeam })
        .from(teams)
        .where(or(ilike(teams.name, like), sql`similarity(${teams.name}, ${q}) > 0.3`))
        .orderBy(sql`similarity(${teams.name}, ${q}) desc`)
        .limit(limit);
    }
    if (types.includes("player")) {
      out.players = await this.db
        .select({ id: players.id, name: players.fullName, knownName: players.knownName, countryName: players.countryName })
        .from(players)
        .where(or(ilike(players.fullName, like), ilike(players.knownName, like), sql`similarity(${players.fullName}, ${q}) > 0.3`))
        .orderBy(sql`greatest(similarity(${players.fullName}, ${q}), similarity(coalesce(${players.knownName}, ''), ${q})) desc`)
        .limit(limit);
    }
    if (types.includes("concept")) {
      out.concepts = await this.db
        .select({ key: tacticalConcepts.key, name: tacticalConcepts.name, simpleText: tacticalConcepts.simpleText })
        .from(tacticalConcepts)
        .where(or(ilike(tacticalConcepts.name, like), ilike(tacticalConcepts.key, like)))
        .limit(limit);
    }
    return out;
  }
  /** Match list with cursor on (kickoff_at desc, id desc), matching matches_comp_season_kickoff_idx. */
  async listMatches(query, extra) {
    const conds = [];
    if (query.competitionId) conds.push(eq(matches.competitionId, query.competitionId));
    if (query.seasonId) conds.push(eq(matches.seasonId, query.seasonId));
    if (query.teamId) conds.push(or(eq(matches.homeTeamId, query.teamId), eq(matches.awayTeamId, query.teamId)));
    if (query.from) conds.push(gte(matches.kickoffAt, new Date(query.from)));
    if (query.to) conds.push(lte(matches.kickoffAt, new Date(query.to)));
    if (query.status) conds.push(eq(matches.status, query.status));
    if (query.analysed !== undefined)
      conds.push(query.analysed ? eq(matches.analysisStatus, "complete") : sql`${matches.analysisStatus} <> 'complete'`);
    if (extra) conds.push(extra);
    const cursor = decodeCursor(query.cursor);
    if (cursor) conds.push(sql`(${matches.kickoffAt}, ${matches.id}) < (${new Date(String(cursor[0]))}, ${cursor[1]})`);
    const rows = await this.db
      .select({
        id: matches.id,
        kickoffAt: matches.kickoffAt,
        status: matches.status,
        stage: matches.stage,
        competition: { id: competitions.id, name: competitions.name },
        season: { id: seasons.id, name: seasons.name },
        home: { id: homeTeam.id, name: homeTeam.name, score: matches.homeScore },
        away: { id: awayTeam.id, name: awayTeam.name, score: matches.awayScore },
        analysisStatus: matches.analysisStatus,
        coverage: {
          hasEvents: matchCoverage.hasEvents,
          hasFreezeFrames: matchCoverage.hasFreezeFrames,
          hasTracking: matchCoverage.hasTracking,
          hasVideo: matchCoverage.hasVideo,
        },
      })
      .from(matches)
      .innerJoin(competitions, eq(competitions.id, matches.competitionId))
      .innerJoin(seasons, eq(seasons.id, matches.seasonId))
      .innerJoin(homeTeam, eq(homeTeam.id, matches.homeTeamId))
      .innerJoin(awayTeam, eq(awayTeam.id, matches.awayTeamId))
      .leftJoin(matchCoverage, eq(matchCoverage.matchId, matches.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(matches.kickoffAt), desc(matches.id))
      .limit(query.limit + 1);
    const shaped = rows.map((r) => ({
      ...r,
      coverage: {
        ...r.coverage,
        hasEvents: Boolean(r.coverage?.hasEvents),
        hasFreezeFrames: Boolean(r.coverage?.hasFreezeFrames),
        hasTracking: Boolean(r.coverage?.hasTracking),
        hasVideo: Boolean(r.coverage?.hasVideo),
        level: coverageLevel(r.coverage),
      },
    }));
    return toPage(shaped, query.limit, (r) => [r.kickoffAt.toISOString(), r.id]);
  }
  async matchExists(id) {
    const [m] = await this.db.select({ id: matches.id }).from(matches).where(eq(matches.id, id));
    assertFound(m, "Match");
  }
  /** Match centre header: teams, score, formations, coverage, licence attribution and analysis state. */
  async getMatch(id) {
    return this.cache.wrap(`cache:match:${id}:summary`, this.config.CACHE_TTL_MATCH_SECONDS, async () => {
      const page = await this.listMatches({ limit: 1 }, eq(matches.id, id));
      const m = assertFound(page.data[0], "Match");
      const [row] = await this.db
        .select({
          matchWeek: matches.matchWeek,
          stadiumName: matches.stadiumName,
          refereeName: matches.refereeName,
          analysisRunId: matches.analysisRunId,
          analysedAt: matches.analysedAt,
          analyticsVersion: matches.analyticsVersion,
          pitchLengthM: matches.pitchLengthM,
          pitchWidthM: matches.pitchWidthM,
        })
        .from(matches)
        .where(eq(matches.id, id));
      const participants = await this.db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id));
      const [cov] = await this.db
        .select({ coverage: matchCoverage, licence: dataLicences })
        .from(matchCoverage)
        .leftJoin(dataLicences, eq(dataLicences.id, matchCoverage.licenceId))
        .where(eq(matchCoverage.matchId, id));
      const formation = (teamId) => participants.find((p) => p.teamId === teamId);
      const c = cov?.coverage;
      return {
        ...m,
        home: { ...m.home, formation: formation(m.home.id)?.startingFormation ?? null, manager: formation(m.home.id)?.managerName ?? null },
        away: { ...m.away, formation: formation(m.away.id)?.startingFormation ?? null, manager: formation(m.away.id)?.managerName ?? null },
        matchWeek: row?.matchWeek ?? null,
        stadiumName: row?.stadiumName ?? null,
        refereeName: row?.refereeName ?? null,
        pitch: { lengthM: row?.pitchLengthM ?? 105, widthM: row?.pitchWidthM ?? 68 },
        analysis: {
          status: m.analysisStatus,
          runId: row?.analysisRunId ?? null,
          analysedAt: row?.analysedAt ?? null,
          analyticsVersion: row?.analyticsVersion ?? null,
        },
        coverage: {
          level: coverageLevel(c ?? null),
          hasLineups: c?.hasLineups ?? false,
          hasEvents: c?.hasEvents ?? false,
          hasFreezeFrames: c?.hasFreezeFrames ?? false,
          hasTracking: c?.hasTracking ?? false,
          hasVideo: c?.hasVideo ?? false,
          eventsCount: c?.eventsCount ?? 0,
          eventProvider: c?.eventProvider ?? null,
          dataQuality: c?.dataQuality ?? null,
          retrievedAt: c?.retrievedAt ?? null,
          unavailable: [
            ...(c?.hasEvents ? [] : ["events", "tactical_metrics"]),
            ...(c?.hasFreezeFrames ? [] : ["freeze_frames"]),
            ...(c?.hasTracking ? [] : ["tracking", "team_shape", "off_ball_runs", "physical_load"]),
            ...(c?.hasVideo ? [] : ["video"]),
          ],
        },
        licence: cov?.licence
          ? {
              id: cov.licence.id,
              name: cov.licence.name,
              attribution: cov.licence.attributionText,
              commercialUseAllowed: cov.licence.commercialUseAllowed,
            }
          : null,
      };
    });
  }
  async matchLineups(id) {
    await this.matchExists(id);
    const rows = await this.db
      .select({
        teamId: lineups.teamId,
        teamName: teams.name,
        playerId: lineups.playerId,
        playerName: players.fullName,
        knownName: players.knownName,
        jerseyNumber: lineups.jerseyNumber,
        positionName: lineups.positionName,
        positionGroup: lineups.positionGroup,
        isStarter: lineups.isStarter,
        minuteOn: lineups.minuteOn,
        minuteOff: lineups.minuteOff,
        cards: lineups.cards,
      })
      .from(lineups)
      .innerJoin(players, eq(players.id, lineups.playerId))
      .innerJoin(teams, eq(teams.id, lineups.teamId))
      .where(eq(lineups.matchId, id))
      .orderBy(asc(teams.name), desc(lineups.isStarter), asc(lineups.jerseyNumber));
    const byTeam = new Map();
    for (const r of rows) {
      const t = byTeam.get(r.teamId) ?? { teamId: r.teamId, teamName: r.teamName, starters: [], substitutes: [] };
      (r.isStarter ? t.starters : t.substitutes).push(r);
      byTeam.set(r.teamId, t);
    }
    return { data: [...byTeam.values()] };
  }
  /** Paginated, filterable timeline (PDF 4.1: event search and filters). Cursor = sequence index. */
  async matchEvents(id, q) {
    await this.matchExists(id);
    const conds = [eq(events.matchId, id)];
    if (q.teamId) conds.push(eq(events.teamId, q.teamId));
    if (q.playerId) conds.push(eq(events.playerId, q.playerId));
    if (q.type?.length) conds.push(inArray(events.typeKey, q.type));
    if (q.period) conds.push(eq(events.period, q.period));
    if (q.possessionId) conds.push(eq(events.possessionId, q.possessionId));
    const cursor = decodeCursor(q.cursor);
    if (cursor) conds.push(gt(events.sequenceIndex, Number(cursor[0])));
    const rows = await this.db
      .select({
        id: events.id,
        sequenceIndex: events.sequenceIndex,
        period: events.period,
        minute: events.minute,
        second: events.second,
        clockSeconds: events.clockSeconds,
        type: events.typeKey,
        teamId: events.teamId,
        playerId: events.playerId,
        playerName: players.fullName,
        positionName: events.positionName,
        possessionId: events.possessionId,
        possessionTeamId: events.possessionTeamId,
        playPattern: events.playPattern,
        x: events.x,
        y: events.y,
        endX: events.endX,
        endY: events.endY,
        outcome: events.outcome,
        underPressure: events.underPressure,
        counterpress: events.counterpress,
        duration: events.duration,
        relatedEventIds: events.relatedEventIds,
        detail: events.detail,
        ...(q.includeRaw ? { raw: events.raw } : {}),
      })
      .from(events)
      .leftJoin(players, eq(players.id, events.playerId))
      .where(and(...conds))
      .orderBy(asc(events.sequenceIndex))
      .limit(q.limit + 1);
    return toPage(rows, q.limit, (r) => [r.sequenceIndex, r.id]);
  }
  async listConcepts(category) {
    const rows = await this.db
      .select()
      .from(tacticalConcepts)
      .where(category ? eq(tacticalConcepts.category, category) : undefined)
      .orderBy(asc(tacticalConcepts.category), asc(tacticalConcepts.name));
    return { data: rows };
  }
  async getConcept(key) {
    const [c] = await this.db.select().from(tacticalConcepts).where(eq(tacticalConcepts.key, key));
    assertFound(c, "Concept");
    const metrics = c.linkedMetricKeys.length
      ? await this.db
          .select({
            key: metricDefinitions.key,
            version: metricDefinitions.version,
            name: metricDefinitions.name,
            descriptionQuick: metricDefinitions.descriptionQuick,
            status: metricDefinitions.status,
          })
          .from(metricDefinitions)
          .where(inArray(metricDefinitions.key, c.linkedMetricKeys))
      : [];
    const related = c.relatedKeys.length
      ? await this.db
          .select({ key: tacticalConcepts.key, name: tacticalConcepts.name })
          .from(tacticalConcepts)
          .where(inArray(tacticalConcepts.key, c.relatedKeys))
      : [];
    return { ...c, metrics, related };
  }
  async listMetricDefinitions(family) {
    const rows = await this.db
      .select()
      .from(metricDefinitions)
      .where(family ? eq(metricDefinitions.family, family) : undefined)
      .orderBy(asc(metricDefinitions.family), asc(metricDefinitions.key), desc(metricDefinitions.version));
    return { data: rows };
  }
  async getMetricDefinition(key, version) {
    const [row] = await this.db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.key, key), version ? eq(metricDefinitions.version, version) : undefined))
      .orderBy(desc(metricDefinitions.version))
      .limit(1);
    return assertFound(row, "Metric definition");
  }
}
