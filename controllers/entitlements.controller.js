import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { services } from "../services/index.js";

/** Effective limits and current usage for every feature key: what the app needs to render locks and counters. */
const listEntitlements = asyncHandler(async (req, res) => {
  const { entitlements } = services();
  const [plan, features] = await Promise.all([entitlements.currentPlan(req.user.id), entitlements.resolveAll(req.user.id)]);
  return ApiResponse.success(res, "Entitlements retrieved successfully", { plan, entitlements: features });
});

export { listEntitlements };
