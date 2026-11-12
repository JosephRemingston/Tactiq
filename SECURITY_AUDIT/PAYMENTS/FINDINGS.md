# Payment findings

Every finding was reproduced against a running instance on a local database with the fake Google Play verifier (`payprobe.mjs`, then the tests in `tests/payments.test.js`), before and after the fix. No real purchase, refund or Google API call was made.

| Severity | Found | Fixed | Accepted |
|---|---|---|---|
| High | 3 | 3 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 3 | 2 | 1 |
| Informational | 3 | 1 | 2 |

## High

### P-1. An older store answer arriving late restored Pro after a refund

- **Where:** `applyState` wrote whatever answer arrived last.
- **Reproduction:** A restore asks Google and its reply is delayed (`holdNext`). Meanwhile a REVOKED notification is applied, and the plan is Free. The delayed reply then lands and the plan is **Pro** again, with no time limit other than the old expiry.
- **Impact:** A refunded user keeps paid access. Any slow network reply, retry or reconciliation overlapping a refund can trigger it.
- **Fix:**
  - Each answer carries `fetchedAt`, taken before the store call. An answer older than the stored `last_verified_at` is discarded.
  - A per-token advisory lock makes the check-and-write atomic.
  - `last_verified_at` only moves forward.
- **Tests:**
  - "a refund wins over a slower, older store answer…"
  - "an older answer arriving late never overwrites a newer non-terminal state…"
  - "writers for one token are serialized…" (this one fails without the lock).

### P-2. A refunded purchase could become active again

- **Where:** `revoked` was an ordinary state.
- **Reproduction:** REVOKED, then a late RENEWED notification. The store answer says active, and the plan becomes **Pro**.
- **Impact:** Paid access after a refund.
- **Fix:** `revoked` is terminal for that token. Google issues a new token for a new purchase.
- **Test:** "a revoked purchase stays revoked…"

### P-4. A store answer with no expiry granted Pro forever

- **Where:** `fromSubscriptionV2` maps a missing `expiryTime` to `null`, and `isEntitled` treated `null` as "no end".
- **Reproduction:** The store returns active with no expiry. Verify returns 200, and the grants have `valid_until = NULL`.
- **Impact:** Unlimited Pro from one malformed or truncated store answer. The likelihood is low; the impact is permanent.
- **Fix:**
  - `assertStoreResponse` rejects an answer with no product, an unknown state, or a missing or invalid expiry where one is needed. Verify then answers 503 and writes nothing.
  - `accessUntil` never treats a missing date as "forever".
- **Tests:**
  - "an active answer without an expiry is refused (503)…"
  - Unit tests "access follows state… a missing expiry never means forever" and "store answers without a product… are rejected".

## Medium

### P-5. Grace-period users were cut off early

- **Reproduction:** The state is `grace` and the reported expiry has passed. The plan was Free.
- **Impact:** A paying user whose card is being retried loses access, although Google keeps them entitled during grace.
- **Fix:** In grace, access lasts until the later of the expiry and the next UTC midnight plus 3 days. Notifications and the daily reconciliation move it on or end it. Anchoring to the day means repeated reads on the same day write nothing.
- **Caveat:** Google's exact `expiryTime` behaviour during grace is unverified (see REMAINING_RISKS PR-1).
- **Test:** "a grace-period purchase keeps access even when its reported expiry has passed".

### P-6. The database did not enforce one subscription per token or one grant per feature

- **Where:** The only unique keys were the primary keys and `purchases(store, purchase_token)`. Duplicate prevention lived in application code.
- **Impact:** Any code path that skipped the application check (a future change, a manual script, a race outside the lock) could create double grants.
- **Fix:**
  - Migration `0003_payment_integrity.sql` adds two partial unique indexes and CHECK constraints on every status column.
  - Inserts use `ON CONFLICT DO NOTHING`.
  - With the advisory lock removed, all duplicate-grant tests still pass because the indexes alone hold.
- **Test:** "the database itself refuses a second subscription per token, a duplicate grant, and unknown states".

### P-7. A pending upgrade cut off the paid plan and left an inconsistent state

- **Reproduction:** The user is on monthly and buys annual, which stays `pending` and links to the monthly token.
  - The monthly grants were expired at once, so the user had **no Pro**.
  - The monthly subscription row still said `active`.
- **Fix:**
  - The replaced token is ended only when the replacement itself grants access.
  - Its subscription row is updated with its grants, and only for the same user.
- **Test:** "monthly → annual: a pending replacement keeps the paid monthly…"

### P-8. A replaced token could be reactivated by a late answer

- **Found:** during the P-7 fix.
- **Reproduction:** Monthly is replaced by an active annual. A late RENEWED for the monthly token, or a restore while the store still reports it active, reactivated the monthly subscription and grants next to the annual ones.
- **Impact:** Two active subscriptions; "old overwrites new".
- **Fix:** A token that a granted replacement names in `linkedPurchaseToken` stays `expired`.
- **Test:** the same monthly → annual test (its last part fails without the fix).

### P-9. A refund could be discarded as stale

- **Found:** in review of the first P-1 fix; it never shipped.
- **Problem:** With the staleness guard alone, a forced `revoked` from a notification would be dropped if a concurrent read with a later `fetchedAt` had already been applied.
- **Fix:** Terminal states bypass the staleness guard.
- **Test:** "a refund is applied even when a newer ordinary read was applied while it was in flight" (fails without the fix).

## Low

### P-3. Duplicate notifications rewrote rows and added audit rows

- **Reproduction:** 20 notifications with new message ids and an unchanged state produced 20 subscription updates, 20 grant updates and **20 audit rows**.
- **Impact:** A misleading audit trail, write amplification, and lock pressure under a notification storm.
- **Fix:**
  - Updates use `WHERE … IS DISTINCT FROM …`.
  - An audit row is written only when grants changed.
  - The fake verifier now returns fixed dates, as Google does. Before, it moved the expiry on every read and hid this.
- **Test:** "20 different notifications that report an unchanged state write nothing…"

### P-11. Cached grants can outlive a refund by up to 60 seconds (accepted)

- **Where:** Grants are cached in Redis for 60 s. After a commit the cache key is deleted. If the delete fails, or a concurrent request reloads the old rows just before the commit and stores them just after the delete, metered and gated routes can see Pro for up to 60 s more.
- **Not affected:** `currentPlan` (the plan shown to the user) reads the database and is correct at once.
- **Decision:** Accepted. The window is bounded and short, and closing it would mean dropping the cache or versioning keys per commit.
- **Test:** "after a refund the plan is free at once; if Redis cannot be cleared, cached grants outlive it by at most the 60 s TTL".

### P-12. Reconciliation had no order

- **Problem:** With more than 500 purchases due, the same rows could be picked each day and others starved.
- **Fix:** Oldest `last_verified_at` first.

## Informational

### P-10. A lost acknowledgement response recovers (no change needed)

- **Behaviour:** Google acknowledged, but the response was lost.
- **Result:** The next verify or reconciliation reads `acknowledgementState` from Google and records it, with no second acknowledge call.
- **Test:** "acknowledgement succeeded at the store but the response was lost…"

### P-13. The order id is not unique (by design)

- **Why:** Order ids repeat across renewals (`GPA.x..0`, `..1`) and are used only to match voided-purchase notifications.
- **Change:** Indexed, not made unique.

### P-14. No Redis lock is involved in any financial operation (no change needed)

- **Behaviour:** All payment idempotency and serialization is in Postgres: the unique keys, the advisory lock and transactions.
- **Result:** A Redis outage cannot cause a duplicate grant.
