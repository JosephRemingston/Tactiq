# Architecture inventory

This inventory covers the Tactiq backend as it is implemented in this repository on 12 November 2026, after the remediation described in `REMEDIATION_LOG.md`. It was built by reading every source file, tracing each route through its middleware into services and SQL, and confirming behaviour against a running instance on a local database.

## 1. What actually runs

| Component | Implemented? | Where | Notes |
|---|---|---|---|
| Express API | Yes | `app.js`, `routes/`, `controllers/` | Express 5, ESM JavaScript |
| Netlify Function wrapper | Yes | `netlify/functions/api.js`, `netlify.toml` | `serverless-http`; every path is rewritten to the function |
| Local server | Yes | `index.js` | `app.listen` for development |
| Background worker | Yes | `worker.js`, `workers/` | Run by `.github/workflows/jobs.yml` (hourly + daily) |
| Admin CLI | Yes | `cli.js` | Needs database credentials; no HTTP exposure |
| Neon Postgres | Yes | `configs/database.js` | `pg` Pool + Drizzle, pooled URL |
| Neon Object Storage | Yes | `configs/s3.js` | `aws4fetch`, path-style, explicit credentials |
| Upstash Redis | Yes, optional | `configs/redis.js` | REST client; cache, rate limits, one lock |
| Clerk | Yes | `configs/clerk.js`, `middlewares/auth.middleware.js` | Networkless JWT verification; Svix webhooks |
| Google Play Billing | Yes, not yet configured | `configs/googlePlay.js`, `services/billing.service.js` | Real verifier needs credentials; fake verifier for tests |
| AdMob configuration | Yes | `services/ads.service.js`, `data/ad_placements.json` | Server-side placement config only |
| StatsBomb provider | Yes | `services/providers/statsbomb/` | HTTP (GitHub raw) or local directory |
| Sportmonks provider | Stub only | `services/providers/sportmonks/adapter.js` | Always throws "not configured" |
| Android app | Not present | — | No client code in this repository |
| ClickHouse, video, reports, AI | Not implemented | — | Out of scope (later milestones) |

## 2. Global middleware chain (every request, in order)

1. Request id (`x-request-id`), `Vary: Authorization`, and `Cache-Control: private, no-store` when an `Authorization` header is present (`app.js`)
2. `helmet` (CSP `default-src 'none'; frame-ancestors 'none'`, HSTS, nosniff, frame options, referrer policy)
3. `cors` (no origins unless `CORS_ORIGINS` is set; never credentials)
4. Edge gate (`EDGE_SHARED_SECRET`, optional; exempts `/healthz`)
5. `ipBackstop`: per-IP limit for every request, in memory (`THROTTLE_IP_BACKSTOP_PER_MIN`, default 1200/min)
6. `/readyz` only: `strictLimit("readyz", 30)`
7. Health routes
8. Webhook routes only: `strictLimit("webhook", 300)` then raw body parser (1 MB)
9. `express.json({ limit: "256kb" })`
10. `ipRateLimit`: anonymous requests limited per IP (`THROTTLE_IP_PER_MIN`, default 120/min)
11. Routers; then 404 handler; then the error handler (`sendError`)

The user and IP limits use Upstash when it is reachable and fall back to in-memory counters otherwise. The backstop is always in memory.

## 3. Endpoints

Legend:
- **Auth:** `opt` = `optionalAuth`, where an invalid token is a 401 and no token is anonymous; `req` = `authenticate`; `sig` = signature or shared token.
- **Validation:** zod schemas run through `validate()`. All of them also reject NUL bytes and nesting deeper than 32 levels.
- **Rate:** `anon` = IP limit when there is no token; `user` = per-user limit applied after authentication; `strict:N` = a route-specific per-minute limit.

### Health and root

| Method | Path | Auth | Validation | Rate | Controller → service | Tables | Tests |
|---|---|---|---|---|---|---|---|
| GET | `/healthz` | none | none | backstop | health.health | — | contract, http |
| GET | `/readyz` | none | none | backstop + strict:30 | health.ready | `select 1`, Redis ping, storage HEAD | failures, contract |
| GET | `/` | none | none | backstop + anon | inline | — | contract |

### Shared football data (public)

All routes in this section use `opt` auth, `anon`/`user` rate limits and read-only queries, and are tested by the auth, validation and contract suites.

| Method | Path | Validation | Extra gates | Service | Tables read |
|---|---|---|---|---|---|
| GET | `/v1/competitions` | `q` ≤80 | — | football.listCompetitions | competitions, seasons |
| GET | `/v1/competitions/:id` | uuid | — | football.getCompetition | competitions, seasons, matches, match_coverage |
| GET | `/v1/competitions/:id/seasons` | uuid | — | football.getCompetition | same |
| GET | `/v1/teams` | page, uuid filters, `q` | — | football.listTeams | teams, matches |
| GET | `/v1/teams/:id` | uuid | — | football.getTeam | teams, matches, seasons, competitions |
| GET | `/v1/teams/:id/players` | uuid | — | football.teamPlayers | players, lineups, player_team_assignments |
| GET | `/v1/teams/:id/coverage` | uuid | — | football.teamCoverage | matches, match_coverage |
| GET | `/v1/teams/:teamId/style` | uuid | — | insights.getTeamStyle | team_season_styles |
| GET | `/v1/players/:id` | uuid | — | football.getPlayer | players, lineups, teams |
| GET | `/v1/players/:id/matches` | uuid, page | — | football.playerMatches | lineups, matches |
| GET | `/v1/search` | `q` 2–80, `types`, `limit` 1–25 | — | football.search | competitions, teams, players, tactical_concepts |
| GET | `/v1/matches` | page, filters, strict dates | — | football.listMatches | matches + joins |
| GET | `/v1/matches/:matchId` | uuid | — | football.getMatch (cached) | matches, match_participants, match_coverage, data_licences |
| GET | `/v1/matches/:matchId/lineups` | uuid | — | football.matchLineups | lineups, players |
| GET | `/v1/matches/:matchId/events` | uuid, page (≤500), filters | Pro if filtered (`analysis.advanced_filters`) | football.matchEvents | events, players |
| GET | `/v1/matches/:matchId/insights` | uuid, depth | — | insights.listInsights | insights |
| GET | `/v1/matches/:matchId/story` | uuid, depth | — | insights.getStory | match_stories, insights |
| GET | `/v1/concepts` | `category` | — | football.listConcepts | tactical_concepts |
| GET | `/v1/concepts/:key` | key regex | — | football.getConcept | tactical_concepts, metric_definitions |
| GET | `/v1/metric-definitions` | `family` | — | football.listMetricDefinitions | metric_definitions |
| GET | `/v1/metric-definitions/:key` | key regex, `version` | — | football.getMetricDefinition | metric_definitions |
| GET | `/v1/jobs/:jobId` | id regex | Visible to the requester, or anyone for public match-analysis jobs | jobs.get | ingestion_jobs |
| GET | `/v1/billing/products` | — | — | billing.products | plan_definitions |
| GET | `/v1/ads/config` | — | per-user plan when a token is sent | ads.getConfig | entitlements |

### Analysis views (signed in, metered)

Every route in this section has the chain `authenticate → historyGate → validate → metered("analysis.matches_per_month", match)`. The exception is `compare`: it skips `historyGate` and is metered by `comparisons.per_month` per pair and team. The charge is taken before the handler runs and refunded if the handler fails for any reason. The tests are in the entitlements, auth and contract suites.

| Method | Path | Service | Tables |
|---|---|---|---|
| GET | `/v1/matches/compare` | analytics.compare | matches, tactical_metrics, analysis_runs |
| GET | `/v1/matches/:matchId/metrics` | analytics.metrics | tactical_metrics, metric_definitions |
| GET | `/v1/matches/:matchId/tactical-shape` | analytics.tacticalShape | tactical_metrics |
| GET | `/v1/matches/:matchId/pressing` | analytics.pressing | tactical_metrics |
| GET | `/v1/matches/:matchId/transitions` | analytics.transitions | tactical_metrics |
| GET | `/v1/matches/:matchId/possessions` | analytics.possessions (filters are Pro) | match_possessions |
| GET | `/v1/matches/:matchId/players/:playerId` | analytics.player | lineups, tactical_metrics |
| POST | `/v1/matches/:matchId/analysis-jobs` | jobs.requestAnalysis (`strict:10`, charges `analysis.rerun_per_month` only when work is queued) | matches, match_coverage, ingestion_jobs, entitlement_usage* |

### Private user data (signed in, owner only)

The `/v1/me` router applies `authenticate` to every route. Each query filters by the authenticated user's id, so another user's resource is indistinguishable from a missing one (404). Tests are in the authorization, auth, validation and contract suites.

| Method | Path | Validation | Service | Tables (ownership column) |
|---|---|---|---|---|
| GET | `/v1/me` | — | users.getMe | users, followed_* |
| PATCH | `/v1/me` | strict body | users.updateMe | users |
| DELETE | `/v1/me` | — | users.deleteAccount + Clerk delete | all private tables; users is scrubbed |
| GET | `/v1/me/sessions` | — | Clerk sessions (needs secret key) | — |
| DELETE | `/v1/me/sessions/:sessionId` | ≤64 chars | Clerk revoke after an ownership check | security_events |
| GET | `/v1/me/feed` | — | personal.feed + ads.slotsFor | followed_*, matches, insights, learning_progress |
| GET | `/v1/me/following` | — | personal.following | followed_teams/competitions/players (user_id) |
| PUT/DELETE | `/v1/me/following/:kind/:id` | kind enum, uuid | personal.follow | same |
| GET | `/v1/me/saved-matches` | page | personal.savedMatches | saved_matches (user_id) |
| PUT/DELETE | `/v1/me/saved-matches/:matchId` | uuid | personal.saveMatch (advisory lock + limit) | saved_matches |
| GET | `/v1/me/saved-insights` | page | personal.savedInsights | saved_insights (owner_user_id) |
| PUT/DELETE | `/v1/me/saved-insights/:insightId` | uuid | personal.saveInsight (advisory lock + limit) | saved_insights |
| GET/POST | `/v1/me/notes` | page, filters / strict body | personal.listNotes / createNote | user_notes (owner_user_id) |
| GET/PATCH/DELETE | `/v1/me/notes/:id` | uuid, strict body | personal.ownedNote… | user_notes |
| GET/POST | `/v1/me/collections` | strict body | personal.listCollections / createCollection | user_collections (owner_user_id) |
| GET/PATCH/DELETE | `/v1/me/collections/:id` | uuid, strict body | personal.ownedCollection… | user_collections, user_collection_items |
| PUT | `/v1/me/collections/:id/items` | strict body | personal.addCollectionItem (a note must be the caller's own) | user_collection_items |
| DELETE | `/v1/me/collections/:id/items/:itemType/:itemId` | enum, uuid | personal.removeCollectionItem | user_collection_items |
| GET | `/v1/me/learning` | — | personal.learning | learning_progress (owner_user_id) |
| PUT | `/v1/me/learning/:conceptKey` | key regex, strict body | personal.setLearning | learning_progress |
| GET | `/v1/entitlements` | — | entitlements.currentPlan + resolveAll | entitlements, entitlement_usage, subscriptions |
| GET | `/v1/billing/subscription` | — | billing.subscription | purchases, subscriptions |
| POST | `/v1/billing/google-play/verify` | strict body, `strict:20` | billing.verifyPurchase | purchases, subscriptions, entitlements, entitlement_audit, security_events |
| POST | `/v1/billing/restore` | `strict:10` | billing.restore | same |

### Webhooks

| Method | Path | Auth | Rate | Body | Service | Tables |
|---|---|---|---|---|---|---|
| POST | `/v1/webhooks/clerk` (also `/webhooks/clerk`) | Svix signature (`CLERK_WEBHOOK_SIGNING_SECRET`), 5-minute timestamp tolerance | backstop + strict:300 | raw, 1 MB | users.upsert / deleteAccount | users, user_identities, security_events (replay ids) |
| POST | `/v1/webhooks/google-play-rtdn?token=…` | shared token (`GOOGLE_PLAY_RTDN_TOKEN`, constant-time comparison) and package name | backstop + strict:300 | raw, 1 MB | billing.handleRtdn → store re-read | billing_notifications, purchases, subscriptions, entitlements |

Total registered route patterns: 70. This count is enforced by `tests/security.contract.test.js`.

## 4. Privileged and administrative operations

| Operation | Entry point | Who can run it |
|---|---|---|
| Grant or revoke plans, expire grants | `node cli.js entitlements:*` | Anyone holding `DATABASE_URL` |
| Replay jobs, show job status | `node cli.js jobs:*` | Same |
| Sync, ingest, recompute styles | `node cli.js sync:statsbomb`, `analytics:styles`, `node worker.js` | Same, plus GitHub Actions |
| Migrate, seed | `node cli.js db:migrate`, `db:seed` | Same |
| Storage check | `node cli.js storage:check` | Holder of the storage credentials |

No administrative function is reachable over HTTP. `tests/security.authorization.test.js` probes the likely admin paths and expects 404 for each.

## 5. Background jobs

| Job type | Triggered by | Handler | Writes | Idempotency |
|---|---|---|---|---|
| sync_competitions | daily sync, CLI | ingestion.workers SyncCompetitionsHandler (Redis lock) | competitions, seasons, raw_payloads | deterministic id per day + scope |
| sync_matches | sync_competitions | SyncMatchesHandler | teams, matches, match_participants, match_coverage | per day + scope |
| ingest_match | sync_matches | IngestMatchHandler | object storage, raw_payloads | per provider version hash |
| normalize_match | ingest_match | NormalizeMatchHandler (single transaction) | players, lineups, events, event_freeze_frames, match_coverage | per raw SHA |
| analyse_match | normalize_match, user re-analysis | AnalyseMatchHandler (atomic commit) | analysis_runs, tactical_metrics, match_possessions | per input version |
| generate_insights | analyse_match | GenerateInsightsHandler | insights, match_stories | per run |
| team_season_style | analyse_match (one pending per team-season) | TeamSeasonStyleHandler | team_season_styles | per team-season |
| billing_reconcile | daily | BillingReconcileHandler | purchases, subscriptions, entitlements | per day |
| entitlements_expire | daily | EntitlementsExpireHandler | entitlements, entitlement_audit | per day |

Jobs are claimed with `FOR UPDATE SKIP LOCKED` (`workers/runner.js`). Failed jobs back off up to 30 minutes and die after `QUEUE_MAX_ATTEMPTS`. A stale lock older than 30 minutes is re-queued, or marked dead if that was the final attempt.

## 6. External integrations (outbound)

| Integration | Destination | Who controls the URL | Notes |
|---|---|---|---|
| StatsBomb | `STATSBOMB_OPEN_DATA_BASE_URL` (GitHub raw) | Environment only | Path segments come from integer provider ids (schema-validated) |
| Object storage | `S3_ENDPOINT` | Environment only | Keys are built from provider and kind plus integer ids, then path-encoded |
| Google OAuth and Android Publisher | Fixed Google hosts | Code | Purchase token and product id are path-encoded |
| Clerk | `api.clerk.com` via SDK | SDK | Sessions, user fetch and delete only |
| Upstash | Host taken from `REDIS_URL` (`*.upstash.io` only) | Environment only | — |

No user-controlled value is ever used as a host, scheme or port, so there is no server-side request forgery surface.

## 7. Database tables and ownership

There are 43 tables. The full column inventory is in `docs/Tactiq-Product-and-System-Guide.pdf`, section 4.

| Group | Tables | Ownership |
|---|---|---|
| Shared football | competitions, seasons, teams, players, player_team_assignments, matches, match_participants, match_coverage, lineups, events, event_freeze_frames, tactical_concepts, data_licences, provider_entity_maps, raw_payloads, provider_sync_state | None (global, read-only to users) |
| Shared analysis | metric_definitions, analysis_runs, tactical_metrics, match_possessions, insights, match_stories, team_season_styles | None |
| Private | users, user_identities, followed_teams, followed_competitions, followed_players, saved_matches, saved_insights, user_collections, user_collection_items, user_notes, learning_progress, security_events | `user_id` or `owner_user_id` (FK to users, cascade) |
| Billing and plans | plan_definitions, subscriptions, entitlements, entitlement_usage, entitlement_usage_events, entitlement_audit, purchases, billing_notifications | `user_id`, except plan_definitions and billing_notifications |
| Jobs | ingestion_jobs | `requested_by_user_id` (nullable, nulled on account deletion) |

## 8. Sensitive data and where it lives

| Data | Where | Protection |
|---|---|---|
| Email, name, avatar URL | users, user_identities, Clerk | Owner-only; scrubbed on deletion |
| Clerk user id | users | Never returned to other users |
| Private notes | user_notes | Owner-only; never logged (F-06) |
| IP address, user agent | security_events | Server-side only |
| Purchase tokens, order ids, raw Google responses | purchases, billing_notifications | Server-side only; never returned by the API |
| Usage history | entitlement_usage, entitlement_usage_events | Owner-only via `/v1/entitlements` |
| Session tokens | Never stored | Verified per request |
| Raw provider payloads | Object storage | Private bucket (policy not verifiable from code, see REMAINING_RISKS) |

## 9. Environment variables (names only)

**Runtime:** NODE_ENV, PORT, DATABASE_URL, DATABASE_POOL_MAX, REDIS_URL, STORAGE_DRIVER, STORAGE_FS_ROOT, S3_ENDPOINT, S3_REGION_OVERRIDE, S3_BUCKET_RAW, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, EVENTS_STORE_RAW, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY, CLERK_AUTHORIZED_PARTIES, CLERK_WEBHOOK_SIGNING_SECRET, STATSBOMB_SOURCE, STATSBOMB_OPEN_DATA_BASE_URL, STATSBOMB_OPEN_DATA_LOCAL_DIR, STATSBOMB_COMPETITION_ALLOWLIST, STATSBOMB_RATE_PER_SECOND, STATSBOMB_USER_AGENT, SPORTMONKS_API_TOKEN, TEAM_STYLE_DELAY_MS, QUEUE_MAX_ATTEMPTS, QUEUE_BACKOFF_BASE_MS, WORKER_BUDGET_MS, CORS_ORIGINS, THROTTLE_IP_PER_MIN, THROTTLE_USER_PER_MIN, THROTTLE_IP_BACKSTOP_PER_MIN, TRUST_PROXY, CACHE_TTL_MATCH_SECONDS, EDGE_SHARED_SECRET, GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_RTDN_TOKEN, BILLING_FAKE_VERIFIER, ADMOB_NATIVE_UNIT_ID, ADMOB_BANNER_UNIT_ID, LOG_LEVEL.

**Present in the local `.env` but unused by the code:** RUN_MIGRATIONS, VITE_CLERK_PUBLISHABLE_KEY, WORKER_TRIGGER_SECRET.

**Test-only:** TEST_DATABASE_URL, FUZZ_SEED.

## 10. Security controls

### In place, each verified by tests

- **Authentication:** Clerk JWT verified with a public key, an authorized-party check, rejection of pending sessions, and denial of deleted accounts.
- **Authorization:** every private query is scoped to the owner, with 404 for anyone else's resource. No HTTP admin surface exists.
- **Validation:**
  - Strict schemas that reject unknown fields.
  - Rejection of NUL bytes and of nesting deeper than 32 levels.
  - Strict integers and calendar-exact dates.
  - Typed cursors.
  - A 256 KB JSON limit and a 1 MB webhook limit.
- **Rate limiting:** per IP, per user, and per route, with an in-memory fallback and a per-IP backstop.
- **Paywall:**
  - Every limit is enforced on the server.
  - Usage counting is transactional, with `FOR UPDATE` on the usage row.
  - Charging is idempotent per subject, and a failed request is refunded.
- **Billing:**
  - Every purchase is verified with the store.
  - A token can belong to one account only, enforced race-free.
  - The obfuscated account id is checked when present.
  - Notifications require a shared token and the right package, are deduplicated, and always trigger a fresh read from the store.
- **Webhooks:** Svix signatures with a timestamp tolerance, replay protection, and a check of the event's shape.
- **HTTP:** strict CSP, HSTS, nosniff, frame denial, `no-store` on authenticated responses, a CORS allowlist without credentials, and the optional edge-secret gate.
- **Errors and logging:** clients receive one envelope with no internals. Logs record the error code and the route, never request data.
- **CI:** least-privilege workflow permissions, actions pinned by SHA, no shell interpolation, no install scripts. Dependency, secret and static-analysis gates run on every push.

### Missing or not verifiable from this repository

See `REMAINING_RISKS.md`. In short:
- the storage bucket's access policy
- Netlify's handling of client IP headers
- a data-retention schedule
- dynamic scanning (DAST) against a deployed instance
- Pub/Sub OIDC authentication for Google notifications
- production Clerk configuration
