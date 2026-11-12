import { Ratelimit } from "@upstash/ratelimit";
import ApiError from "../utils/ApiError.js";
import { sendError } from "../utils/asyncHandler.js";
import { getEnv } from "../configs/env.js";
import { getRedis } from "../configs/redis.js";

/**
 * Rate limiting.
 *
 * Limits are counted in Upstash Redis so every serverless instance shares them. When Redis is missing or failing,
 * the same limits are counted in this process's memory instead: weaker (per instance), but abuse controls never
 * switch off just because the shared store is down.
 */

const limiters = new Map();

function redisLimiter(name, limit, windowSeconds) {
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

/** Fixed-window counters in process memory. Bounded: old windows are dropped when the map grows. */
const memory = new Map();
const MEMORY_MAX_KEYS = 50_000;

export function memoryHit(name, id, limit, windowSeconds, now = Date.now()) {
  const key = `${name}:${id}`;
  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    if (memory.size >= MEMORY_MAX_KEYS) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
      if (memory.size >= MEMORY_MAX_KEYS) memory.clear();
    }
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
    memory.set(key, entry);
  }
  entry.count += 1;
  return { success: entry.count <= limit, reset: entry.resetAt };
}

/** Test hook. */
export function resetMemoryLimits() {
  memory.clear();
  limiters.clear();
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
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function tooMany(res, reset) {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  res?.setHeader("retry-after", String(retryAfter));
  return ApiError.tooManyRequests("Too many requests", { retryAfterSeconds: retryAfter });
}

/**
 * Counts one request against a named limit and throws 429 when it is exceeded.
 * Uses Redis when it is available; otherwise (or when a Redis call fails) the in-memory fallback.
 */
export async function hit(name, id, limit, windowSeconds, res) {
  let result = null;
  try {
    const l = redisLimiter(name, limit, windowSeconds);
    if (l) result = await l.limit(id);
  } catch {
    result = null; // Redis failing: fall through to the memory limiter rather than letting traffic through
  }
  if (!result) result = memoryHit(name, id, limit, windowSeconds);
  if (!result.success) throw tooMany(res, result.reset);
}

/**
 * Backstop for every request, counted per IP in memory only (no Redis cost): catches floods that the user/IP
 * limits never see, such as webhooks, health checks and requests carrying a fake Authorization header.
 */
export const ipBackstop = (req, res, next) => {
  const limit = getEnv().THROTTLE_IP_BACKSTOP_PER_MIN;
  const r = memoryHit("backstop", clientIp(req), limit, 60);
  if (!r.success) return sendError(tooMany(res, r.reset), req, res);
  next();
};

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
export const strictLimit =
  (name, limit, windowSeconds = 60) =>
  async (req, res, next) => {
    try {
      await hit(name, req.user?.id ?? clientIp(req), limit, windowSeconds, res);
      next();
    } catch (err) {
      sendError(err, req, res);
    }
  };
