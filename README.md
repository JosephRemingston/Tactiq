# Touchline backend

Fan-first football tactical intelligence API (NestJS) plus BullMQ workers. It ingests StatsBomb Open Data,
normalises events onto one canonical pitch, computes deterministic tactical metrics, and turns them into
evidence-linked insight cards and match stories at three depths (Quick / Explore / Advanced).

| Piece | Choice |
|---|---|
| API + workers | NestJS 12 (TypeScript 6), one image, `dist/main.js` and `dist/worker.js` |
| Database | PostgreSQL (Neon in the cloud, Docker locally) via Drizzle |
| Object storage | Neon Object Storage (`STORAGE_DRIVER=neon`), local disk for development and tests |
| Queues / cache | Redis + BullMQ (Upstash in the cloud, Docker locally) |
| Auth | Clerk session JWTs (Google sign-in), Clerk webhooks for user sync |
| Data | StatsBomb Open Data (non-commercial, attribution required); Sportmonks adapter stubbed |

## Run locally (Docker services)

```bash
cd backend
pnpm install
docker compose up -d                 # postgres:17 on 5432, redis:8 on 6380
set -a; source .env.docker; set +a   # local URLs, overriding .env without editing it
pnpm db:migrate && pnpm db:seed
pnpm cli sync:statsbomb --competition 43 --season 106 --matches 3869685 --local test/fixtures/statsbomb --inline
pnpm dev:api                         # http://localhost:3000/docs
pnpm dev:worker                      # in another shell, for jobs triggered through the API
```

`--inline` runs the workers inside the CLI and waits for the whole chain:
`sync_competitions -> sync_matches -> ingest_match -> normalize_match -> analyse_match -> generate_insights -> team_season_style`.
Drop `--local` to read from GitHub (rate limited to 2 requests/second).

## Run against Neon + Upstash + Clerk

1. **Postgres**: put the Neon connection string in `DATABASE_URL`, then `pnpm db:migrate && pnpm db:seed`.
2. **Object storage**: `neon buckets create touchline-raw`, then `neon env pull`. It writes `AWS_ENDPOINT_URL_S3`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` (to `.env` or `.env.local`; both are read).
   Check with `pnpm cli storage:check`.
3. **Redis**: use the `rediss://` (TLS) URL from Upstash. BullMQ polls Redis; on per-command plans raise
   `WORKER_DRAIN_DELAY_SECONDS` (e.g. 30) and `WORKER_STALLED_INTERVAL_MS` (e.g. 120000).
4. **Clerk**: `CLERK_SECRET_KEY` (profile sync, sessions, account deletion), `CLERK_JWT_KEY` (networkless token
   verification), `CLERK_AUTHORIZED_PARTIES` (your app origins), `CLERK_WEBHOOK_SIGNING_SECRET` (webhook endpoint
   `POST /v1/webhooks/clerk`, events `user.created`, `user.updated`, `user.deleted`).
   Production instances use `sk_live_`/`pk_live_` keys plus their own JWT key and webhook secret. Sign-up with a
   verification code needs no backend change: Clerk only issues a session after the code is confirmed. The backend
   also rejects sessions with unfinished tasks (`sts: pending`) and stores a user's email only once it is verified.

Every variable is validated at startup by `src/config/env.ts`; a missing or inconsistent setting stops the process
with a message naming it. Object storage never falls back to `~/.aws` credentials.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | Unit + end-to-end tests (Testcontainers starts Postgres and Redis) |
| `pnpm typecheck` / `pnpm build` | TypeScript check / production build into `dist/` |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed` | Drizzle migration generation, apply, reference data |
| `pnpm cli sync:statsbomb ...` | Ingest competitions, matches and events (see `pnpm cli help`) |
| `pnpm cli jobs:status --trace <id>` / `jobs:replay --job-id <id>` | Inspect or replay jobs |
| `pnpm cli entitlements:grant --user <email> --plan pro_monthly` | Grant Pro (no billing yet) |
| `pnpm cli storage:check` | Write and read a test object in the configured storage |
| `pnpm openapi:export` | Write `openapi.json` (used to generate the Android client) |
| `pnpm fixtures:download` | Refresh the StatsBomb test fixtures |

## Layout

```
src/
  main.ts worker.ts cli.ts        entrypoints
  config/env.ts                    every environment variable, validated
  db/schema/*.ts migrations/ seed/ Drizzle schema, SQL migrations, reference-data seeding
  infra/                           database, redis (cache, locks), storage drivers, queue + worker runner
  lib/providers/                   provider adapter contract, StatsBomb adapter + normalizer, Sportmonks stub
  lib/analytics/                   MatchContext, calculators, insight engine, team style (pure TypeScript)
  modules/                         Nest modules: auth, users, football, ingestion, analytics, insights,
                                   personal (following, saved, notes, collections, feed), entitlements, jobs
data/                              metric definitions, glossary, plans, xT grid, role archetypes + reference stats
test/                              unit, e2e, StatsBomb fixtures
```

More detail: [data model](../docs/data-model.md), [metrics and insights](../docs/metrics.md),
[operations runbook](../docs/runbook.md), [metric hand-checks](../docs/metric-hand-checks.md).

Data attribution: StatsBomb Open Data (Hudl StatsBomb). Its licence does not allow commercial redistribution;
production needs a licensed feed (see `data/data_licences.json`).
