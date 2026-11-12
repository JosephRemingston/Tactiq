import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { verifySessionToken } from "../configs/clerk.js";
import { services } from "../services/index.js";
import { limitCaller } from "./rateLimit.middleware.js";

function bearer(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

async function attachUser(req, res, required) {
  const token = bearer(req);
  if (!token) {
    // A malformed Authorization header skipped the anonymous IP limit, so count it here.
    if (req.headers.authorization) await limitCaller(req, res);
    if (required) throw ApiError.unauthorized();
    return;
  }
  let session = null;
  try {
    session = await verifySessionToken(token);
  } catch {
    session = null;
  }
  if (!session) {
    await limitCaller(req, res);
    // An invalid token is a 401 even on public routes, so clients refresh it instead of silently browsing signed out.
    throw ApiError.unauthorized("Invalid or expired session token");
  }
  // user_id always comes from the verified token, never from the request.
  req.user = await services().users.resolveSession(session);
  await limitCaller(req, res);
}

/** Private routes: a valid Clerk session token is required. `req.user` is the local user. */
export const authenticate = asyncHandler(async (req, res, next) => {
  await attachUser(req, res, true);
  next();
});

/** Public routes: anonymous requests pass, but a token that is sent must be valid. */
export const optionalAuth = asyncHandler(async (req, res, next) => {
  await attachUser(req, res, false);
  next();
});
