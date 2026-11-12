import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { named } from "../utils/respond.js";
import { DEPTHS } from "../models/index.js";
import { services } from "../services/index.js";

export const schemas = {
  matchIdParam: z.object({ matchId: z.uuid() }),
  teamIdParam: z.object({ teamId: z.uuid() }),
  depthQuery: z.object({ depth: z.enum(DEPTHS).default("quick") }),
  styleQuery: z.object({ seasonId: z.uuid().optional() }),
};

// Fan-first layer: free and public. The match explanation is never paywalled.

const listInsights = asyncHandler(async (req, res) => {
  const result = await services().insights.listInsights(req.valid.params.matchId, req.valid.query.depth);
  return ApiResponse.success(res, "Insights retrieved successfully", named("insights", result));
});

const getStory = asyncHandler(async (req, res) => {
  const story = await services().insights.getStory(req.valid.params.matchId, req.valid.query.depth);
  return ApiResponse.success(res, "Match story retrieved successfully", { story });
});

const getTeamStyle = asyncHandler(async (req, res) => {
  const style = await services().insights.getTeamStyle(req.valid.params.teamId, req.valid.query.seasonId);
  return ApiResponse.success(res, "Team style retrieved successfully", { style });
});

export { listInsights, getStory, getTeamStyle };
