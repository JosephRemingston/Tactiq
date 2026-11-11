import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../../common/auth.decorators';
import { pageQuery } from '../../common/pagination';
import { ApiZod, zp } from '../../common/zod';
import { FootballService } from './football.service';

const id = zp(z.uuid());
const optUuid = z.uuid().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'ISO date expected').optional();
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(item).max(20))
    .optional();

const teamsQuery = pageQuery(50).extend({ competitionId: optUuid, seasonId: optUuid, q: z.string().trim().min(1).max(80).optional() });
const matchesQuery = pageQuery(25).extend({
  competitionId: optUuid,
  seasonId: optUuid,
  teamId: optUuid,
  from: isoDate,
  to: isoDate,
  status: z.enum(['scheduled', 'played']).optional(),
  analysed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
const eventsQuery = pageQuery(200, 500).extend({
  teamId: optUuid,
  playerId: optUuid,
  type: csv(z.string().regex(/^[a-z_]+$/)).describe('Comma-separated canonical event types, e.g. pass,shot'),
  period: z.coerce.number().int().min(1).max(5).optional(),
  possessionId: z.coerce.number().int().positive().optional(),
  include: z.enum(['raw']).optional().describe('raw = include the provider payload (advanced depth)'),
});
const searchQuery = z.object({
  q: z.string().trim().min(2).max(80),
  types: csv(z.enum(['team', 'competition', 'player', 'concept'])),
  limit: z.coerce.number().int().min(1).max(25).default(8),
});

@ApiTags('football')
@Public()
@Controller()
export class FootballController {
  constructor(private readonly football: FootballService) {}

  @Get('competitions')
  @ApiZod({ query: z.object({ q: z.string().max(80).optional() }) })
  competitions(@Query(zp(z.object({ q: z.string().trim().max(80).optional() }))) q: { q?: string }) {
    return this.football.listCompetitions(q.q);
  }

  @Get('competitions/:id')
  competition(@Param('id', id) competitionId: string) {
    return this.football.getCompetition(competitionId);
  }

  @Get('competitions/:id/seasons')
  async competitionSeasons(@Param('id', id) competitionId: string) {
    return { data: (await this.football.getCompetition(competitionId)).seasons };
  }

  @Get('teams')
  @ApiZod({ query: teamsQuery })
  teams(@Query(zp(teamsQuery)) q: z.infer<typeof teamsQuery>) {
    return this.football.listTeams(q);
  }

  @Get('teams/:id')
  team(@Param('id', id) teamId: string) {
    return this.football.getTeam(teamId);
  }

  @Get('teams/:id/players')
  @ApiZod({ query: z.object({ seasonId: optUuid }) })
  teamPlayers(@Param('id', id) teamId: string, @Query(zp(z.object({ seasonId: optUuid }))) q: { seasonId?: string }) {
    return this.football.teamPlayers(teamId, q.seasonId);
  }

  /** Seasons and data types available for the team: fixtures, events, freeze frames, tracking, video. */
  @Get('teams/:id/coverage')
  teamCoverage(@Param('id', id) teamId: string) {
    return this.football.teamCoverage(teamId);
  }

  @Get('players/:id')
  player(@Param('id', id) playerId: string) {
    return this.football.getPlayer(playerId);
  }

  @Get('players/:id/matches')
  @ApiZod({ query: pageQuery(25) })
  playerMatches(@Param('id', id) playerId: string, @Query(zp(pageQuery(25))) q: z.infer<ReturnType<typeof pageQuery>>) {
    return this.football.playerMatches(playerId, q.limit, q.cursor);
  }

  @Get('search')
  @ApiZod({ query: searchQuery })
  search(@Query(zp(searchQuery)) q: z.infer<typeof searchQuery>) {
    return this.football.search(q.q, q.types ?? ['team', 'competition', 'player', 'concept'], q.limit);
  }

  @Get('matches')
  @ApiZod({ query: matchesQuery })
  matches(@Query(zp(matchesQuery)) q: z.infer<typeof matchesQuery>) {
    return this.football.listMatches(q);
  }

  /** Match centre header, including coverage flags and licence attribution. */
  @Get('matches/:matchId')
  match(@Param('matchId', id) matchId: string) {
    return this.football.getMatch(matchId);
  }

  @Get('matches/:matchId/lineups')
  lineups(@Param('matchId', id) matchId: string) {
    return this.football.matchLineups(matchId);
  }

  /** Match timeline. Free for everyone (PDF: core match centre is never paywalled). */
  @Get('matches/:matchId/events')
  @ApiZod({ query: eventsQuery })
  events(@Param('matchId', id) matchId: string, @Query(zp(eventsQuery)) q: z.infer<typeof eventsQuery>) {
    return this.football.matchEvents(matchId, { ...q, includeRaw: q.include === 'raw' });
  }

  @Get('concepts')
  @ApiZod({ query: z.object({ category: z.string().max(40).optional() }) })
  concepts(@Query(zp(z.object({ category: z.string().max(40).optional() }))) q: { category?: string }) {
    return this.football.listConcepts(q.category);
  }

  @Get('concepts/:key')
  concept(@Param('key', zp(z.string().regex(/^[a-z0-9-]{2,60}$/))) key: string) {
    return this.football.getConcept(key);
  }

  @Get('metric-definitions')
  @ApiZod({ query: z.object({ family: z.string().max(40).optional() }) })
  metricDefinitions(@Query(zp(z.object({ family: z.string().max(40).optional() }))) q: { family?: string }) {
    return this.football.listMetricDefinitions(q.family);
  }

  @Get('metric-definitions/:key')
  @ApiZod({ query: z.object({ version: z.coerce.number().int().positive().optional() }) })
  metricDefinition(@Param('key', zp(z.string().regex(/^[a-z0-9_.]{3,80}$/))) key: string, @Query(zp(z.object({ version: z.coerce.number().int().positive().optional() }))) q: { version?: number }) {
    return this.football.getMetricDefinition(key, q.version);
  }
}
