# TODO

Open items from the security audit (`SECURITY_AUDIT/REMAINING_RISKS.md`, R-*) and the payment audit (`SECURITY_AUDIT/PAYMENTS/REMAINING_RISKS.md`, PR-*). Where both audits name the same item, it appears once with both ids.

## Now

- [ ] Commit and push the payment audit: billing service, migration 0003, tests, `SECURITY_AUDIT/PAYMENTS/`, `docs/API.md`.
- [ ] Apply migration `0003_payment_integrity.sql` to production Neon (PR-7). First check for duplicates:
      `select provider_subscription_id, count(*) from subscriptions where provider_subscription_id is not null group by 1 having count(*) > 1`
      then run `npx drizzle-kit migrate`.

## Before the first deploy

- [ ] Set the Netlify env vars and attach `tactiq.josephremingston.dev`.
- [ ] Add the GitHub Actions secrets for `worker.js`.
- [ ] Set the real `CLERK_AUTHORIZED_PARTIES` and `CLERK_WEBHOOK_SIGNING_SECRET` (R-10).
- [ ] In the Neon console, confirm the storage bucket is private and its key is scoped to that bucket only; rotate the key if it was ever shared (R-9).
- [ ] Keep the local `.env` out of shared folders; rotate the keys if the machine is lost (R-17).

## After the first deploy (staging)

- [ ] Send requests with a forged `x-nf-client-connection-ip` and confirm they still share one rate-limit budget. If they don't, put Cloudflare in front (R-1).
- [ ] Run the OWASP ZAP baseline against the deployed URL (R-11).
- [ ] Run `tests/payments.test.js` once against a Neon branch, to check the advisory locks through Neon's pooler (PR-8).

## Google Play (once the app is in Play Console, licence-tester purchases only)

- [ ] Add `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` and `GOOGLE_PLAY_RTDN_TOKEN`.
- [ ] Test the real verifier through every state: active, cancelled, grace, on hold, paused, expired, revoked (R-13, PR-6).
- [ ] Grace period: use a declining test card and watch `expiryTime` and the notifications through grace → on hold (PR-1).
- [ ] Refund: confirm a refunded token never becomes active again, and decide the support path if one does (PR-2).
- [ ] Upgrade and downgrade: test each replacement mode the app will use, including deferred (PR-3).
- [ ] Refund a renewed subscription and compare the voided order id with `latestOrderId` (PR-4).
- [ ] Watch how Google answers a second acknowledgement and how it reports `acknowledgementState` (PR-5).
- [ ] Switch the Pub/Sub push subscription to OIDC and verify Google-signed JWTs (R-7, PR-10).
- [ ] Make the app always set `obfuscatedAccountId`, then require it in production (R-4, PR-11).
- [ ] Create the AdMob ad units and set `ADMOB_NATIVE_UNIT_ID` and `ADMOB_BANNER_UNIT_ID`.

## Product and legal decisions

- [ ] Retention policy (deleted notes, `security_events`, `billing_notifications`, `purchases.raw`, raw provider files), then a daily purge job (R-6).
- [ ] Support policy: may a new account take over a subscription still bound to a *deleted* account? (R-5, PR-15)
- [ ] Caps on notes, collections and collection items, added to `plans.json` (R-8).
- [ ] StatsBomb Open Data is not licensed for commercial use: contract a commercial provider before launch, and review whether `include=raw` may be shown (R-16).

## Later / scaling

- [ ] Raise the reconciliation batch size or run frequency when active subscriptions approach 500 (PR-12).
- [ ] Optional: Cloudflare WAF rate limits for distributed attacks while Upstash is down (R-2).
- [ ] Optional: call Clerk's session API for sensitive actions such as account deletion and purchases (R-3).
- [ ] Add `users.status = 'active'` checks to private inserts, or purge rows left on deleted accounts (R-15).
- [ ] Re-check the `drizzle-kit` → esbuild dev advisories when a non-breaking release lands (R-14).

## Test gaps (nice to have)

- [x] Raise branch coverage to 90% on `entitlements.service`, `personal.service`, `jobs.service`, `asyncHandler`, `runner`, `clerk.js` (R-12). All now 91.7–97.7%.
- [x] Test the real verifier's selection from environment variables, including that production never uses the fake.
- [x] A test that SIGKILLs a process in the middle of a purchase transaction.
- [ ] Optional: tests against a dedicated Upstash database.

## Accepted (no action unless the situation changes)

- Cached grants can outlive a refund by up to 60 s; the plan shown to the user is correct immediately (PR-13).
- App-clock skew between serverless instances can make a newer read look stale; the next read corrects it, and refunds are never discarded (PR-9).
- Advisory lock keys can collide (64-bit hash): this only causes extra waiting, never wrong results (PR-14).
