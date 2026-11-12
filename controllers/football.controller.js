import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { intParam, isoDateParam, pageQuery } from "../utils/pagination.js";
import { named } from "../utils/respond.js";
import { services } from "../services/index.js";

const optUuid = z.uuid().optional();
const isoDate = isoDateParam().optional();
const csv = (item) =>
  z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(20))
    .optional();

/** Request schemas, used by the routes through the validate middleware. */
export const schemas = {
  idParam: z.object({ id: z.uuid() }),
  matchIdParam: z.object({ matchId: z.uuid() }),
  conceptKeyParam: z.object({ key: z.string().regex(/^[a-z0-9-]{2,60}$/) }),
  metricKeyParam: z.object({ key: z.string().regex(/^[a-z0-9_.]{3,80}$/) }),
  competitionsQuery: z.object({ q: z.string().trim().max(80).optional() }),
  teamsQuery: pageQuery(50).extend({ competitionId: optUuid, seasonId: optUuid, q: z.string().trim().min(1).max(80).optional() }),
  teamPlayersQuery: z.object({ seasonId: optUuid }),
  playerMatchesQuery: pageQuery(25),
  matchesQuery: pageQuery(25).extend({
    competitionId: optUuid,
    seasonId: optUuid,
    teamId: optUuid,
    from: isoDate,
    to: isoDate,
    status: z.enum(["scheduled", "played"]).optional(),
    analysed: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  }),
  eventsQuery: pageQuery(200, 500).extend({
    teamId: optUuid,
    playerId: optUuid,
    type: csv(z.string().regex(/^[a-z_]+$/)),
    period: intParam(1, 5).optional(),
    possessionId: intParam(1, 100_000).optional(),
    include: z.enum(["raw"]).optional(),
  }),
  searchQuery: z.object({
    q: z.string().trim().min(2).max(80),
    types: csv(z.enum(["team", "competition", "player", "concept"])),
    limit: intParam(1, 25).default(8),
  }),
  conceptsQuery: z.object({ category: z.string().max(40).optional() }),
  metricDefinitionsQuery: z.object({ family: z.string().max(40).optional() }),
  metricDefinitionQuery: z.object({ version: intParam(1, 10_000).optional() }),
};

const listCompetitions = asyncHandler(async (req, res) => {
  const result = await services().football.listCompetitions(req.valid.query.q);
  return ApiResponse.success(res, "Competitions retrieved successfully", named("competitions", result));
});

const getCompetition = asyncHandler(async (req, res) => {
  const competition = await services().football.getCompetition(req.valid.params.id);
  return ApiResponse.success(res, "Competition retrieved successfully", { competition });
});

const listCompetitionSeasons = asyncHandler(async (req, res) => {
  const competition = await services().football.getCompetition(req.valid.params.id);
  return ApiResponse.success(res, "Seasons retrieved successfully", { seasons: competition.seasons });
});

const listTeams = asyncHandler(async (req, res) => {
  const result = await services().football.listTeams(req.valid.query);
  return ApiResponse.success(res, "Teams retrieved successfully", named("teams", result));
});

const getTeam = asyncHandler(async (req, res) => {
  const team = await services().football.getTeam(req.valid.params.id);
  return ApiResponse.success(res, "Team retrieved successfully", { team });
});

const listTeamPlayers = asyncHandler(async (req, res) => {
  const result = await services().football.teamPlayers(req.valid.params.id, req.valid.query.seasonId);
  return ApiResponse.success(res, "Team players retrieved successfully", named("players", result));
});

/** Seasons and data types available for the team: fixtures, events, freeze frames, tracking, video. */
const getTeamCoverage = asyncHandler(async (req, res) => {
  const coverage = await services().football.teamCoverage(req.valid.params.id);
  return ApiResponse.success(res, "Team coverage retrieved successfully", named("seasons", coverage));
});

const getPlayer = asyncHandler(async (req, res) => {
  const player = await services().football.getPlayer(req.valid.params.id);
  return ApiResponse.success(res, "Player retrieved successfully", { player });
});

const listPlayerMatches = asyncHandler(async (req, res) => {
  const q = req.valid.query;
  const result = await services().football.playerMatches(req.valid.params.id, q.limit, q.cursor);
  return ApiResponse.success(res, "Player matches retrieved successfully", named("matches", result));
});

const search = asyncHandler(async (req, res) => {
  const q = req.valid.query;
  const { football, ads } = services();
  const result = await football.search(q.q, q.types ?? ["team", "competition", "player", "concept"], q.limit);
  const total = Object.values(result).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const adSlots = await ads.slotsFor(req.user?.id ?? null, "explore", total);
  return ApiResponse.success(res, "Search results retrieved successfully", { ...named("results", result), adSlots });
});

const listMatches = asyncHandler(async (req, res) => {
  const { football, ads } = services();
  const result = await football.listMatches(req.valid.query);
  const adSlots = await ads.slotsFor(req.user?.id ?? null, "explore", result.data?.length ?? 0);
  return ApiResponse.success(res, "Matches retrieved successfully", { ...named("matches", result), adSlots });
});

/** Match centre header, including coverage flags and licence attribution. */
const getMatch = asyncHandler(async (req, res) => {
  const match = await services().football.getMatch(req.valid.params.matchId);
  return ApiResponse.success(res, "Match retrieved successfully", { match });
});

const getMatchLineups = asyncHandler(async (req, res) => {
  const result = await services().football.matchLineups(req.valid.params.matchId);
  return ApiResponse.success(res, "Lineups retrieved successfully", named("lineups", result));
});

/** Match timeline. Free for everyone: the core match centre is never paywalled. */
const listMatchEvents = asyncHandler(async (req, res) => {
  const q = req.valid.query;
  const result = await services().football.matchEvents(req.valid.params.matchId, { ...q, includeRaw: q.include === "raw" });
  return ApiResponse.success(res, "Events retrieved successfully", named("events", result));
});

const listConcepts = asyncHandler(async (req, res) => {
  const result = await services().football.listConcepts(req.valid.query.category);
  return ApiResponse.success(res, "Concepts retrieved successfully", named("concepts", result));
});

const getConcept = asyncHandler(async (req, res) => {
  const concept = await services().football.getConcept(req.valid.params.key);
  return ApiResponse.success(res, "Concept retrieved successfully", { concept });
});

const listMetricDefinitions = asyncHandler(async (req, res) => {
  const result = await services().football.listMetricDefinitions(req.valid.query.family);
  return ApiResponse.success(res, "Metric definitions retrieved successfully", named("metricDefinitions", result));
});

const getMetricDefinition = asyncHandler(async (req, res) => {
  const metricDefinition = await services().football.getMetricDefinition(req.valid.params.key, req.valid.query.version);
  return ApiResponse.success(res, "Metric definition retrieved successfully", { metricDefinition });
});

export {
  listCompetitions,
  getCompetition,
  listCompetitionSeasons,
  listTeams,
  getTeam,
  listTeamPlayers,
  getTeamCoverage,
  getPlayer,
  listPlayerMatches,
  search,
  listMatches,
  getMatch,
  getMatchLineups,
  listMatchEvents,
  listConcepts,
  getConcept,
  listMetricDefinitions,
  getMetricDefinition,
};
