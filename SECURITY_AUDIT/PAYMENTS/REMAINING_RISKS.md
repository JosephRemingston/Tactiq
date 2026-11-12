# Remaining payment risks

All tests passing does **not** make the payment system proven secure. The items below rest on unverified Google Play behaviour, on infrastructure not yet deployed, or on accepted trade-offs. Each names the action that would close it.

## Unverified Google Play behaviour

All Google behaviour here was modelled with the fake verifier and mocked HTTP. None of it was checked against Google.

| ID | Assumption | If wrong | Action |
|---|---|---|---|
| PR-1 | During `IN_GRACE_PERIOD`, the user is entitled. The server keeps access until the later of `expiryTime` and the next UTC midnight + 3 days, refreshed by notifications and reconciliation | If Google's `expiryTime` already covers grace, no harm. If the notifications and the daily job both stop, a user whose payment never recovers keeps Pro at most about 4 days past the last read | Licence-tester purchase with a declining test card; watch `expiryTime` and the notifications through grace → on hold |
| PR-2 | A refunded (revoked) token never becomes active again; a new purchase gets a new token | A legitimately re-activated token would stay Free (fails closed) and need support | Confirm with a test refund in Play Console; document the support path (grant with `cli.js entitlements:grant`) |
| PR-3 | For upgrades and downgrades, `linkedPurchaseToken` names the replaced token. With deferred replacement, the new purchase grants access only when it starts | With deferred mode, the old plan could end slightly early or late | Test each replacement mode the app will use (with and without proration) |
| PR-4 | A voided-purchase notification for the current period carries the same order id that `subscriptionsv2` reports as `latestOrderId` | A refund of the current period might not be recognised as current. The re-read from Google still applies whatever state Google reports | Refund a renewed licence-tester subscription and compare the order ids |
| PR-5 | Acknowledging twice is harmless, and `acknowledgementState` is reported reliably | A failed duplicate acknowledgement is logged and retried; no access impact | Observe in sandbox |
| PR-6 | The real `GooglePlayVerifier` matches the mocked HTTP used in the tests | Verification could fail (fails closed, 503) | Same as the earlier audit's R-13: sandbox purchases before release |

## Infrastructure and deployment

| ID | Risk | Action |
|---|---|---|
| PR-7 | **Migration `0003_payment_integrity.sql` is not applied to production Neon.** Until it is, the unique indexes and CHECK constraints do not exist there; the advisory lock and code checks still apply | Run `npx drizzle-kit migrate` against Neon (production has 0 purchases, so it applies cleanly; check `select provider_subscription_id, count(*) from subscriptions where provider_subscription_id is not null group by 1 having count(*) > 1` first) |
| PR-8 | Advisory locks were tested on local Postgres 17, not through Neon's pooler. Transaction-scoped locks are compatible with transaction pooling by design | Run `tests/payments.test.js` once against a Neon branch |
| PR-9 | `fetchedAt` uses each serverless instance's clock. Clock skew larger than the gap between two reads could discard a newer non-refund answer as stale. The next read corrects it; refunds are never discarded | Accept (instance clocks are NTP-synced), or move to a database-issued sequence |
| PR-10 | Notifications are authenticated by a shared token in the push URL (earlier audit R-7) | Switch Pub/Sub push to OIDC and verify Google-signed JWTs |
| PR-11 | Without the `obfuscatedAccountId`, the first account to verify a token owns it (earlier audit R-4) | Make the app always set it, then require it in production |
| PR-12 | Reconciliation runs once a day and handles 500 purchases a run (oldest first) | Raise the batch size or run frequency when active subscriptions approach 500 a day |

## Accepted trade-offs

| ID | Risk | Bound |
|---|---|---|
| PR-13 | Cached grants can outlive a refund or expiry (FINDINGS P-11) | At most 60 s; the plan itself is correct at once |
| PR-14 | Advisory lock keys are 64-bit hashes; two tokens could share a key | Extra waiting only, never wrong results |
| PR-15 | A deleted account's active subscription stays bound to it (earlier audit R-5) | Needs a support policy |

## What was not done

- No real purchase, refund, acknowledgement or Google API call. All of them were simulated.
- No test against production or staging infrastructure.
- No real SIGKILL during the verify route (see TEST_COVERAGE gaps).
