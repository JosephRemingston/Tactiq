# Test coverage

## Numbers

| | Before the audit | After |
|---|---|---|
| Test files | 4 | 16 |
| Tests | 65 (43 unit + 22 end-to-end) | **229** |
| Added | — | 164 |
| Passing | 65 | 229 |
| Failing | 0 | 0 |
| Skipped | 0 | 0 with `TEST_DATABASE_URL` set. Without it, the 10 database suites skip with a stated reason and the 86 unit tests still run |
| Line coverage (all loaded files) | not measured | **96.5%** |
| Branch coverage | not measured | **85.5%** |
| Function coverage | not measured | 90.5% |
| Registered routes exercised | 22 of 63 old routes (end-to-end) | **70 of 70** |

Coverage comes from `npm run test:coverage` (the Node test runner with `--experimental-test-coverage`). Coverage counts only files loaded by tests. Four entry points are thin wrappers and are not loaded: `index.js` (app.listen), `worker.js` (calls the tested runner), `cli.js` (admin commands) and `netlify/functions/api.js` (`serverless-http` wrapper). The function wrapper was verified by bundling it with esbuild and invoking it with Lambda-style events, but that check is not automated.

## Security-critical modules

| Module | Lines | Branches | Note |
|---|---|---|---|
| `middlewares/validate.middleware.js` | 100 | 100 | |
| `middlewares/auth.middleware.js` | 95.8 | 96.2 | |
| `app.js` | 100 | 95.0 | |
| `controllers/webhook.controller.js` | 100 | 93.1 | |
| `middlewares/entitlement.middleware.js` | 100 | 92.9 | |
| `middlewares/rateLimit.middleware.js` | 95.7 | 90.0 | The Netlify and Cloudflare client-IP branches only run in those environments |
| `services/users.service.js` | 93.9 | 89.5 | The Clerk profile-fetch timeout path is not covered |
| `configs/googlePlay.js` | 96.4 | 89.2 | The real verifier's selection from environment variables is not covered |
| `services/billing.service.js` | 100 | 87.9 | |
| `services/entitlements.service.js` | 94.8 | 87.7 | The admin CLI `expireDue` audit loop is not covered |
| `services/personal.service.js` | 97.7 | 84.6 | Some feed branches (upcoming matches) are not covered |
| `services/jobs.service.js` | 97.1 | 83.8 | The enqueue-throws refund path is not covered |
| `queues/queue.js` | 100 | 81.3 | |
| `utils/asyncHandler.js` | 100 | 80.6 | Several `describeForLog` shape branches are not covered |
| `workers/runner.js` | 100 | 80.4 | |
| `configs/clerk.js` | 100 | 77.0 | SDK response-shape fallbacks are not covered |
| `utils/pagination.js`, `utils/ApiError.js` | 100 | 100 | |

**Target:** 90% statement **and** branch coverage on security-critical modules.

- **Statements:** met everywhere. The lowest figure is 93.9%.
- **Branches:** met for the request pipeline (validation, auth, webhooks, paywall gate, app), but **not met** for:
  - `billing.service.js` (87.9%)
  - `entitlements.service.js` (87.7%)
  - `personal.service.js` (84.6%)
  - `jobs.service.js` (83.8%)
  - `asyncHandler.js` (80.6%)
  - `runner.js` (80.4%)
  - `clerk.js` (77.0%)

The uncovered branches are mostly defensive fallbacks such as `??` defaults and alternative SDK response shapes, not untested decisions. Each one listed above is noted in the table.

**Overall backend statement target (85%):** met at 96.5%.

## What each suite covers

| File | Tests | Covers |
|---|---|---|
| `security.units.test.js` | 37 | Error envelope and log redaction (property test); typed cursors (2,000-case property test); LIKE escaping; ids; config validation and `.env` isolation; Upstash URL parsing; failing-Redis cache and locks; Clerk JWT: valid, expired, not yet valid, wrong party, pending, tampered payload or header, alg none, HS256 confusion, foreign key, garbage, unconfigured; Clerk profile mapping; Google state mapping and access (1,000-case property test); the real Google verifier against mocked HTTP (assertion signature, token cache, path encoding, 404/410/5xx); in-memory limiter (property test); validation middleware (NUL, depth, unknown fields, 2,000 random inputs); UTC period boundaries and leap days; ads |
| `security.clerk.test.js` | 5 | Real Clerk SDK against a mocked Clerk API: listing sessions, revoking your own, refusing someone else's (the revoke endpoint is never called), deletion idempotence, profile mapping |
| `security.auth.test.js` | 7 | Every private route without a token gives 401; every public and private route rejects 13 kinds of forged credential; identity ignores ids in query, headers or body; a deleted account's token is refused everywhere; concurrent first sign-in creates one account; no enumeration difference |
| `security.authorization.test.js` | 12 | Two users. BOLA/IDOR on notes, collections, items, saved matches and insights, learning, follows, jobs, entitlements and subscription; nested-id smuggling; mass assignment; BFLA (10 admin-like paths); deletion removes only the right data |
| `security.validation.test.js` | 14 | SQL injection in every text parameter (with a timing check against `pg_sleep`); injection through ids and enums; literal LIKE; XSS payloads stored verbatim as JSON; NUL bytes; impossible dates; tampered cursors on all 8 paginated routes; numeric edge values; malformed ids on every id route; body types, nulls, sizes, malformed JSON and form encoding; prototype pollution; 50,000-deep JSON; CRLF; seeded fuzzing; no unhandled errors or leaked request data in logs |
| `security.billing.test.js` | 25 | Forged tokens; product manipulation; client-supplied state ignored; account-bound purchases; token reuse; **F-01 race (5×4 concurrent)**; same-user concurrency; acknowledgement; all 10 state transitions; expiry; monthly→annual and linked tokens across users; store outage on verify and restore; vanished token; acknowledgement failure and reconciliation retry; notifications: auth, wrong app, no package, malformed, replay, concurrent duplicates, reordering, revoke, **F-02 refunds**, unknown token, outage and Pub/Sub retry, test notification; reconciliation |
| `security.entitlements.test.js` | 17 | Per-match charging; limit with paywall details; **F-04 refunds**; concurrency at the limit (5 rounds) and on the same match; comparisons by pair and team; advanced filters on 7 filtered forms × Free, Pro and anonymous; upgrade and downgrade; history seasons; **F-12 plan edits**; **F-09 save race**; re-analysis charging, replay and limit; UTC month, year and leap boundaries; cache invalidation on grant and revoke |
| `security.webhooks.test.js` | 9 | Valid creation; 9 kinds of forged or tampered delivery (no headers, bad signature, other secret, missing or mismatched id, stale or future timestamp, swapped body); replay; concurrent duplicates; **F-03 resurrection**; deletion idempotence; unknown events; malformed and oversized bodies (**F-11**); flood cap (**F-08**) |
| `security.http.test.js` | 14 | Security headers on success and error responses; `no-store` when authenticated; error bodies contain only the envelope; unsupported methods; CORS (no origins, allowlist exactness, preflight, never credentials, not a substitute for auth); edge gate; rate limits (**F-07**): per-IP, spoofed forwarding headers, other routes and methods, per user across sessions, forged auth headers and the backstop, strict route limits without Redis, failing Redis falls back |
| `security.jobs.test.js` | 9 | 6 concurrent runners claim 40 jobs exactly once; backoff, retries and dead; permanent errors; unregistered types; concurrent enqueue and replay; **F-10 stale locks**; a **real SIGKILLed worker process** whose job is recovered; malformed payloads to real handlers (no partial writes); re-analysis replaces results |
| `security.failures.test.js` | 11 | Postgres down (no details leaked, then recovery); a 2-connection pool under 40 parallel requests; Redis failing; storage down; provider down (fails fast); webhook secret missing; billing transaction rolled back halfway (atomicity); malformed store response; hostile provider data (schema drift, path traversal, injection strings); corrupt stored payload |
| `security.contract.test.js` | 4 | Registered routes = catalogue = 70; every route answers a valid request with its documented status and the envelope; pagination walks without gaps; deletion is final |
| `api.test.js` (existing) | 23 | End-to-end product behaviour |
| `analytics.test.js`, `insights.test.js`, `providers.test.js` (existing) | 41 | Analytics engine (hand-checked values), insights, providers |

## How the suite meets the quality requirements

- **Real systems:**
  - Real Express app, routes and middleware.
  - Real Postgres with real transactions.
  - Real Clerk JWT verification and Svix signatures.
  - Real concurrency, using `Promise.all` over HTTP and over pooled database connections, and a real killed process.
- **Fakes:** only Google Play (fake verifier; the real verifier is tested separately against mocked HTTP), the Clerk admin API (mocked HTTP) and failing-Redis clients.
- **Isolation:**
  - Every test creates its own users and tokens and uses unique ids.
  - Shared rows that a test changes (plan definitions, seasons, match status) are restored in `finally`.
  - Database test files run one at a time (`--test-concurrency=1`).
  - The whole suite was run repeatedly with the same result, including after re-ingestion.
- **Determinism:** fuzz and property tests use a seeded generator (`FUZZ_SEED`, default 20261112). Month-boundary tests pass explicit dates.
- **Safety:** the database harness refuses any non-local host, and test processes never read `.env` files.
- **Regression proof:** for F-01, F-02, F-04, F-09 and F-12, the fix was temporarily removed and the named regression tests failed; with the fix restored they passed.

## Gaps

| Gap | Why | What would close it |
|---|---|---|
| The Netlify runtime (`x-nf-client-connection-ip` trust, function limits) | Only reproducible on Netlify | A staging deploy, then sending spoofed `x-nf-client-connection-ip` and checking the rate-limit key |
| Real Upstash behaviour under load | Tests use no Redis or a failing fake, to stay deterministic and free | An optional test against a dedicated Upstash database |
| Real Google Play API | No Play Console listing yet | Play Console test purchases after the app ships |
| DAST (OWASP ZAP baseline) | Not run (see REMAINING_RISKS R-11) | `zap-baseline.py` against a staging URL |
| `cli.js`, `worker.js`, `index.js` entry points | Thin wrappers around tested modules | Smoke tests in CI if they grow |

## Update (12 November 2026, after the payment audit and the gap work)

The suite now has **287 tests: 287 pass, 0 fail, 0 skipped**. Line coverage is 96.8% and branch coverage 87.6% across all files.

Every security-critical module now meets the 90% branch target:

| Module | Branches |
|---|---|
| `clerk.js` | 91.9% |
| `googlePlay.js` | 97.6% |
| `billing.service.js` | 91.6% |
| `entitlements.service.js` | 93.0% |
| `jobs.service.js` | 92.5% |
| `personal.service.js` | 95.2% |
| `asyncHandler.js` | 97.7% |
| `runner.js` | 91.7% |

What was added:
- **`tests/edges.test.js`:** a refund when queueing a paid re-analysis fails, which fails if the refund is removed; the Pro plan switching ads off; unknown features denied; idempotent saves; cursor pagination of private lists; feeds built from each kind of follow.
- **Unit tests:** verifier selection, where production never gets the fake; OAuth failure; log scrubbing; job registry; Clerk shape fallbacks.
- **A Clerk session test** for missing fields.
- **A real SIGKILL** in the middle of a purchase transaction.
