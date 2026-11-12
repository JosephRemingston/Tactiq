import { Ratelimit } from "@upstash/ratelimit";
import ApiError from "../utils/ApiError.js";
import { sendError } from "../utils/asyncHandler.js";
import { getEnv } from "../configs/env.js";
import { getRedis } from "../configs/redis.js";

const limiters = new Map();

function limiter(name, limit, windowSeconds) {
  const redis = getRedis();
  if (!redis) return null;
  const key = `${name}:${limit}:${windowSeconds}`;
  let l = limiters.get(key);
  if (!l) {
    l = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
      prefix: `rl:${name}`,
      ephemeralCache: new Map(),
      analytics: false,
    });
    limiters.set(key, l);
  }
  return l;
}

const onNetlify = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

/**
 * The caller's address. Client-supplied headers are only believed when a proxy we control sets them:
 *   - behind Cloudflare (EDGE_SHARED_SECRET verified in app.js): CF-Connecting-IP
 *   - inside Netlify Functions: x-nf-client-connection-ip, which Netlify's edge sets
 *   - otherwise: req.ip (the socket address, or X-Forwarded-For only when TRUST_PROXY is configured)
 */
export function clientIp(req) {
  if (req.edgeVerified) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
  }
  if (onNetlify) {
    const nf = req.headers["x-nf-client-connection-ip"];
    if (typeof nf === "string" && nf) return nf;
  }
  return req.ip || "unknown";
}

/**
 * Counts one request against a named limit. Throws 429 when exceeded.
 * Redis problems never block a request: the limiter fails open.
 */
export async function hit(name, id, limit, windowSeconds, res) {
  const l = limiter(name, limit, windowSeconds);
  if (!l) return;
  let result;
  try {
    result = await l.limit(id);
  } catch {
    return;
  }
  if (!result.success) {
    const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
    res?.setHeader("retry-after", String(retryAfter));
    throw ApiError.tooManyRequests("Too many requests", { retryAfterSeconds: retryAfter });
  }
}

/** Anonymous requests are limited per IP. Requests carrying a token are limited per user by the auth middleware. */
export const ipRateLimit = async (req, res, next) => {
  try {
    if (!req.headers.authorization) await hit("ip", clientIp(req), getEnv().THROTTLE_IP_PER_MIN, 60, res);
    next();
  } catch (err) {
    sendError(err, req, res);
  }
};

/** Called by the auth middleware once the caller is known (or the token turned out to be invalid). */
export async function limitCaller(req, res) {
  const env = getEnv();
  if (req.user?.id) await hit("user", req.user.id, env.THROTTLE_USER_PER_MIN, 60, res);
  else await hit("ip", clientIp(req), env.THROTTLE_IP_PER_MIN, 60, res);
}

/** A tighter limit for one route (job creation, purchases). Keyed by user when signed in, else by IP. */
export const strictLimit = (name, limit, windowSeconds = 60) => async (req, res, next) => {
  try {
    await hit(name, req.user?.id ?? clientIp(req), limit, windowSeconds, res);
    next();
  } catch (err) {
    sendError(err, req, res);
  }
};
