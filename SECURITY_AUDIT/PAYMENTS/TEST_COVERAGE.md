# Payment test coverage

## Numbers (final run, 12 November 2026)

| | Before this audit | After |
|---|---|---|
| Whole suite | 229 tests | **263** (263 pass, 0 fail, 0 skipped) |
| New payment tests (`tests/payments.test.js`) | — | 32 |
| New unit tests (`tests/security.units.test.js`) | — | 2, and 1 property test rewritten |
| Changed existing tests | — | 1: the state-cycle test now expects a revoked token to stay Free |
| `services/billing.service.js` | 100% lines / 87.9% branches | **100% / 91.6%** |
| `configs/googlePlay.js` | 96.4 / 89.2 | 96.8 / 89.5 |
| `controllers/webhook.controller.js` | 100 / 93.1 | 100 / 93.1 |
| All files | 96.5 / 85.5 | 96.6 / 86.0 |

- **Without a database:** `npm test` runs 88 tests: 87 unit tests pass and the database suites are skipped with a reason.
- **Repeatability:** the payment file was run 5 more times in a row, with 32/32 passing each time. The timing-dependent tests wait for real events, not just sleeps.

## Proof that the tests detect the bugs

Each fix was removed in turn and the payment tests re-run. Each removal made at least one named test fail; restoring it made all pass.

| Fix removed | Tests that failed |
|---|---|
| Staleness guard (P-1) | "an older answer arriving late never overwrites a newer non-terminal state" |
| Advisory lock (P-1) | "writers for one token are serialized" |
| Terminal `revoked` (P-2) | "a revoked purchase stays revoked" |
| Expiry validation (P-4) | "an active answer without an expiry is refused (503)" |
| Pending replacement guard (P-7) | "monthly → annual…" |
| Superseded token guard (P-8) | "monthly → annual…" |
| Refund bypasses staleness (P-9) | "a refund is applied even when a newer ordinary read was applied while it was in flight" |
| Write-only-on-change (P-3) | 6 tests: "20 different notifications…", "the same token verified 10 times…", "a grace-period purchase…", "a voided refund…", "crash after acknowledging…", "two reconciliation runs…" |

With the advisory lock removed, every **duplicate** test still passed: the unique indexes alone prevent double grants. That is the intended defence in depth.

## Coverage by area

| Area | Tests |
|---|---|
| Idempotency, sequential | the same token verified 10 times over HTTP |
| Idempotency, parallel | 2, 10, 50, 100 parallel verifications (through the service: the route allows 20/min) |
| Account binding | 10 accounts racing; a bound token cannot move (route, service guard, restore); obfuscated account id (`security.billing.test.js`) |
| Rate limiting | 21st verification in a minute → 429 |
| Store answer validation | no expiry → 503 and no grant; unit tests for missing product, unknown state, invalid dates |
| Never acknowledge unverified | unknown token, pending, wrong product, other account, outage |
| State machine | the state cycle (`security.billing.test.js`), grace past expiry, `on_hold`, property test over 1,000 random states and dates |
| Refunds and revocation | revoked is final; voided current order; duplicate parallel refunds; refund vs a delayed reply; refund vs a newer read |
| Out-of-order delivery | delayed older reply (terminal and non-terminal); serialization under the lock |
| Duplicate notifications | 20× the same id; 20 ids with the same state; the parallel duplicates in `security.billing.test.js` |
| Plan changes | pending upgrade; granted upgrade; late renewal of the replaced token; a replacement naming another user's token |
| Acknowledgement | lost response; failure and retry (`security.billing.test.js`) |
| Crash points | before commit, after commit (client retries / reconciliation), after acknowledge, notification mid-transaction, and a real SIGKILL of a process holding the purchase transaction (rolled back, lock released, the waiting retry grants once) |
| Reconciliation | parallel runs with a notification; a missed renewal; renewals racing a run |
| Cache consistency | Redis delete failing after a refund: the plan is Free at once, cached grants for at most 60 s |
| Database integrity | duplicate subscription → 23505; duplicate grant → 23505; invalid statuses on 4 tables → 23514 |
| Secrets in logs | failure paths (outage, acknowledgement failure, reconciliation failure, notification failure, token reuse, forged notification): no token, token fragment or RTDN secret in the logs or `security_events` |

## Scanners (final code)

| Check | Result |
|---|---|
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Semgrep 1.184.0 (ERROR gate; 137 rules on 162 files) | 0 findings |
| Gitleaks v8.30.1, git history (9 commits) | No leaks |
| Gitleaks, working-tree folders changed in this audit (`services`, `tests`, `configs`, `models`, `migrations`) | No leaks. A wider directory scan matches only the git-ignored local `.env` (known, R-17) |

## Gaps

| Gap | Why | What would close it |
|---|---|---|
| The real Google Play API | No Play Console listing yet; tests must not create real purchases | Licence-tester (sandbox) purchases through every state before launch (REMAINING_RISKS PR-1 to PR-5) |
| Neon pooler behaviour with advisory locks | Tests use local Postgres | One staging run of the parallel tests against a Neon branch |
| Real Upstash | Fakes only | Optional test against a dedicated Upstash database |
