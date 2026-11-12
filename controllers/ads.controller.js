import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { services } from "../services/index.js";

/** Whether ads may show for the caller, where, and with which AdMob units. Pro users get `enabled: false`. */
const getAdsConfig = asyncHandler(async (req, res) => {
  const ads = await services().ads.getConfig(req.user?.id ?? null);
  return ApiResponse.success(res, "Ad configuration retrieved successfully", { ads });
});

export { getAdsConfig };
