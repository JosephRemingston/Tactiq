# Operations runbook

## Processes

- API: `node dist/main.js` (port `API_PORT`). Liveness `/healthz`, readiness `/readyz` (database, Redis, storage).
- Worker: `node dist/worker.js`, serving the queues in `WORKER_QUEUES`. On start it re-adds jobs that Postgres
  still lists as pending but Redis has lost.

## Jobs

Every job has a deterministic id, so re-enqueueing the same work is a no-op. State lives in `ingestion_jobs`.

```bash
pnpm cli jobs:status --trace <traceId>
pnpm cli jobs:replay --job-id <jobId> --inline     # one job
pnpm cli jobs:replay --dead-since 24               # every dead job from the last 24 h
```

Failed jobs retry with exponential backoff and jitter (`QUEUE_BACKOFF_BASE_MS`, capped at 30 min) up to
`QUEUE_MAX_ATTEMPTS`, then become `dead`. Provider schema drift is a permanent error and goes straight to `dead`.

## Re-analysis

Bump `ANALYTICS_VERSION` in `src/lib/analytics/version.ts` when calculator output changes; new analysis jobs get new
ids and replace the stored metrics atomically. Users can request analysis with `POST /v1/matches/:id/analysis-jobs`.

## Entitlements

```bash
pnpm cli entitlements:grant --user someone@example.com --plan pro_monthly --until 2027-01-01
pnpm cli entitlements:revoke --user someone@example.com --plan pro_monthly
pnpm cli entitlements:expire     # daily: mark grants past valid_until as expired
```

Grants are append-only and audited in `entitlement_audit`. Usage counts once per (user, feature, month, subject).

## Data licence

StatsBomb Open Data is for development and validation only. `match_coverage.licence_id` and
`data_licences.commercial_use_allowed` let a production deployment exclude it once a licensed feed is connected.
