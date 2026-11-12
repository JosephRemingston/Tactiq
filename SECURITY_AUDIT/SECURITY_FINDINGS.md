# Security findings register

Every finding below was **reproduced against a running instance on a local database before it was fixed**. The probes are described under each finding's "Attack scenario". Each one was **re-tested after the fix**, and each has an automated regression test.

For the main regressions (F-01, F-02, F-04, F-09 and F-12), the fix was also temporarily removed to confirm that the regression test fails without it.

Severity reflects the impact on this product (paid subscriptions, personal data, availability on free-tier infrastructure) and how easy the attack is.

| ID | Title | Severity | Status |
|---|---|---|---|
| F-01 | One purchase token can grant Pro to several accounts (race) | **High** | Fixed |
| F-02 | Refund of an older renewal revokes an active paid subscription | Medium | Fixed |
| F-03 | Late or replayed Clerk webhook restores a deleted user's personal data | Medium | Fixed |
| F-04 | Usage is charged for requests that fail | Medium | Fixed |
| F-05 | Unvalidated input reaches Postgres (500s): cursors, impossible dates, NUL bytes, loose numbers | Medium | Fixed |
| F-06 | Error logs contain query parameters (private notes, emails) and full URLs | Medium | Fixed |
| F-07 | Rate limiting switches off when Redis is missing or failing; some routes never limited | Medium | Fixed |
| F-08 | Forged webhooks write an unbounded number of security-log rows | Low | Fixed |
| F-09 | Saved-items limit can be exceeded with parallel requests | Low | Fixed |
| F-10 | A job that crashes on its final attempt stays "queued" forever | Low | Fixed |
| F-11 | A correctly signed webhook with a non-object payload crashes the handler | Low | Fixed |
| F-12 | Changes to plan limits never reach existing users | Low | Fixed |
| F-13 | Authenticated responses have no cache directives | Low | Fixed |
| F-14 | Google notifications without a package name are accepted | Low | Fixed |
| F-15 | "Restore purchases" during a store outage returns a generic 500 | Low | Fixed |
| F-16 | CI workflows: default token permissions, mutable action tags, shell interpolation, install scripts with secrets | Medium | Fixed |
| F-17 | Test runs could load a developer's production `.env` | Low | Fixed |
| F-18 | Content-Security-Policy disabled | Low | Fixed |
| F-19 | LIKE wildcards in search input are not escaped | Informational | Fixed |
| F-20 | Rate-limiter construction errors are not caught | Informational | Fixed |
| F-21 | Correctly signed but non-JSON Clerk payloads are reported as 401, not 400 | Informational | Accepted |
| F-22 | Dev-only dependency advisories (drizzle-kit → esbuild dev server) | Informational | Accepted |

Not exploitable, verified by tests:
- SQL injection
- IDOR/BOLA on every private resource
- BFLA
- JWT forgery (alg none, HS256 confusion, foreign key, tampered payload or header, expired, not yet valid, wrong party, pending session)
- prototype pollution and mass assignment
- deeply nested JSON
- SSRF (no user-controlled outbound URLs)
- provider path traversal
- the monthly-limit race (the usage row is locked)
- duplicate account creation

---

## F-01: One purchase token can grant Pro to several accounts

- **Severity:** High (direct revenue loss; repeatable by anyone holding one valid token).
- **Affected files:** `services/billing.service.js` (`verifyPurchase`, `applyState`).
- **Vulnerable path:** `POST /v1/billing/google-play/verify` → `verifyPurchase()` checks for an existing owner **before** asking Google → `applyState()` upserts the purchase row and creates the subscription and grants for **the caller's** `userId`.
- **Attack scenario:** two or more accounts submit the same real purchase token at the same moment. Each passes the "already linked?" check, because no row exists yet. The second upsert waits for the first transaction, then updates the same row, still owned by account 1. Its code nevertheless inserts a subscription and Pro grants for account 2, because `purchase.subscriptionId` was empty when it read the row.
  - Reproduced: two concurrent requests both returned 200 and both accounts showed `pro_monthly`.
- **Business impact:** one paid subscription unlocks Pro for an unlimited number of accounts (token sharing or reselling). The refund and expiry handling only ever updates the first account.
- **Root cause:** the ownership check happened outside the transaction (check-then-act, CWE-362), and the transaction trusted the caller's id instead of the row's owner.
- **Remediation:** inside the transaction, immediately after the upsert, compare `purchase.userId` with the caller and throw `PurchaseOwnershipError` on a mismatch. The upsert holds the row lock until commit, so the check cannot race. The whole transaction rolls back, and the caller gets 409 plus a `purchase_token_reuse` security event.
- **Regression tests:** in `tests/security.billing.test.js`:
  - "REGRESSION F-01: two accounts verifying one token at the same moment yield exactly one Pro account" (5 rounds of 4 concurrent accounts)
  - "the same account verifying the same token concurrently creates one subscription"
  - "a token already linked to one account cannot be claimed by another"
- **Status:** Fixed and verified. Removing the fix makes the regression test fail.

## F-02: Refund of an older renewal revokes an active paid subscription

- **Severity:** Medium (paying users lose access; support load; can be triggered by a partial refund in Play Console).
- **Affected files:** `services/billing.service.js` (`handleRtdn`).
- **Vulnerable path:** `POST /v1/webhooks/google-play-rtdn` with a `voidedPurchaseNotification` → forced state `revoked` for **any** voided notification on the token.
- **Attack/incident scenario:** a renewal order from months ago is refunded or charged back. Google sends a voided-purchase notification carrying that old `orderId` and the subscription's token. The backend revoked Pro even though the current period was paid.
  - Reproduced: `pro_annual` became `free`.
- **Root cause:** the notification's `orderId` was ignored.
- **Remediation:** revoke only when the voided `orderId` equals the purchase's current (latest) order id, or on an explicit `SUBSCRIPTION_REVOKED`. Otherwise re-read the state from Google as for any other notification.
- **Regression test:** `tests/security.billing.test.js`, "REGRESSION F-02: a refund of an older renewal does not end a running subscription; a refund of the current order does".
- **Status:** Fixed and verified. Removing the fix makes the test fail.

## F-03: Late or replayed Clerk webhook restores a deleted user's personal data

- **Severity:** Medium (privacy: deleted personal data reappears; conflicts with the stated deletion behaviour).
- **Affected files:** `services/users.service.js` (`upsert`).
- **Vulnerable path:** `POST /v1/webhooks/clerk` `user.updated` or `user.created` → `users.upsert()` → `ON CONFLICT (clerk_user_id) DO UPDATE` with no condition, followed by re-inserting `user_identities`.
- **Scenario:** a user deletes their account, which scrubs email, name and avatar and deletes identities. A `user.updated` delivery that was queued earlier, or retried by Svix, arrives afterwards.
  - Reproduced: the row returned to `email = back@example.com, display_name = "Resurrected Person"` while `status = deleted`.
- **Root cause:** the upsert did not take the account's status into account.
- **Remediation:** add `setWhere status = 'active'` to the conflict update. When no row is returned (a deleted account), return the deleted row without touching identities.
- **Regression test:** `tests/security.webhooks.test.js`, "REGRESSION F-03: a late or replayed user.updated cannot restore a deleted account's personal data".
- **Status:** Fixed and verified.

## F-04: Usage is charged for requests that fail

- **Severity:** Medium (billing integrity; Free users lose monthly units to 404s and 409s; at the limit, a failing request burns the last unit).
- **Affected files:**
  - `middlewares/entitlement.middleware.js` (`metered`): refunded only on 5xx.
  - `services/jobs.service.js` (`requestAnalysis`): charged even when no new job was queued or the enqueue failed.
- **Scenario:** `GET /v1/matches/<random-uuid>/metrics` returns 404 and charges one unit. Opening an unanalysed match returns 409 and also charges.
  - Reproduced: usage went from 0 to 1 on a 404.
- **Root cause:** the refund policy distinguished client errors from server errors, but the charge is taken before the match is checked.
- **Remediation:** refund on any error thrown after the charge. Re-analysis refunds when the job already exists and is not failed or dead, or when the enqueue throws.
- **Regression tests:**
  - `tests/security.entitlements.test.js`: "REGRESSION F-04" (two tests), "re-analysis: no charge when the identical job already ran…", "re-analysis is charged only when new work is queued" and "re-analysis is refused at the monthly limit…"
  - The comparison-charging test.
- **Status:** Fixed and verified. Removing the fix makes three tests fail.

## F-05: Unvalidated input reaches Postgres

- **Severity:** Medium (anyone can generate a stream of 500s and error-log noise; contributes to F-06; no data exposure).
- **Affected files:**
  - `utils/pagination.js` (`decodeCursor` only checked the tuple's shape)
  - `services/*` (call sites)
  - `controllers/football.controller.js` (date regex, `z.coerce.number`)
  - `middlewares/validate.middleware.js`
- **Scenarios (all reproduced as 500s):**
  - Crafted cursors (`["abc","x"]` on events, a non-uuid on teams, a bad date on matches, saved items and notes).
  - `?from=2022-13-45`.
  - NUL bytes in a note body or in search.
- **Additional laxness found while testing:**
  - `2023-02-29` and `2022-02-30` were accepted, because JavaScript rolls them into March.
  - `0x10`, `0b11`, `5e0` and ` 5 ` were accepted as numbers.
- **Root cause:** client-supplied values were bound into SQL after only partial validation.
- **Remediation:**
  - Typed cursor decoding: `decodeCursor(cursor, ["date","uuid"])` and similar, where `int` means a safe non-negative integer.
  - Calendar-exact date checks (`isoDateParam`).
  - Decimal-digits-only integers (`intParam`) for every numeric query parameter.
  - An iterative pass over every validated value that rejects NUL bytes in values and keys, and nesting deeper than 32 levels. The pass is iterative so that hostile nesting cannot exhaust the stack: the first recursive version returned 500 for 100,000-deep JSON, which the tests caught.
- **Regression tests:**
  - `tests/security.validation.test.js`: "REGRESSION F-05" (two tests); numeric parameters; malformed ids; deep JSON; fuzz with 190 seeded and hostile strings on 6 routes.
  - `tests/security.units.test.js`: 2,000-case property tests on cursors and validation.
- **Status:** Fixed and verified.

## F-06: Error logs contain query parameters and full URLs

- **Severity:** Medium (privacy: private notes, emails and purchase tokens are copied into Netlify logs, which have broader access and their own retention).
- **Affected files:** `utils/asyncHandler.js` (`sendError`).
- **Scenario:** any query error is logged with `err.message`, which for Drizzle is `Failed query: … params: <values>`, plus `err.stack`, which repeats the message, plus `req.originalUrl`.
  - Reproduced: the text of a user's private note appeared in the error log.
- **Remediation:** a new `describeForLog()` logs:
  - the database error code
  - the cause message with every quoted value replaced
  - only the `at …` stack frames
  - the matched route pattern instead of the URL
- **Regression tests:** `tests/security.units.test.js`, "unknown errors become a generic 500 with no internals" and "describeForLog strips bound parameters…" (300 randomised secrets × 3 message shapes). `tests/security.validation.test.js`, "no request in this suite produced an unhandled server error or leaked request data to the log".
- **Status:** Fixed and verified.

## F-07: Rate limiting switches off when Redis is missing or failing

- **Severity:** Medium (abuse controls disappear exactly when the shared store is degraded; quotas on free-tier Neon and Upstash can be exhausted).
- **Affected files:** `middlewares/rateLimit.middleware.js`, `app.js`.
- **Scenarios:**
  - Without Redis, 30 consecutive `POST /v1/billing/restore` calls were all served (reproduced).
  - Even with Redis, these were never counted:
    - webhooks
    - `/readyz`, which makes three backend calls per request
    - the root and 404 routes when a fake `Authorization` header was sent
- **Root cause:** a fail-open design, and limits that were attached to authentication middleware only.
- **Remediation:**
  - Every limit falls back to in-memory fixed-window counters when Redis is absent or errors.
  - Limiter construction errors are caught (F-20).
  - A per-IP backstop runs in memory for every request.
  - Dedicated limits: `/readyz` 30/min; webhooks 300/min/IP.
- **Regression tests:** `tests/security.http.test.js`, "REGRESSION F-07" (three tests), "spoofed forwarding headers… do not reset the per-IP budget", "forged Authorization headers do not escape limiting", and the user-budget test. `tests/security.units.test.js`: property test that the memory limiter never exceeds its limit.
- **Status:** Fixed and verified. The fallback is per instance, so it is weaker than a shared limit; see R-2.

## F-08: Forged webhooks write an unbounded number of security-log rows

- **Severity:** Low (database write amplification by an unauthenticated caller: 40 forged requests wrote 40 rows).
- **Affected files:** `controllers/webhook.controller.js`, `app.js`.
- **Remediation:** the 300/min per-IP webhook limit (part of F-07). Logging of rejections is kept, because it is useful for detecting attacks.
- **Regression test:** `tests/security.webhooks.test.js`, "forged deliveries are capped per IP".
- **Status:** Fixed (bounded).

## F-09: Saved-items limit can be exceeded with parallel requests

- **Severity:** Low (bypasses a Free limit; storage abuse is bounded by the rate limit).
- **Affected files:** `services/personal.service.js` (`saveMatch`, `saveInsight`).
- **Scenario:** a user with a limit of 3 who holds 2 items saves 4 more in parallel. All 4 succeeded, for 6 in total (reproduced).
- **Root cause:** count, check and insert were not atomic.
- **Remediation:** run them in one transaction holding `pg_advisory_xact_lock(hashtextextended('saved-items:'||user))`.
- **Regression test:** `tests/security.entitlements.test.js`, "REGRESSION F-09: parallel saves cannot push a user past the saved-items limit".
- **Status:** Fixed and verified. Removing the fix makes the test fail.

## F-10: A job that crashes on its final attempt stays "queued" forever

- **Severity:** Low (silent loss of work: a poisoned job is invisible, neither retried nor dead).
- **Affected files:** `workers/runner.js` (`recoverStale`).
- **Scenario:** a job whose worker was killed during its last attempt went back to `queued` with `attempts = max_attempts`. The claim query skips such rows and the pending count excludes them (reproduced).
- **Remediation:** a stale lock on a job with no attempts left becomes `dead` with an explanatory error.
- **Regression tests:** `tests/security.jobs.test.js`:
  - "REGRESSION F-10: stale locks are recovered…"
  - "a worker process killed mid-job…", which uses a real `SIGKILL`ed child process
- **Status:** Fixed and verified.

## F-11: A correctly signed webhook with a non-object payload crashes the handler

- **Severity:** Low (needs the signing secret; leads to a 500 and Svix retries).
- **Affected files:** `configs/clerk.js` (`verifyWebhook`), `controllers/webhook.controller.js`.
- **Scenario:** a signed body of `[]` led to `event.data.id` throwing a TypeError and a 500. This was found by the new webhook tests.
- **Remediation:** check the event's shape after the signature check, and answer 400.
- **Regression test:** `tests/security.webhooks.test.js`, "malformed and oversized bodies fail cleanly without a 500".
- **Status:** Fixed and verified.

## F-12: Changes to plan limits never reach existing users

- **Severity:** Low (business integrity; the README promised that editing `plans.json` applies the change).
- **Affected files:** `services/entitlements.service.js` (`resolve`).
- **Root cause:** limits are copied into each user's entitlement rows when the plan is granted.
- **Remediation:** the resolver reads each grant's limit from the current definition of its source plan, so a re-seed applies immediately. Custom grants from unknown sources keep their own values.
- **Regression test:** `tests/security.entitlements.test.js`, "REGRESSION F-12".
- **Status:** Fixed and verified.

## F-13: Authenticated responses have no cache directives

- **Severity:** Low (a misconfigured CDN or proxy could store personalised responses).
- **Remediation:** `Cache-Control: private, no-store` whenever an `Authorization` header is present, and `Vary: Authorization` on every response.
- **Regression test:** `tests/security.http.test.js`, "authenticated responses are never storable by shared caches".
- **Status:** Fixed.

## F-14: Google notifications without a package name are accepted

- **Severity:** Low (needs the shared token).
- **Remediation:** when a package is configured, a notification must name it exactly.
- **Regression test:** `tests/security.billing.test.js`, "are refused without the shared token, with a wrong token, for another app, or when malformed".
- **Status:** Fixed.

## F-15: "Restore purchases" during a store outage returns a generic 500

- **Severity:** Low.
- **Remediation:** store errors become 503 "Could not reach the store…". Access is never removed because of an outage.
- **Regression test:** `tests/security.billing.test.js`, "a store outage fails safely…".
- **Status:** Fixed.

## F-16: CI workflow weaknesses

- **Severity:** Medium (`jobs.yml` holds every production secret).
- **Affected files:** `.github/workflows/jobs.yml`, `.github/workflows/tests.yml`.
- **Findings, confirmed by Semgrep:**
  - No `permissions:` block, so the default `GITHUB_TOKEN` scope applied.
  - Actions referenced by mutable tags.
  - `${{ github.event.schedule }}` and `${{ inputs.sync }}` interpolated straight into a shell script (`run-shell-injection`).
  - `npm ci` running dependency install scripts in a job holding secrets.
- **Remediation:**
  - `permissions: contents: read` everywhere.
  - Actions pinned to commit SHAs (checkout v4.4.0, setup-node v4.4.0).
  - Expressions passed through environment variables.
  - `npm ci --ignore-scripts`.
  - A new `security.yml` workflow for the dependency audit, Gitleaks over the full history, and Semgrep, with scanner images pinned by version.
- **Verification:** Semgrep's ERROR-severity gate now exits 0, where it previously reported `run-shell-injection` and four mutable tags.
- **Status:** Fixed.

## F-17: Test runs could load a developer's production `.env`

- **Severity:** Low (a test that forgot to set one variable could silently use the production database or a production key).
- **Affected files:** `configs/env.js`.
- **Remediation:**
  - `.env` files are never read when `NODE_ENV=test`.
  - The harness refuses non-local database hosts.
  - Unit tests use `tests/support/unitEnv.js`.
- **Regression test:** `tests/security.units.test.js`, "never loads .env files in a test process".
- **Status:** Fixed.

## F-18: Content-Security-Policy disabled

- **Severity:** Low (JSON API; defence in depth).
- **Remediation:** `default-src 'none'; frame-ancestors 'none'`.
- **Regression test:** `tests/security.http.test.js`, headers test.
- **Status:** Fixed.

## F-19: LIKE wildcards in search input are not escaped

- **Severity:** Informational (`%` and `_` matched everything; no injection, but expensive scans).
- **Remediation:** `escapeLike()` on every user-supplied LIKE pattern.
- **Regression tests:** `tests/security.validation.test.js`, "LIKE wildcards in search are literal"; `tests/security.units.test.js`, LIKE property test.
- **Status:** Fixed.

## F-20: Rate-limiter construction errors are not caught

- **Severity:** Informational (found while testing F-07; would have produced 500s instead of falling back).
- **Remediation:** construction moved inside the fallback's `try`.
- **Regression test:** `tests/security.http.test.js`, "a failing Redis falls back to in-memory limits…".
- **Status:** Fixed.

## F-21: Signed non-JSON Clerk payloads are reported as 401

- **Severity:** Informational. The Clerk library parses the body inside its verification step, so a correctly signed payload that is not JSON is reported as a verification failure. Only Clerk can produce such a payload. It fails closed and is logged as a rejection.
- **Status:** Accepted.

## F-22: Dev-only dependency advisories

- **Severity:** Informational. `npm audit` reports four moderate advisories, all from `drizzle-kit` (dev dependency) → `@esbuild-kit` → `esbuild` (the dev-server CORS issue, GHSA-67mh-4wv8-2f99). drizzle-kit never runs esbuild's dev server, and none of it ships: production dependencies have **0** advisories.
- **Status:** Accepted. CI fails on high or critical advisories in production dependencies and on critical ones anywhere.
