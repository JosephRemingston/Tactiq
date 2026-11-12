# Payment architecture

Scope: everything that turns a Google Play subscription into Pro access. Date: 12 November 2026.

## Components

| Component | File | Role |
|---|---|---|
| Verify route | `routes/billing.routes.js` → `controllers/billing.controller.js` | `POST /v1/billing/google-play/verify`. Signed-in user, rate limit 20/min per user, strict body schema (`productId`, `purchaseToken` only) |
| Restore route | same | `POST /v1/billing/restore`. Rate limit 10/min per user |
| Notification webhook | `controllers/webhook.controller.js` | `POST /v1/webhooks/google-play-rtdn`. Google Pub/Sub push; shared token in the query, compared in constant time |
| Billing service | `services/billing.service.js` | The only code that writes billing state. `verifyPurchase`, `restore`, `handleRtdn` and `reconcile` all end in `applyState` |
| Store client | `configs/googlePlay.js` | `GooglePlayVerifier` (real: `purchases.subscriptionsv2.get` and `subscriptions.acknowledge`, service-account JWT) and `FakePurchaseVerifier` (tests and local use only; refused when `NODE_ENV=production`) |
| Entitlements | `services/entitlements.service.js` | Reads grants (cached 60 s in Redis under `ent:<userId>`), `currentPlan` (database only), usage metering |
| Reconciliation job | `workers/billing.workers.js` | `billing_reconcile`, one job per UTC day, run by `worker.js` from GitHub Actions (hourly drain) |

## Tables

| Table | Holds | Uniqueness and checks (after migration 0003) |
|---|---|---|
| `purchases` | One row per Google purchase token: owner, product, state, expiry, order id, acknowledged flag, `last_verified_at`, raw store answer | `(store, purchase_token)` unique; `state` CHECK; indexes on `(store, order_id)` and `linked_purchase_token` |
| `subscriptions` | The plan period a purchase grants | `(source, provider_subscription_id)` unique where not null; `status` CHECK |
| `entitlements` | One grant per feature of the plan | `(source_subscription_id, feature_key)` unique where not null; `status` CHECK |
| `entitlement_audit` | One row per real change of grants (grant, plan change, expire, revoke) | none (append only) |
| `billing_notifications` | One row per Pub/Sub message | `(store, message_id)` unique; `status` CHECK |
| `security_events` | Verification, restore, token reuse, account mismatch | none; metadata never contains tokens |

## Flows

### Purchase verification

```
App ── POST verify {productId, token} ──► API
  1. product known?                                  no → 400
  2. token already owned by another user?            yes → 409 (security event)
  3. fetchedAt = now; ask Google (subscriptionsv2)   404/410 → 400, other error → 503
  4. product matches, answer complete?               no → 400 / 503 (nothing written)
  5. obfuscatedAccountId matches this user?          no → 403 (security event)
  6. applyState (one transaction, see below)
  7. acknowledge with Google if it grants access and is not yet acknowledged
  8. 200 with the stored state and the current plan
```

The client's claim that a purchase succeeded is never used. Steps 3 to 5 happen before anything is written, so an unverified purchase is never stored, granted or acknowledged.

### applyState: the single writer

One Postgres transaction:

1. `pg_advisory_xact_lock(hash("purchase:" + token))`: every writer for this token waits here. The lock is transaction-scoped, so it is released on commit, rollback or a lost connection, and it works through Neon's transaction pooler.
2. Read the stored purchase. Refuse if another user owns it.
3. **Monotonic:** if the stored `last_verified_at` is newer than this answer's `fetchedAt`, the answer is stale and nothing is written. A refund (`revoked`) is the exception: it is always applied.
4. **Terminal:** a stored `revoked` stays `revoked`.
5. **Superseded:** if a granted replacement purchase names this token in `linkedPurchaseToken`, the token stays `expired`.
6. Compute `accessUntil(state, expiry)`.
7. Upsert the purchase; `last_verified_at = greatest(old, fetchedAt)`; `acknowledged = old OR new`.
8. If this is a replacement that grants access, end the purchase it replaces (same user only).
9. Create the subscription and grants (`ON CONFLICT DO NOTHING` against the unique indexes), or update them only where they differ (`IS DISTINCT FROM`). Write an audit row only when grants changed.
10. Commit, then clear the user's entitlement cache.

### Notifications (RTDN)

1. Authenticate (shared token), parse, check the package name.
2. Insert the message into `billing_notifications`. A message already `processed` or `ignored` returns `duplicate`.
3. Unknown token: `ignored` (the app verifies it itself).
4. The notification is only a hint: the service re-reads Google and calls `applyState`. `SUBSCRIPTION_REVOKED`, or a voided purchase whose order id is the purchase's current order, forces `revoked`.
5. On failure the row is `failed` and the response is 503, so Pub/Sub redelivers.

### Reconciliation

Daily. It re-reads purchases that are still live and are stale (not verified for 12 h), near expiry (under 1 day) or unacknowledged, oldest first, up to 500 a run. Each purchase is its own transaction; a failure is counted and the run continues.

## Trust boundaries

| Boundary | Trusted? | Control |
|---|---|---|
| App → API | No | Clerk JWT; user id only from the token; body schema; rate limits; every fact re-read from Google |
| Google Pub/Sub → API | Authenticated by shared token | Constant-time compare; package check; message-id dedupe; content re-read from Google |
| API → Google | Trusted source of truth | Service-account JWT; responses validated (`assertStoreResponse`) |
| Redis | Cache only | No billing decision or lock depends on Redis; a stale cache is bounded by a 60 s TTL |
| Postgres | Source of truth | Transactions, advisory locks, unique indexes, CHECK constraints |

## Sensitive data

| Data | Stored | Logged |
|---|---|---|
| Purchase token | `purchases.purchase_token`, `billing_notifications.purchase_token` | Never. Logs use the purchase row id |
| Google service-account key | Environment only | Never |
| RTDN shared token | Environment only | Never (it is in the push URL, so see R-7) |
| Raw store answer | `purchases.raw` | Never |
