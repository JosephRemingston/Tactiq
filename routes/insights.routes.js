import express from "express";
import { schemas, listInsights, getStory, getTeamStyle } from "../controllers/insights.controller.js";
import { optionalAuth } from "../middlewares/auth.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";

var router = express.Router();

router.get("/matches/:matchId/insights", optionalAuth, validate({ params: schemas.matchIdParam, query: schemas.depthQuery }), listInsights);
router.get("/matches/:matchId/story", optionalAuth, validate({ params: schemas.matchIdParam, query: schemas.depthQuery }), getStory);
router.get("/teams/:teamId/style", optionalAuth, validate({ params: schemas.teamIdParam, query: schemas.styleQuery }), getTeamStyle);

export default router;
