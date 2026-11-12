import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { clientIp } from "../middlewares/rateLimit.middleware.js";
import { services } from "../services/index.js";

export const schemas = {
  verifyBody: z
    .object({
      productId: z.string().regex(/^[a-z0-9_.]{2,100}$/),
      purchaseToken: z.string().min(10).max(4096),
    })
    .strict(),
};

/** The paywall catalogue: plans, store products and the Free vs Pro comparison. Public. */
const listProducts = asyncHandler(async (req, res) => {
  const catalogue = await services().billing.products();
  return ApiResponse.success(res, "Products retrieved successfully", catalogue);
});

const getSubscription = asyncHandler(async (req, res) => {
  const subscription = await services().billing.subscription(req.user.id);
  return ApiResponse.success(res, "Subscription retrieved successfully", { subscription });
});

/** Called by the app with the token from the Play purchase flow. The backend checks it with Google. */
const verifyGooglePlayPurchase = asyncHandler(async (req, res) => {
  const result = await services().billing.verifyPurchase(req.user.id, req.valid.body, { ip: clientIp(req) });
  return ApiResponse.success(res, "Purchase verified successfully", result);
});

const restorePurchases = asyncHandler(async (req, res) => {
  const result = await services().billing.restore(req.user.id, { ip: clientIp(req) });
  return ApiResponse.success(res, "Purchases restored successfully", result);
});

export { listProducts, getSubscription, verifyGooglePlayPurchase, restorePurchases };
