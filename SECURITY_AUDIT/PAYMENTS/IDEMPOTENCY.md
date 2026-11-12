# Idempotency

The design assumes **at-least-once execution**:
- clients retry;
- Pub/Sub redelivers;
- workers re-run;
- servers crash between steps.

Every operation is therefore safe to repeat. Duplicates are stopped in Postgres, never by Redis.

## Layers

| Layer | Mechanism | What it stops |
|---|---|---|
| Database uniqueness | `purchases(store, purchase_token)`, `subscriptions(source, provider_subscription_id)`, `entitlements(source_subscription_id, feature_key)`, `billing_notifications(store, message_id)` | A second purchase, subscription, grant set or notification row, whatever the code path |
| Transactions | Each store answer is applied in one transaction | Half-applied states; a crash rolls everything back |
| Per-token advisory lock | `pg_advisory_xact_lock(hashtextextended('purchase:'+token, 0))` in `applyState` and `endReplaced` | Interleaved writers for one token, so check-then-write is atomic |
| Monotonic reads | `fetchedAt` (taken before the store call) compared with `last_verified_at` | Old answers overwriting newer ones |
| Write only on change | `IS DISTINCT FROM` guards; audit row only when grants changed | Repeats leaving traces (updates, audit rows) |
| Store state as the record | Acknowledgement state read from Google and ORed into the row | Double acknowledgement after a lost response |

Redis is not used for any payment decision or lock. The only Redis involvement is the entitlement read cache (see FINDINGS P-11).

## Per operation

| Operation | Idempotency key | Repeat behaviour | Proven by |
|---|---|---|---|
| Verify purchase | Purchase token (unique) + lock | Same row, same subscription, same grants; one `grant` audit row ever | 10 sequential; 2/10/50/100 parallel; crash before or after commit; crash after acknowledge |
| Verify by another account | Owner check under the lock | 409; no rows for the second account | 10 accounts racing for one token |
| Restore | Each owned token re-read and applied | No writes when nothing changed | state cycle test; grace test |
| Notification, same message id | `billing_notifications(store, message_id)` | `duplicate` once `processed` or `ignored`; a `failed` message is retried on redelivery | 20 deliveries of one message; failing mid-transaction then redelivered |
| Notifications, different ids, same state | Write only on change | 0 updates, 0 audit rows | 20 notifications (10 sequential, 10 parallel) |
| Refund (REVOKED or voided current order) | Terminal state | Applied once; later answers cannot undo it | 10 parallel voided notifications → one `revoke` audit row |
| Acknowledge | Google's `acknowledgementState` + DB flag | Not called again once Google reports it | lost acknowledgement response |
| Reconciliation | Same as `applyState`; ordered oldest first | Re-running or running in parallel is safe | two runs + a notification in parallel |
| Usage metering (paywall) | `entitlement_usage_events(user, feature, period, subject)` with `FOR UPDATE` | The same match is charged once (from the earlier audit, F-04/F-09) | `security.entitlements.test.js` |

## Scenarios you asked about

| Scenario | Result | Test |
|---|---|---|
| Google verifies, then the backend times out; the client retries | One grant; the retry acknowledges | "store verified, grant committed, then the server dies before answering…" |
| Acknowledgement succeeds but the response is lost | Recorded on the next read; no second call | "acknowledgement succeeded at the store but the response was lost…" |
| 10 requests with the same token | One subscription, one grant set | "10 parallel verifications…" (also 2, 50, 100) |
| Two accounts, same token | The first wins; the others get 409 | "10 accounts racing for one token…" |
| Refund before a delayed renewal | Stays Free | "a refund wins over a slower, older store answer…" |
| Redis still says Pro after a refund | The plan is Free at once; cached grants last at most 60 s | "after a refund the plan is free at once…" |
| Worker crashes after commit | Committed work stays; the next run continues; nothing is applied twice | crash-point tests; job-runner crash test in `security.jobs.test.js` |
| The same webhook 20 times | One notification row; processed once | "the same message delivered 20 times…" |
| Renewal and expiry workers at the same time | Serialized; ends in the store's latest state; one `expire` audit row | "two reconciliation runs and an expiry notification…", "a missed renewal…" |
| Monthly → annual: the old must not overwrite the new | The replaced token stays expired | "monthly → annual…" |
