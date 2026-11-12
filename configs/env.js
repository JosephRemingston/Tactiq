import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Optional string where an empty value means "not set". */
const optStr = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/** Single source of truth for every environment variable the backend reads. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(3),
  REDIS_URL: optStr(),

  /** neon / s3 = S3-compatible bucket via the S3_* vars; fs = local disk (tests, offline development). */
  STORAGE_DRIVER: z.enum(["neon", "s3", "fs"]).default("fs"),
  STORAGE_FS_ROOT: z.string().default(".data/storage"),
  S3_ENDPOINT: optStr(),
  S3_REGION_OVERRIDE: optStr(),
  S3_BUCKET_RAW: z.string().default("tactiq-raw"),
  S3_ACCESS_KEY_ID: optStr(),
  S3_SECRET_ACCESS_KEY: optStr(),
  /** Keep the full provider event JSON in Postgres too. Off by default: raw payloads already live in object storage. */
  EVENTS_STORE_RAW: bool.default(false),

  CLERK_SECRET_KEY: optStr(),
  CLERK_PUBLISHABLE_KEY: optStr(),
  /** PEM public key for networkless JWT verification. */
  CLERK_JWT_KEY: optStr(),
  CLERK_AUTHORIZED_PARTIES: z.string().default(""),
  CLERK_WEBHOOK_SIGNING_SECRET: optStr(),

  STATSBOMB_SOURCE: z.enum(["github", "local"]).default("github"),
  STATSBOMB_OPEN_DATA_BASE_URL: z.string().default("https://raw.githubusercontent.com/statsbomb/open-data/master/data"),
  STATSBOMB_OPEN_DATA_LOCAL_DIR: optStr(),
  STATSBOMB_COMPETITION_ALLOWLIST: z.string().default("43:106,43:3"),
  STATSBOMB_RATE_PER_SECOND: z.coerce.number().positive().default(2),
  STATSBOMB_USER_AGENT: z.string().default("Tactiq/1.0"),
  SPORTMONKS_API_TOKEN: optStr(),

  /** Team season style recompute is debounced: one pending job per team-season. It has the lowest priority, so it runs after the matches. */
  TEAM_STYLE_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Retry delay = min(base * 2^(attempt-1), 30 min) + jitter. */
  QUEUE_BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(60_000),
  /** Time budget for one worker.js run. */
  WORKER_BUDGET_MS: z.coerce.number().int().positive().default(20 * 60_000),

  /** Comma-separated browser origins allowed to call the API cross-origin. Native apps need none. */
  CORS_ORIGINS: z.string().default(""),
  THROTTLE_IP_PER_MIN: z.coerce.number().int().positive().default(120),
  THROTTLE_USER_PER_MIN: z.coerce.number().int().positive().default(600),
  /** Per-IP backstop for every request (in-memory, per instance), above the anonymous and per-user limits. */
  THROTTLE_IP_BACKSTOP_PER_MIN: z.coerce.number().int().positive().default(1200),
  CACHE_TTL_MATCH_SECONDS: z.coerce.number().int().positive().default(60),
  /** Proxy hops whose X-Forwarded-For may be trusted (Express "trust proxy"). Unset: not trusted. */
  TRUST_PROXY: z.coerce.number().int().nonnegative().optional(),
  /** When set, every request must carry this value in x-edge-secret (added by an edge proxy such as Cloudflare). */
  EDGE_SHARED_SECRET: optStr(),

  /** Google Play Billing. Billing endpoints answer 503 until all three are set. */
  GOOGLE_PLAY_PACKAGE_NAME: optStr(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: optStr(),
  GOOGLE_PLAY_RTDN_TOKEN: optStr(),
  /** Use the fake purchase verifier (tests, local development). Ignored in production. */
  BILLING_FAKE_VERIFIER: bool.default(false),

  /** AdMob ad unit ids. Google's public test units are used when unset. */
  ADMOB_NATIVE_UNIT_ID: optStr(),
  ADMOB_BANNER_UNIT_ID: optStr(),
});

const here = dirname(fileURLToPath(import.meta.url));

/** Env files in precedence order (earlier files win; real environment variables always win). */
export function envFiles() {
  const root = resolve(here, "..");
  const candidates = [resolve(root, ".env.local"), resolve(root, ".env")];
  return [...new Set(candidates)].filter((f) => existsSync(f));
}

let cached = null;

/** Loads `.env` files once (local runs only), then validates process.env. Throws a readable message on invalid config. */
export function getEnv(overrides = {}) {
  if (cached && Object.keys(overrides).length === 0) return cached;
  // Hosted runtimes (Netlify, GitHub Actions) inject real variables; .env files only exist on a developer machine.
  // Tests never read them: a developer's .env holds production credentials, and a test that forgot to set a
  // variable must fail rather than silently pick up a real database or key.
  if (!cached && !process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.NODE_ENV !== "test") {
    for (const file of envFiles()) {
      try {
        process.loadEnvFile(file);
      } catch {
        // unreadable env file: fall back to the real environment
      }
    }
  }
  const parsed = envSchema
    .superRefine((c, ctx) => {
      if (c.CLERK_SECRET_KEY && !c.CLERK_SECRET_KEY.startsWith("sk_")) {
        ctx.addIssue({ code: "custom", path: ["CLERK_SECRET_KEY"], message: "CLERK_SECRET_KEY must start with sk_test_ or sk_live_" });
      }
      if (c.CLERK_PUBLISHABLE_KEY && !c.CLERK_PUBLISHABLE_KEY.startsWith("pk_")) {
        ctx.addIssue({ code: "custom", path: ["CLERK_PUBLISHABLE_KEY"], message: "CLERK_PUBLISHABLE_KEY must start with pk_test_ or pk_live_" });
      }
      // Never fall back to the AWS default credential chain (~/.aws): it can silently act on a real account.
      if (c.STORAGE_DRIVER !== "fs" && (!c.S3_ENDPOINT || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
        ctx.addIssue({ code: "custom", path: ["S3_ENDPOINT"], message: `STORAGE_DRIVER=${c.STORAGE_DRIVER} needs S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY` });
      }
    })
    .safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (Object.keys(overrides).length === 0) cached = parsed.data;
  return parsed.data;
}

/** Test hook: forget the cached config so the next getEnv() re-reads process.env. */
export function resetEnv() {
  cached = null;
}
