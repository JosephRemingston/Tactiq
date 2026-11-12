import express from "express";
import cors from "cors";
import helmet from "helmet";
import { timingSafeEqual } from "node:crypto";
import ApiResponse from "./utils/ApiResponse.js";
import ApiError from "./utils/ApiError.js";
import { sendError } from "./utils/asyncHandler.js";
import { uuidv7 } from "./utils/ids.js";
import { getEnv } from "./configs/env.js";
import { ipBackstop, ipRateLimit, strictLimit } from "./middlewares/rateLimit.middleware.js";
import healthRoutes from "./routes/health.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import insightsRoutes from "./routes/insights.routes.js";
import jobsRoutes from "./routes/jobs.routes.js";
import entitlementsRoutes from "./routes/entitlements.routes.js";
import meRoutes from "./routes/me.routes.js";
import footballRoutes from "./routes/football.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import adsRoutes from "./routes/ads.routes.js";

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Builds the Express app. No listening and no connections here, so every entry point can reuse it. */
export function createApp() {
  const env = getEnv();
  var app = express();

  app.disable("x-powered-by");
  // X-Forwarded-For is only trusted when configured (number of proxy hops); clientIp() handles Netlify and Cloudflare.
  if (env.TRUST_PROXY) app.set("trust proxy", env.TRUST_PROXY);

  app.use((req, res, next) => {
    req.id = uuidv7();
    res.setHeader("x-request-id", req.id);
    // Responses can depend on who is asking (plan, ads, private data): never let a shared cache reuse them.
    res.setHeader("Vary", "Authorization");
    if (req.headers.authorization) res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  // The API only returns JSON, so the strictest policy applies: nothing may load, nothing may frame it.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  const origins = env.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      // Native apps send no Origin header and are unaffected; browsers are limited to the allowlist.
      origin: origins.length ? origins : false,
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
      exposedHeaders: ["x-request-id", "x-entitlement-remaining", "retry-after"],
    }),
  );

  // Optional edge gate: once a proxy such as Cloudflare sits in front, only requests it forwarded are accepted.
  if (env.EDGE_SHARED_SECRET) {
    app.use((req, res, next) => {
      if (req.path === "/healthz") return next();
      const presented = req.headers["x-edge-secret"];
      if (typeof presented !== "string" || !safeEqual(presented, env.EDGE_SHARED_SECRET)) {
        return sendError(ApiError.forbidden("Direct access is not allowed"), req, res);
      }
      req.edgeVerified = true;
      next();
    });
  }

  // Every request, whatever route or headers, counts against the per-IP backstop.
  app.use(ipBackstop);

  // Readiness touches the database, Redis and storage, so it gets its own small per-IP budget.
  app.use("/readyz", strictLimit("readyz", 30));
  app.use("/", healthRoutes);

  // Webhook routes verify signatures over the raw bytes, so they are mounted before the JSON parser.
  // Senders are providers, so they are limited per IP more loosely than users; this also caps the
  // security-log rows that rejected (forged) deliveries write.
  app.use(["/v1/webhooks", "/webhooks"], strictLimit("webhook", 300));
  app.use("/v1/webhooks", webhookRoutes);
  app.use("/webhooks", webhookRoutes);

  app.use(express.json({ limit: "256kb" }));
  app.use(ipRateLimit);

  app.get("/", (req, res) => {
    return ApiResponse.success(res, "Tactiq API", { version: "v1" });
  });

  // /matches/compare must be matched before /matches/:matchId, so analytics is mounted first.
  app.use("/v1", analyticsRoutes);
  app.use("/v1", insightsRoutes);
  app.use("/v1", jobsRoutes);
  app.use("/v1", entitlementsRoutes);
  app.use("/v1/me", meRoutes);
  app.use("/v1/billing", billingRoutes);
  app.use("/v1/ads", adsRoutes);
  // Last: this router applies optional auth to everything that reaches it.
  app.use("/v1", footballRoutes);

  app.use((req, res) => {
    return sendError(ApiError.notFound("Route"), req, res);
  });

  // Errors raised outside asyncHandler (body parser, sync middleware).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    return sendError(err, req, res);
  });

  return app;
}

export default createApp;
