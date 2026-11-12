import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import { toProfile } from "../configs/clerk.js";
import { clientIp } from "../middlewares/rateLimit.middleware.js";
import { services } from "../services/index.js";

/**
 * Clerk user lifecycle webhooks (Svix-signed). The route is mounted with a raw body parser, because the
 * signature covers the exact bytes. Replays with an already-processed delivery id are no-ops.
 */
const receiveClerkWebhook = asyncHandler(async (req, res) => {
  const { identity, users, security } = services();
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw ApiError.validation([{ path: "body", message: "raw body required" }]);

  let event;
  try {
    event = await identity.verifyWebhook(req.body, req.headers);
  } catch (err) {
    // Signing secret not configured (503) or a correctly signed but malformed event (400).
    if (err instanceof ApiError && (err.statusCode === 503 || err.statusCode === 400)) throw err;
    await security.record("webhook_rejected", { ip: clientIp(req), metadata: { reason: err.message } });
    throw ApiError.unauthorized("Invalid webhook signature");
  }
  if (event.id && (await security.webhookSeen(event.id))) {
    return ApiResponse.success(res, "Webhook already processed", { received: true, duplicate: true });
  }

  const clerkUserId = typeof event.data.id === "string" ? event.data.id : null;
  switch (event.type) {
    case "user.created":
    case "user.updated":
      if (clerkUserId) {
        await users.upsert(toProfile(event.data), "webhook");
        await users.invalidate(clerkUserId);
      }
      break;
    case "user.deleted":
      if (clerkUserId) await users.deleteAccount({ clerkUserId, initiatedBy: "clerk_webhook" });
      break;
    default:
      break; // other event types are acknowledged and ignored
  }
  await security.record("webhook_received", { ip: clientIp(req), metadata: { deliveryId: event.id, type: event.type, clerkUserId } });
  return ApiResponse.success(res, "Webhook received", { received: true });
});

export { receiveClerkWebhook };

/**
 * Google Play Real-time Developer Notifications (Pub/Sub push). The push subscription URL carries
 * `?token=<GOOGLE_PLAY_RTDN_TOKEN>`. A 2xx tells Pub/Sub the message is handled; a 5xx makes it retry.
 */
const receiveGooglePlayNotification = asyncHandler(async (req, res) => {
  const { billing, security } = services();
  let body;
  try {
    body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
  } catch {
    throw ApiError.badRequest("Body is not valid JSON");
  }
  try {
    const result = await billing.handleRtdn(body, typeof req.query.token === "string" ? req.query.token : "");
    return ApiResponse.success(res, "Notification received", { received: true, ...result });
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      await security.record("webhook_rejected", { ip: clientIp(req), metadata: { source: "google_play_rtdn" } });
    }
    throw err;
  }
});

export { receiveGooglePlayNotification };
