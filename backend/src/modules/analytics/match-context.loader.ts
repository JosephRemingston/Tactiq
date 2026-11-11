import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, asc, eq, sql } from 'drizzle-orm';
import { assertFound } from '../../common/errors';
import type { Db } from '../../db/client';
import { events, lineups, matchCoverage, matches, players, teams } from '../../db/schema';
import { DB } from '../../infra/database/database.module';
import { MatchContext } from '../../lib/analytics/context';
import type { AEvent } from '../../lib/analytics/types';

const home = aliasedTable(teams, 'home');
const away = aliasedTable(teams, 'away');

/** Loads everything a MatchContext needs in three queries. */
@Injectable()
export class MatchContextLoader {
  constructor(@Inject(DB) private readonly db: Db) {}

  async load(matchId: string): Promise<{ ctx: MatchContext; coverage: typeof matchCoverage.$inferSelect | null }> {
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
    const meta = assertFound(m, 'Match');
    const [coverage] = await this.db.select().from(matchCoverage).where(eq(matchCoverage.matchId, matchId));
    const evs = (await this.db
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
        detail: sql<Record<string, unknown>>`coalesce(${events.detail}, '{}'::jsonb)`,
      })
      .from(events)
      .where(eq(events.matchId, matchId))
      .orderBy(asc(events.period), asc(events.sequenceIndex))) as AEvent[];
    const lus = await this.db
      .select({
        teamId: lineups.teamId,
        playerId: lineups.playerId,
        playerName: sql<string>`coalesce(${players.knownName}, ${players.fullName})`,
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
