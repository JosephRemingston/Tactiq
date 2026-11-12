import express from "express";
import {
  schemas,
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
} from "../controllers/football.controller.js";
import { optionalAuth } from "../middlewares/auth.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";
import { requiresFeatureWhen } from "../middlewares/entitlement.middleware.js";

// The match timeline is free. Filtering it (by type, player, team, period, possession) or asking for the raw
// provider payload is an advanced option.
const EVENT_FILTERS = ["type", "playerId", "teamId", "period", "possessionId", "include"];
const advancedEvents = requiresFeatureWhen("analysis.advanced_filters", (req) => EVENT_FILTERS.some((k) => req.query[k] !== undefined));

var router = express.Router();

// Shared football data: public and read-only. A token is optional, but one that is sent must be valid.
router.use(optionalAuth);

router.get("/competitions", validate({ query: schemas.competitionsQuery }), listCompetitions);
router.get("/competitions/:id", validate({ params: schemas.idParam }), getCompetition);
router.get("/competitions/:id/seasons", validate({ params: schemas.idParam }), listCompetitionSeasons);

router.get("/teams", validate({ query: schemas.teamsQuery }), listTeams);
router.get("/teams/:id", validate({ params: schemas.idParam }), getTeam);
router.get("/teams/:id/players", validate({ params: schemas.idParam, query: schemas.teamPlayersQuery }), listTeamPlayers);
router.get("/teams/:id/coverage", validate({ params: schemas.idParam }), getTeamCoverage);

router.get("/players/:id", validate({ params: schemas.idParam }), getPlayer);
router.get("/players/:id/matches", validate({ params: schemas.idParam, query: schemas.playerMatchesQuery }), listPlayerMatches);

router.get("/search", validate({ query: schemas.searchQuery }), search);

router.get("/matches", validate({ query: schemas.matchesQuery }), listMatches);
router.get("/matches/:matchId", validate({ params: schemas.matchIdParam }), getMatch);
router.get("/matches/:matchId/lineups", validate({ params: schemas.matchIdParam }), getMatchLineups);
router.get("/matches/:matchId/events", advancedEvents, validate({ params: schemas.matchIdParam, query: schemas.eventsQuery }), listMatchEvents);

router.get("/concepts", validate({ query: schemas.conceptsQuery }), listConcepts);
router.get("/concepts/:key", validate({ params: schemas.conceptKeyParam }), getConcept);

router.get("/metric-definitions", validate({ query: schemas.metricDefinitionsQuery }), listMetricDefinitions);
router.get("/metric-definitions/:key", validate({ params: schemas.metricKeyParam, query: schemas.metricDefinitionQuery }), getMetricDefinition);

export default router;
