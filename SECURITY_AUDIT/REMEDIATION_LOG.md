# Remediation log

These are all the code and configuration changes made during the audit. The API contract is unchanged except where noted: a few inputs that used to produce 500s now produce 400s, and failed requests are no longer charged.

## Application code

| File | Change | Why |
|---|---|---|
| `services/billing.service.js` | `PurchaseOwnershipError`: inside the purchase transaction, after the upsert has locked the row, refuse when the row belongs to another user; `verifyPurchase` maps it to 409 plus a `purchase_token_reuse` security event | F-01 race |
| `services/billing.service.js` | Voided-purchase notifications force revocation only when their `orderId` is the subscription's current order; anything else re-reads the store | F-02 |
| `services/billing.service.js` | Notifications must name the configured package (no longer skipped when absent) | F-14 |
| `services/billing.service.js` | `restore()` maps store errors to 503 | F-15 |
| `services/users.service.js` | The user upsert updates only active rows (`setWhere status = 'active'`); deleted rows are returned untouched with no identity re-linking | F-03 |
| `middlewares/entitlement.middleware.js` | `metered()` refunds the unit on any error after charging, not only on 5xx | F-04 |
| `services/jobs.service.js` | Re-analysis refunds when nothing new is queued (the job exists and is not failed or dead) or when the enqueue throws | F-04 |
| `utils/pagination.js` | `decodeCursor(cursor, shape)` checks each element's type (`date`, `uuid`, `int`, `string`); new `intParam()` (decimal digits only) and `isoDateParam()` (calendar-exact) | F-05 |
| `services/football.service.js`, `services/personal.service.js`, `services/analytics.service.js` | Every cursor call site passes its shape | F-05 |
| `controllers/football.controller.js` | Dates use `isoDateParam`; `period`, `possessionId`, search `limit` and metric `version` use `intParam` | F-05 |
| `middlewares/validate.middleware.js` | An iterative walk over every validated value rejects NUL bytes (values and keys) and nesting deeper than 32 | F-05 |
| `utils/asyncHandler.js` | `describeForLog()`: logs the database code and a message with quoted values removed, `at` frames only, and the matched route instead of the URL | F-06 |
| `middlewares/rateLimit.middleware.js` | In-memory fallback for every limit when Redis is missing or errors; limiter construction inside the `try`; `ipBackstop` for every request; `memoryHit` and `resetMemoryLimits` exported | F-07, F-20 |
| `app.js` | Backstop mounted first; `/readyz` limited to 30/min; webhooks limited to 300/min/IP | F-07, F-08 |
| `app.js` | `Vary: Authorization` on every response and `Cache-Control: private, no-store` when authenticated | F-13 |
| `app.js` | Helmet CSP `default-src 'none'; frame-ancestors 'none'` | F-18 |
| `app.js` | `trust proxy` only when `TRUST_PROXY` is configured; the edge gate marks requests as `edgeVerified` | IP trust hardening, from earlier work; now tested |
| `configs/clerk.js` | `verifyWebhook` rejects payloads whose shape is wrong with 400 | F-11 |
| `controllers/webhook.controller.js` | 400 from verification is passed through (not reported as a bad signature) | F-11 |
| `services/personal.service.js` | `withSavedItemsLock()`: count, check and insert run inside a transaction holding a per-user advisory lock | F-09 |
| `workers/runner.js` | `recoverStale()` marks stale jobs with no attempts left as `dead` | F-10 |
| `services/entitlements.service.js` | `resolve()` reads limits from the current definition of each grant's source plan | F-12 |
| `services/football.service.js` | `escapeLike()` applied to user LIKE patterns | F-19 |
| `configs/env.js` | No `.env` files in test processes; new `THROTTLE_IP_BACKSTOP_PER_MIN`, `TRUST_PROXY`, `BILLING_FAKE_VERIFIER` | F-17, F-07 |
| `configs/redis.js` | `setRedisClientForTests()` test seam; the warning message corrected | Testability |
| `configs/s3.js` | `resetStorage()` test seam | Testability |
| `configs/googlePlay.js` | Fake verifier: per-token order ids, `failWith()` outage simulation, `setState(…, extra)` for linked tokens | Testability |
| `services/personal.service.js` | `createCollection` no longer returns `ownerUserId`; collection-item routes return `{ collection }` | Response consistency (before the audit, recorded here for completeness) |

## Configuration, CI and tooling

| File | Change | Why |
|---|---|---|
| `.github/workflows/tests.yml` | `permissions: contents: read`; actions pinned to SHAs; `npm ci --ignore-scripts`; runs `npm run test:coverage` against a Postgres service | F-16 |
| `.github/workflows/jobs.yml` | `permissions: contents: read`; SHA pins; schedule and input passed through env vars instead of `${{ }}` in shell; `npm ci --omit=dev --ignore-scripts` | F-16 |
| `.github/workflows/security.yml` (new) | Dependency audit (production high+, all critical), Gitleaks over full history (pinned image), Semgrep ERROR gate (pinned image); on push, PR and weekly | Phase 9 |
| `.gitleaks.toml` (new) | Default rules plus two line-shaped allowlist entries for public StatsBomb UUIDs and metric keys (35 false positives); a planted canary secret is still detected | Phase 9 |
| `.semgrepignore` (new) | Excludes `node_modules`, fixtures, docs and audit scratch | Phase 9 |
| `package.json` | Tests run sequentially (shared database); `test:coverage`, `security:audit`, `security:secrets`, `security:sast` | Phase 9 and 11 |
| `.env.example`, `README.md`, `docs/API.md` | Documented the new settings, strict validation, the no-charge-on-failure rule, cache headers and the security commands | API consumers |
| `.gitignore` | The audit reports are committed; the automated review tool's scratch copy (`SECURITY_AUDIT/agents/`) and metadata stay ignored | Deliverables |
| `tests/support/tokens.js` | Inline `nosemgrep` with the exact rule id on two lines that handle the per-run random test secret | False positive (documented) |

## Tests added

There are 13 new test files and 4 new support modules. See `TEST_COVERAGE.md`.
