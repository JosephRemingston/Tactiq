import { aliasedTable, asc, eq, sql } from "drizzle-orm";
import ApiError, { assertFound } from "../utils/ApiError.js";
import { events, lineups, matchCoverage, matches, players, teams } from "../models/index.js";
import { MatchContext } from "./analytics/context.js";
const home = aliasedTable(teams, "home");
const away = aliasedTable(teams, "away");
/** Loads everything a MatchContext needs in three queries. */
export class MatchContextLoader {
  constructor(db) {
    this.db = db;
  }
  async load(matchId) {
    const [m] = await this.db
      .select({
        matchId: matches.id,
        competitionId: matches.competitionId,
        seasonId: matches.seasonId,
        homeTeamId: matches.homeTeamId,
        awayTeamId: matches.awayTeamId,
        homeTeamName: home.name,
        awayTeamName: away.name,
        homeScore: matches.homeScore,
        awayScore: matches.awayScore,
      })
      .from(matches)
      .innerJoin(home, eq(home.id, matches.homeTeamId))
      .innerJoin(away, eq(away.id, matches.awayTeamId))
      .where(eq(matches.id, matchId));
    const meta = assertFound(m, "Match");
    const [coverage] = await this.db.select().from(matchCoverage).where(eq(matchCoverage.matchId, matchId));
    const evs = await this.db
      .select({
        id: events.id,
        sequenceIndex: events.sequenceIndex,
        period: events.period,
        clockSeconds: events.clockSeconds,
        minute: events.minute,
        second: events.second,
        typeKey: events.typeKey,
        teamId: events.teamId,
        playerId: events.playerId,
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
        detail: sql`coalesce(${events.detail}, '{}'::jsonb)`,
      })
      .from(events)
      .where(eq(events.matchId, matchId))
      .orderBy(asc(events.period), asc(events.sequenceIndex));
    const lus = await this.db
      .select({
        teamId: lineups.teamId,
        playerId: lineups.playerId,
        playerName: sql`coalesce(${players.knownName}, ${players.fullName})`,
        positionName: lineups.positionName,
        positionGroup: lineups.positionGroup,
        isStarter: lineups.isStarter,
        minuteOn: lineups.minuteOn,
        minuteOff: lineups.minuteOff,
      })
      .from(lineups)
      .innerJoin(players, eq(players.id, lineups.playerId))
      .where(eq(lineups.matchId, matchId));
    const ctx = new MatchContext(meta, evs, lus, {
      hasEvents: coverage?.hasEvents ?? false,
      hasLineups: coverage?.hasLineups ?? false,
      hasFreezeFrames: coverage?.hasFreezeFrames ?? false,
      hasTracking: coverage?.hasTracking ?? false,
      partial: coverage?.dataQuality?.partial ?? false,
    });
    return { ctx, coverage: coverage ?? null };
  }
}
