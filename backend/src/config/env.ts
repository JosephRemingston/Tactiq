import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Optional string where an empty value (e.g. `AWS_REGION=` in .env) means "not set". */
const optStr = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Single source of truth for every environment variable the backend reads. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ENABLE_SWAGGER: bool.default(true),

  DATABASE_URL: z.string().min(1).default('postgres://touchline:touchline@localhost:5432/touchline'),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),
  REDIS_URL: z.string().min(1).default('redis://localhost:6380'),

  /**
   * neon = Neon Object Storage (S3-compatible, branches with the database; vars from `neon env pull`)
   * s3   = any S3-compatible bucket (AWS, R2, local SeaweedFS) via S3_* vars
   * fs   = local disk (tests, offline development)
   */
  STORAGE_DRIVER: z.enum(['neon', 's3', 'fs']).default('fs'),
  STORAGE_FS_ROOT: z.string().default('.data/storage'),
  S3_ENDPOINT: optStr(),
  S3_REGION: z.string().default('us-east-1'),
  S3_REGION_OVERRIDE: optStr(),
  S3_BUCKET_RAW: z.string().default('touchline-raw'),
  S3_ACCESS_KEY_ID: optStr(),
  S3_SECRET_ACCESS_KEY: optStr(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** Written by `neon env pull`; read only when STORAGE_DRIVER=neon. */
  AWS_ENDPOINT_URL_S3: optStr(),
  AWS_ACCESS_KEY_ID: optStr(),
  AWS_SECRET_ACCESS_KEY: optStr(),
  AWS_REGION: optStr(),
  /** Create the bucket on startup. Only honoured for custom endpoints (local SeaweedFS/MinIO) unless set explicitly. */
  S3_AUTO_CREATE_BUCKET: bool.optional(),
  /** Keep the full provider event JSON in Postgres too. Off by default: raw payloads already live in object storage. */
  EVENTS_STORE_RAW: bool.default(false),

  CLERK_SECRET_KEY: optStr(),
  CLERK_PUBLISHABLE_KEY: optStr(),
  /** PEM public key for networkless JWT verification (Clerk dashboard > API keys > JWT public key). */
  CLERK_JWT_KEY: optStr(),
  CLERK_AUTHORIZED_PARTIES: z.string().default(''),
  CLERK_WEBHOOK_SIGNING_SECRET: optStr(),

  STATSBOMB_SOURCE: z.enum(['github', 'local']).default('github'),
  STATSBOMB_OPEN_DATA_BASE_URL: z.string().default('https://raw.githubusercontent.com/statsbomb/open-data/master/data'),
  STATSBOMB_OPEN_DATA_LOCAL_DIR: optStr(),
  STATSBOMB_COMPETITION_ALLOWLIST: z.string().default('43:106,43:3'),
  STATSBOMB_RATE_PER_SECOND: z.coerce.number().positive().default(2),
  STATSBOMB_USER_AGENT: z.string().default('Touchline-dev/0.1'),
  SPORTMONKS_API_TOKEN: optStr(),

  WORKER_QUEUES: z.string().default('provider-sync,match-ingestion,normalization,tactical-analytics'),
  WORKER_CONCURRENCY_INGESTION: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY_ANALYTICS: z.coerce.number().int().positive().default(2),
  /** Team season style recompute is debounced: one job per team-season per window, delayed by this much. */
  TEAM_STYLE_DELAY_MS: z.coerce.number().int().nonnegative().default(300_000),
  /** Idle polling interval for BullMQ workers. Raise it on per-command-billed Redis (e.g. Upstash) to cut costs. */
  WORKER_DRAIN_DELAY_SECONDS: z.coerce.number().int().positive().default(5),
  WORKER_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Retry delay = min(base * 2^(attempt-1), 30 min) + jitter. */
  QUEUE_BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(60_000),

  /** Comma-separated browser origins allowed to call the API cross-origin (not needed when served same-origin). */
  CORS_ORIGINS: z.string().default(''),
  /**
   * Serverless hosting (Netlify): URL of the background worker function, woken after jobs are enqueued.
   * Defaults to <URL>/.netlify/functions/worker-background when running on Netlify.
   */
  WORKER_TRIGGER_URL: optStr(),
  /** Shared secret the worker trigger must present (x-worker-secret header). */
  WORKER_TRIGGER_SECRET: optStr(),
  /** Time budget for one serverless worker run (Netlify background functions stop at 15 minutes). */
  WORKER_DRAIN_BUDGET_MS: z.coerce.number().int().positive().default(13 * 60_000),
  THROTTLE_IP_PER_MIN: z.coerce.number().int().positive().default(120),
  THROTTLE_USER_PER_MIN: z.coerce.number().int().positive().default(600),
  CACHE_TTL_MATCH_SECONDS: z.coerce.number().int().positive().default(60),
});

export type AppConfig = z.infer<typeof envSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

let loaded = false;
/** Loads `.env` (if present) once, then validates process.env. Throws with a readable message on invalid config. */
export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  if (!loaded) {
    // Real environment variables win, then .env.local, then .env, then the repository-root .env.local
    // (where `neon env pull` writes when run at the project root).
    for (const file of envFiles()) process.loadEnvFile(file);
    loaded = true;
  }
  const parsed = envSchema.superRefine((c, ctx) => {
    // Swapped Clerk keys are an easy paste mistake, and a secret key must never reach a frontend build.
    if (c.CLERK_SECRET_KEY && !c.CLERK_SECRET_KEY.startsWith('sk_')) {
      ctx.addIssue({ code: 'custom', path: ['CLERK_SECRET_KEY'], message: 'CLERK_SECRET_KEY must start with sk_test_ or sk_live_ (is it swapped with the publishable key?)' });
    }
    if (c.CLERK_PUBLISHABLE_KEY && !c.CLERK_PUBLISHABLE_KEY.startsWith('pk_')) {
      ctx.addIssue({ code: 'custom', path: ['CLERK_PUBLISHABLE_KEY'], message: 'CLERK_PUBLISHABLE_KEY must start with pk_test_ or pk_live_ (is it swapped with the secret key?)' });
    }
    // Never fall back to the AWS default credential chain (~/.aws): it can silently act on a real account.
    if (c.STORAGE_DRIVER === 's3' && (!c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['S3_ACCESS_KEY_ID'], message: 'STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or STORAGE_DRIVER=fs for local development)' });
    }
    if (c.STORAGE_DRIVER === 'neon') {
      if (!(c.S3_ENDPOINT ?? c.AWS_ENDPOINT_URL_S3)) {
        ctx.addIssue({ code: 'custom', path: ['AWS_ENDPOINT_URL_S3'], message: 'STORAGE_DRIVER=neon needs the branch storage endpoint: run `neon env pull` (writes AWS_ENDPOINT_URL_S3) or set S3_ENDPOINT' });
      }
      const lambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME); // AWS_* keys belong to Lambda itself there
      if (!(c.S3_ACCESS_KEY_ID ?? (lambda ? undefined : c.AWS_ACCESS_KEY_ID)) || !(c.S3_SECRET_ACCESS_KEY ?? (lambda ? undefined : c.AWS_SECRET_ACCESS_KEY))) {
        ctx.addIssue({ code: 'custom', path: ['AWS_ACCESS_KEY_ID'], message: 'STORAGE_DRIVER=neon needs a Neon storage credential: run `neon env pull` (writes AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) or set S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY' });
      }
    }
  }).safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Env files in precedence order (earlier files win; real environment variables always win). */
export function envFiles(cwd = process.cwd()): string[] {
  const candidates = [resolve(cwd, '.env.local'), resolve(cwd, '.env'), resolve(cwd, '..', '.env.local')];
  return [...new Set(candidates)].filter((f) => existsSync(f));
}

/** DATABASE_URL from the environment or the env files, without validating the rest (migrations, seeding). */
export function databaseUrlFromEnv(): string {
  for (const file of envFiles()) process.loadEnvFile(file);
  return envSchema.shape.DATABASE_URL.parse(process.env.DATABASE_URL);
}
