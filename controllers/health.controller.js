import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { getPool } from "../configs/database.js";
import { getRedis } from "../configs/redis.js";
import { getStorage } from "../configs/s3.js";

/** Liveness: the process is up. */
const health = asyncHandler(async (req, res) => {
  return ApiResponse.success(res, "API is working", {
    status: "UP",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

async function check(fn) {
  try {
    return (await fn()) !== false ? "ok" : "down";
  } catch {
    return "down";
  }
}

/** Readiness: every dependency the API needs answers. Redis is optional, so "off" does not degrade readiness. */
const ready = asyncHandler(async (req, res) => {
  const redis = getRedis();
  const [database, redisState, storage] = await Promise.all([
    check(() => getPool().query("select 1")),
    redis ? check(() => redis.ping()) : Promise.resolve("off"),
    check(() => getStorage().ping()),
  ]);
  const checks = { database, redis: redisState, storage };
  const ok = database === "ok" && storage === "ok" && redisState !== "down";
  if (!ok) return ApiResponse.error(res, 503, "Service degraded", { status: "degraded", checks });
  return ApiResponse.success(res, "Service ready", { status: "ok", checks });
});

export { health, ready };
