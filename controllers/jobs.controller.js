import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { services } from "../services/index.js";

export const schemas = {
  matchIdParam: z.object({ matchId: z.uuid() }),
  jobIdParam: z.object({ jobId: z.string().regex(/^[\w.-]{3,200}$/) }),
};

/**
 * Queue (re)analysis of a match. Returns 202 with a job to poll; existing work is returned instead of duplicated.
 * The job is picked up by the next scheduled worker run, so `retry-after` is generous.
 */
const requestAnalysis = asyncHandler(async (req, res) => {
  const job = await services().jobs.requestAnalysis(req.valid.params.matchId, req.user.id);
  res.setHeader("retry-after", "60");
  return ApiResponse.accepted(res, "Analysis job accepted", { job });
});

/** Poll for status. Visible to the requester, or to anyone for public match-analysis jobs. */
const getJob = asyncHandler(async (req, res) => {
  const job = await services().jobs.get(req.valid.params.jobId, req.user?.id);
  return ApiResponse.success(res, "Job retrieved successfully", { job });
});

export { requestAnalysis, getJob };
