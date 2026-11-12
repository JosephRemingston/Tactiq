import express from "express";
import {
  schemas,
  compare,
  getMetrics,
  getTacticalShape,
  getPressing,
  getTransitions,
  listPossessions,
  getMatchPlayer,
} from "../controllers/analytics.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { historyGate, requiresFeatureWhen } from "../middlewares/entitlement.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";

var router = express.Router();

// Declared before any /matches/:matchId route so "compare" is never read as a match id.
router.get("/matches/compare", authenticate, validate({ query: schemas.compareQuery }), compare);

// Possession filters are an advanced (Pro) option; the unfiltered list is part of the metered analysis views.
const advancedPossessions = requiresFeatureWhen("analysis.advanced_filters", (req) => Boolean(req.query.teamId || req.query.endType));

// Every per-match analysis view: signed in, within the history allowance, then metered in the controller.
const matchView = [authenticate, historyGate()];

router.get("/matches/:matchId/metrics", ...matchView, validate({ params: schemas.matchIdParam, query: schemas.metricsQuery }), getMetrics);
router.get("/matches/:matchId/tactical-shape", ...matchView, validate({ params: schemas.matchIdParam, query: schemas.shapeQuery }), getTacticalShape);
router.get("/matches/:matchId/pressing", ...matchView, validate({ params: schemas.matchIdParam }), getPressing);
router.get("/matches/:matchId/transitions", ...matchView, validate({ params: schemas.matchIdParam }), getTransitions);
router.get(
  "/matches/:matchId/possessions",
  ...matchView,
  advancedPossessions,
  validate({ params: schemas.matchIdParam, query: schemas.possessionsQuery }),
  listPossessions,
);
router.get("/matches/:matchId/players/:playerId", ...matchView, validate({ params: schemas.matchPlayerParams }), getMatchPlayer);

export default router;
