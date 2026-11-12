import { z } from "zod";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import { DEPTHS } from "../models/index.js";
import { clientIp } from "../middlewares/rateLimit.middleware.js";
import { services } from "../services/index.js";

export const schemas = {
  patchMe: z
    .object({
      displayName: z.string().trim().min(1).max(80).optional(),
      locale: z
        .string()
        .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
        .optional(),
      // Default explanation depth; users can still switch per screen.
      depthPreference: z.enum(DEPTHS).optional(),
      interests: z
        .array(z.enum(["match_explanations", "tactics", "players", "learning", "detailed_stats"]))
        .max(5)
        .optional(),
    })
    .strict(),
  sessionIdParam: z.object({ sessionId: z.string().min(1).max(64) }),
};

const getMe = asyncHandler(async (req, res) => {
  const user = await services().users.getMe(req.user.id);
  return ApiResponse.success(res, "Profile retrieved successfully", { user });
});

const updateMe = asyncHandler(async (req, res) => {
  const user = await services().users.updateMe(req.user, req.valid.body);
  return ApiResponse.success(res, "Profile updated successfully", { user });
});

/** Deletes private data and the Clerk identity. Shared football data is untouched. */
const deleteMe = asyncHandler(async (req, res) => {
  const { users, security } = services();
  const ip = clientIp(req);
  await security.record("account_delete_requested", { userId: req.user.id, ip, userAgent: req.headers["user-agent"] ?? null });
  const result = await users.deleteAccount({ userId: req.user.id, clerkUserId: req.user.clerkUserId, initiatedBy: "user", ip });
  return ApiResponse.success(res, "Account deleted successfully", result ?? { deleted: true });
});

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await services().identity.listSessions(req.user.clerkUserId);
  return ApiResponse.success(res, "Sessions retrieved successfully", { sessions });
});

const revokeSession = asyncHandler(async (req, res) => {
  const { identity, security } = services();
  const sessionId = req.valid.params.sessionId;
  const ok = await identity.revokeSession(req.user.clerkUserId, sessionId);
  if (!ok) throw ApiError.notFound("Session");
  await security.record("session_revoked", { userId: req.user.id, ip: clientIp(req), metadata: { sessionId } });
  return ApiResponse.success(res, "Session revoked successfully", { revoked: true });
});

export { getMe, updateMe, deleteMe, listSessions, revokeSession };
