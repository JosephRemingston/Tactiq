# Tactiq backend

The API behind the Tactiq Android app: football discovery, match centre, fan-readable tactical analysis, the Free/Pro paywall, Google Play subscriptions and ad configuration.

It is a plain Express app (JavaScript, ES modules). The API runs on Netlify Functions at `https://tactiq.josephremingston.dev`. Background work runs as `node worker.js` on a GitHub Actions schedule.

## How it fits together

```
Android app ──> tactiq.josephremingston.dev  (Netlify Function: Express app)
                  ├─ Neon Postgres         all data, including the job list (ingestion_jobs)
                  ├─ Upstash Redis         cache and rate limits (over HTTPS; optional)
                  ├─ Clerk                 sign-in; tokens verified locally with CLERK_JWT_KEY
                  └─ Google Play API       purchase verification

GitHub Actions (hourly + daily) ──> node worker.js
                  ├─ StatsBomb open data ─> Neon Object Storage (raw files) ─> normalized rows in Postgres
                  └─ analytics ─> insights and match stories ─> team styles; billing reconciliation
```

No user request waits for a background job. Match analysis is computed once per match and stored, so every endpoint is a database read or a small write. The API and the worker share only the database. The API inserts job rows and the worker claims them with `FOR UPDATE SKIP LOCKED`. There is no queue service.

## Folder layout

| Folder | Holds |
|---|---|
| `index.js` | Local server (`app.listen`) |
| `app.js` | Builds the Express app: security middleware, routes, 404, error envelope |
| `worker.js` | Drains the job queue once and exits (GitHub Actions or by hand) |
| `cli.js` | Admin commands: migrations, seed, sync, replay, grant plans |
| `netlify/functions/api.js` | The Netlify Function wrapping `app.js` |
| `configs/` | Env, Postgres, Redis, storage, Clerk, Google Play |
| `routes/` | One `<domain>.routes.js` per area; validation and auth middleware are attached here |
| `controllers/` | Request handlers: read `req.valid`, call a service, answer with `ApiResponse` |
| `services/` | Business logic, no `req`/`res`. `services/index.js` builds them all once |
| `services/analytics`, `services/insights`, `services/providers` | Metric calculators, insight engine, StatsBomb adapter and normalizer |
| `middlewares/` | Auth, validation, rate limits, entitlements (paywall) |
| `models/` | Drizzle table definitions (`<domain>.models.js`) |
| `queues/` | Enqueue helpers and deterministic job ids |
| `workers/` | Job handlers and the runner |
| `utils/` | `ApiError`, `ApiResponse`, `asyncHandler`, ids, pagination, pitch geometry, logger |
| `data/` | Plans, ad placements, metric definitions, glossary, xT grid, role archetypes |
| `migrations/` | SQL migrations (drizzle-kit) |
| `tests/` | `node:test` suites and StatsBomb fixtures |

Every response uses one envelope:

```json
{ "statusCode": 200, "message": "Matches retrieved successfully", "data": { "matches": [], "page": { "nextCursor": null, "limit": 25 } } }
```

Errors use the same shape. `data.code` holds `VALIDATION_FAILED`, `UNAUTHENTICATED`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `ENTITLEMENT_REQUIRED`, `ENTITLEMENT_EXCEEDED`, `BILLING_NOT_CONFIGURED` or `INTERNAL`. `data.requestId` is the same value as the `x-request-id` response header. Stack traces are never sent.

## Running locally

```sh
npm install
node cli.js db:migrate      # apply migrations to DATABASE_URL
node cli.js db:seed         # licences, metric definitions, glossary, plans
npm run dev                 # http://localhost:3000
```

Configuration comes from `.env` (or `.env.local`). See `.env.example` for every variable.

Load football data, then process it:

```sh
node cli.js sync:statsbomb --competition 43 --season 106 --inline   # sync, ingest and analyse in this process
node worker.js                                                       # or: drain whatever is queued
```

### Tests

```sh
npm test                                                                                  # unit tests only
TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_test npm test    # plus integration and security tests
TEST_DATABASE_URL=postgres://touchline:touchline@localhost:5432/touchline_test npm run test:coverage
```

The database tests migrate the given database, ingest the two fixture matches through the real job chain, and run the real app with test-signed Clerk tokens and the fake purchase verifier. They refuse to run against any host other than `localhost`, `127.0.0.1` or the CI service `postgres`, and test processes never read `.env` files. Point `TEST_DATABASE_URL` only at a disposable database.

Test files: `tests/security.*.test.js` cover authentication, authorization (IDOR/BOLA/BFLA), input validation and fuzzing, billing, entitlements, webhooks, HTTP headers/CORS/rate limits, jobs, failure injection and the API contract. Fuzz inputs are seeded (`FUZZ_SEED`) so failures reproduce.

### Security checks

```sh
npm run security:audit     # production dependencies: no high/critical advisories
npm run security:secrets   # Gitleaks over the full git history (Docker)
npm run security:sast      # Semgrep: JS, Node, Express, OWASP Top 10, JWT and secrets rules (Docker)
```

The same checks run in `.github/workflows/security.yml`. The audit report is in `SECURITY_AUDIT/`.

## API

All routes are under `/v1`, except `/healthz`, `/readyz` and the webhooks.

| Area | Routes | Access |
|---|---|---|
| Health | `GET /healthz`, `GET /readyz` | public |
| Football | `GET /competitions[/:id[/seasons]]`, `/teams[/:id[/players\|/coverage]]`, `/players/:id[/matches]`, `/search`, `/matches`, `/matches/:id`, `/matches/:id/lineups`, `/matches/:id/events`, `/concepts[/:key]`, `/metric-definitions[/:key]` | public |
| Explanations | `GET /matches/:id/insights`, `/matches/:id/story`, `/teams/:id/style` | public |
| Analysis | `GET /matches/compare`, `/matches/:id/metrics`, `/tactical-shape`, `/pressing`, `/transitions`, `/possessions`, `/players/:playerId` | signed in, metered |
| Jobs | `POST /matches/:id/analysis-jobs`, `GET /jobs/:jobId` | signed in / public |
| Profile | `GET\|PATCH\|DELETE /me`, `GET /me/sessions`, `DELETE /me/sessions/:id` | signed in |
| Personal | `/me/feed`, `/me/following[/:kind/:id]`, `/me/saved-matches[/:id]`, `/me/saved-insights[/:id]`, `/me/notes[/:id]`, `/me/collections[/:id[/items]]`, `/me/learning[/:key]` | signed in, owner only |
| Paywall | `GET /entitlements`, `GET /billing/products` | signed in / public |
| Billing | `GET /billing/subscription`, `POST /billing/google-play/verify`, `POST /billing/restore` | signed in |
| Ads | `GET /ads/config` | public (per user when signed in) |
| Webhooks | `POST /v1/webhooks/clerk` (Svix signature), `POST /v1/webhooks/google-play-rtdn?token=…` | signed |

Private resources belonging to someone else answer 404, never 403.

## Free vs Pro

Routes never check plan names. They check a feature key, and `data/plans.json` decides what each plan gets.

| Feature key | Free | Pro | Where it is enforced |
|---|---|---|---|
| `analysis.matches_per_month` | 20 | unlimited | every per-match analysis route (one unit per match per month) |
| `comparisons.per_month` | 5 | unlimited | `/matches/compare` |
| `analysis.rerun_per_month` | 3 | 30 | `POST /matches/:id/analysis-jobs` |
| `analysis.advanced_filters` | no | yes | filtered `/matches/:id/events` and `/possessions` |
| `history.seasons_back` | latest 2 seasons | all | per-match analysis routes |
| `following.max_saved_items` | 100 | unlimited | saving matches and insights |
| `ads.enabled` | yes | no | `/ads/config`, ad slots in lists |

To move a feature between plans, edit `data/plans.json` and run `node cli.js db:seed`. The `catalogue` section of the same file is the comparison shown on the paywall screen.

Gated responses are 403 with `data.details.paywall: true`, the `featureKey`, and `unlockedBy` (the plans that include it). Metered responses carry `x-entitlement-remaining`. A charge is refunded if the request then fails on the server. Viewing the same match again in the same month is never charged twice.

To grant Pro by hand (support, testing), run:

```sh
node cli.js entitlements:grant --user <email|clerkId|uuid> --plan pro_monthly [--until 2027-01-01]
```

## Google Play subscriptions

1. The app calls `GET /v1/billing/subscription` and passes `obfuscatedAccountId` to `BillingFlowParams.setObfuscatedAccountId`.
2. After the purchase flow, the app sends `{ productId, purchaseToken }` to `POST /v1/billing/google-play/verify`.
3. The backend reads the subscription from the Google Play Developer API and stores it in `purchases`. It grants or updates the plan and acknowledges the purchase.
4. Google sends every later change (renewal, grace period, hold, pause, cancel, refund, expiry) as a Pub/Sub push to `/v1/webhooks/google-play-rtdn?token=<GOOGLE_PLAY_RTDN_TOKEN>`. The backend re-reads the full state from Google for each one.
5. A daily `billing_reconcile` job re-checks purchases in case a notification was missed.

Active, grace-period and cancelled subscriptions keep Pro until the paid-through date. On hold, paused, expired and revoked subscriptions fall back to Free, and user data is kept.

Until `GOOGLE_PLAY_PACKAGE_NAME` and `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` are set, the billing endpoints answer 503 `BILLING_NOT_CONFIGURED`.

## Ads

AdMob runs in the app. `GET /v1/ads/config` tells it whether ads may show for this user and where. It returns the placements, the AdMob unit ids, frequency caps and the screens that must stay ad-free. Pro users get `enabled: false`. The feed, search and match-list responses include `adSlots` markers only when ads are on.

Placements are defined in `data/ad_placements.json`. Outside production, Google's public test units are used until `ADMOB_*` is set. The ad payload never contains user data.

## Background jobs

`worker.js` runs these job types: `sync_competitions → sync_matches → ingest_match → normalize_match → analyse_match → generate_insights → team_season_style`, plus the daily `billing_reconcile` and `entitlements_expire`.

- Job ids are deterministic, so enqueueing the same work twice is a no-op.
- A failed job is retried with exponential backoff, then marked `dead`. Replay it with `node cli.js jobs:replay --job-id <id>`, or every recent dead job with `--dead-since 24`.
- `.github/workflows/jobs.yml` drains the queue every hour and also syncs the provider once a day. Run it by hand from the Actions tab, with "sync" ticked to sync first.
- A user's re-analysis request waits until the next run, so up to an hour.

## Deployment

### API on Netlify

`netlify.toml` sends every path to the function; there is no build step.

1. Create or reuse the Netlify site linked to this repo.
2. Set the environment variables from `.env.example` in the site settings. Use `netlify env:import` with a filled-in file, never a committed one.
3. Add the custom domain `tactiq.josephremingston.dev` to the site. The domain's DNS is already on Netlify, so no extra record is needed.

### Database changes

Migrations run from a laptop or CI, never at request time:

```sh
node cli.js db:migrate && node cli.js db:seed
```

### Jobs on GitHub Actions

Add these repository **secrets**:

- `DATABASE_URL`
- `REDIS_URL`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, once billing is set up

Add these repository **variables**:

- `STORAGE_DRIVER=neon`
- `S3_BUCKET_RAW`
- `S3_REGION_OVERRIDE`
- `STATSBOMB_COMPETITION_ALLOWLIST`
- `GOOGLE_PLAY_PACKAGE_NAME`

### Putting Cloudflare in front (optional, later)

1. Move the `josephremingston.dev` nameservers to Cloudflare and proxy `tactiq`.
2. Add a Transform Rule that sets the `x-edge-secret` header.
3. Set `EDGE_SHARED_SECRET` to the same value on Netlify.

The API then rejects requests that did not come through Cloudflare, and rate limits use `CF-Connecting-IP`.

## Security notes

- The user id always comes from the verified Clerk token, never from the request.
- Requests are rate limited per IP (anonymous) and per user (signed in) in Upstash, with an in-memory fallback so limits never switch off when Redis is unavailable. Job creation, purchase verification, webhooks and readiness checks have their own tighter limits, and a per-IP backstop covers every request.
- Authenticated responses are sent with `Cache-Control: private, no-store`; error logs record error codes and routes, never request data.
- Requests are validated with strict zod schemas: unknown fields are rejected and the body limit is 256 KB.
- Both webhooks are signed and protected against replay.
- `security_events` records sign-ups, account deletion, session revocation, purchase verification and rejected webhooks.
- Football data from StatsBomb Open Data is for development. Check its licence (`data/data_licences.json`) before shipping it to customers.
