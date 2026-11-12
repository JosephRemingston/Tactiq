# Failure scenarios

How each failure was injected:
- **Crash points:** `BillingService.faultInjector`, a test hook that throws at `beforeCommit`, `afterCommit` or `afterAcknowledge`.
- **Store failures:** the fake verifier's `failWith`; `holdNext` delays a reply.
- **Failing Redis:** a stand-in Redis client.
- **Concurrency:** real parallel HTTP requests and service calls on pooled connections.

Results are from `tests/payments.test.js` unless another file is named.

## Crash and timeout points in a purchase

| # | Failure point | What is persisted | What happens next | Outcome | Test |
|---|---|---|---|---|---|
| 1 | Before the store call (bad input, wrong owner) | nothing | 400/409 | No grant, no acknowledgement | `security.billing.test.js` |
| 2 | Store unreachable or 5xx | nothing | 503; the app retries | No grant | "an unverified purchase is never acknowledged…" |
| 3 | Store answer incomplete (no expiry) | nothing | 503; the app retries | No grant, no acknowledgement | "an active answer without an expiry is refused…" |
| 4 | Crash inside the transaction (before commit) | nothing (rolled back) | Retry grants once | One grant | "crash before commit…" |
| 5 | Commit done, crash before acknowledging (or the response to the app is lost) | grant, `acknowledged = false` | The app's retry acknowledges; otherwise reconciliation does (Google's 3-day window) | One grant, acknowledged | "store verified, grant committed, then the server dies…", "if the client never retries, reconciliation acknowledges…" |
| 6 | Acknowledgement call fails | grant, `acknowledged = false` | Reconciliation retries | Acknowledged later | `security.billing.test.js` (acknowledgement failure) |
| 7 | Acknowledgement succeeds at Google, response lost | grant, `acknowledged = false` | The next read reports Google's acknowledgement; recorded without calling again | Acknowledged once | "acknowledgement succeeded at the store but the response was lost…" |
| 8 | Crash after acknowledging, before responding | everything | Retry is a no-op | No change | "crash after acknowledging…" |
| 9 | Process killed mid-transaction (power loss, SIGKILL) | nothing (Postgres rolls back an uncommitted transaction; the advisory lock is released with the connection) | as #4 | as #4 | Covered by #4 plus Postgres semantics; a real SIGKILL is tested for the job runner in `security.jobs.test.js`, not for the verify route |

## Notifications

| Failure | Outcome | Test |
|---|---|---|
| Processing fails mid-transaction | Rolled back; row `failed`; 503 so Pub/Sub redelivers; the redelivery processes it | "a notification that fails mid-transaction is rolled back…" |
| Store unreachable while processing | 503; Pub/Sub retries | `security.billing.test.js` |
| Delivered 20 times | One row; processed once | "the same message delivered 20 times…" |
| 20 notifications, unchanged state | 0 writes | "20 different notifications…" |
| Arrive out of order / reply delayed | Older answers ignored | "a refund wins…", "an older answer arriving late…" |
| Refund read delayed behind a newer ordinary read | The refund still applies | "a refund is applied even when a newer ordinary read…" |
| Duplicate refunds in parallel | One revoke | "a voided refund of the current order revokes…" |
| For an unknown token | `ignored` | `security.billing.test.js` |
| Forged, wrong app, malformed | 401/400 | `security.billing.test.js` |

## Concurrency

| Race | Outcome | Test |
|---|---|---|
| 2/10/50/100 parallel verifies of one token | One subscription and grant set | "N parallel verifications…" |
| 10 accounts racing for one token | One owner, nine 409s | "10 accounts racing…" |
| A newer writer mid-transaction while an older answer arrives | Older waits on the lock, then is discarded | "writers for one token are serialized…" (fails without the lock) |
| Two reconciliation runs + an expiry notification | One `expire` audit row; consistent grants | "two reconciliation runs…" |
| Renewal notifications racing a reconciliation | Consistent; latest store state | "a missed renewal is picked up…" |

## Dependencies down

| Dependency | Effect on payments |
|---|---|
| Google Play API | Verify and restore 503; notifications 503 (redelivered); reconciliation counts the failure and continues. Never grants, never revokes on an outage |
| Postgres | Requests fail with 503/500; nothing partial (transactions). `security.failures.test.js` |
| Redis | No effect on correctness. The entitlement cache falls back to the database; if a cache delete fails, cached grants last at most 60 s (FINDINGS P-11) |
| Pub/Sub | Missed notifications are caught by the daily reconciliation (renewals, expiries, acknowledgements) |
| GitHub Actions (worker) | Reconciliation is delayed; the app's own verify and restore still acknowledge. Grants already carry `valid_until`, so expiry needs no job |

## Not simulated

- Real network partitions to Neon or Google.
- Neon's pooler failing over mid-transaction. Postgres semantics apply, but this was not tested on Neon.
- Netlify killing a function at its time limit mid-request. Equivalent to rows #4, #5 or #8, depending on the moment.
