import { Redis } from "@upstash/redis";
import { getEnv } from "./env.js";

let redisClient = null;
let resolved = false;

/**
 * Upstash is reached over HTTPS (no TCP connections from serverless functions).
 * The REST endpoint is the same host as the rediss:// URL and the REST token is the Redis password.
 */
export function restCredentials(redisUrl) {
  if (!redisUrl) return null;
  let parsed;
  try {
    parsed = new URL(redisUrl);
  } catch {
    return null;
  }
  if (!parsed.hostname.endsWith(".upstash.io") || !parsed.password) return null;
  return { url: `https://${parsed.hostname}`, token: decodeURIComponent(parsed.password) };
}

/** Returns the Redis client, or null when Redis is not configured. The app keeps working without it. */
export const getRedis = () => {
  if (!resolved) {
    resolved = true;
    const creds = restCredentials(getEnv().REDIS_URL);
    if (creds) {
      redisClient = new Redis({ url: creds.url, token: creds.token, retry: { retries: 1 } });
    } else {
      console.warn("Redis is not configured (REDIS_URL is missing or not an Upstash URL): caching and rate limits are off");
    }
  }
  return redisClient;
};

export const isRedisAvailable = () => getRedis() !== null;

export const connectRedis = async () => {
  const redis = getRedis();
  if (!redis) return null;
  try {
    await redis.ping();
    return redis;
  } catch (error) {
    console.warn("Redis ping failed:", error.message);
    return null;
  }
};

/** Cache helpers: every Redis failure degrades to "no cache", never to a failed request. */
export async function cacheGet(key) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get(key)) ?? null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch {
    // ignore
  }
}

export async function cacheDel(...keys) {
  const redis = getRedis();
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    // ignore
  }
}

/** Read-through cache for JSON-serialisable values. */
export async function cached(key, ttlSeconds, load) {
  const hit = await cacheGet(key);
  if (hit !== null) return hit;
  const value = await load();
  if (value !== null && value !== undefined) await cacheSet(key, value, ttlSeconds);
  return value;
}

/** JSON cache with the interface the services use. Keys are versioned by analysis run where possible. */
export const cache = {
  get: cacheGet,
  set: cacheSet,
  del: cacheDel,
  wrap: cached,
};

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Single-instance lock (SET NX PX + compare-and-delete). Without Redis the function simply runs. */
export const locks = {
  async withLock(key, ttlMs, fn) {
    const redis = getRedis();
    if (!redis) return fn();
    const token = crypto.randomUUID();
    let ok = null;
    try {
      ok = await redis.set(`lock:${key}`, token, { nx: true, px: ttlMs });
    } catch {
      return fn(); // Redis unreachable: run rather than block scheduled work
    }
    if (ok !== "OK") return null;
    try {
      return await fn();
    } finally {
      await redis.eval(RELEASE, [`lock:${key}`], [token]).catch(() => undefined);
    }
  },
};
