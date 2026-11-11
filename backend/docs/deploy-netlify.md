# Deploying to Netlify (frontend + backend in one site)

`netlify.toml` at the repository root builds and deploys both parts:

| Part | Where it runs | Routes |
|---|---|---|
| `frontend/` Clerk auth tester (Vite) | Netlify CDN (`frontend/dist`) | `/` and any other path (SPA fallback) |
| `backend/` NestJS API | Function `netlify/functions/api.js` | `/v1/*`, `/healthz`, `/readyz` (same origin, no CORS) |
| BullMQ workers | Background function `worker-background` (up to 15 min per run) | woken by the API after enqueueing, and every 10 min by `worker-tick` |

The build runs `scripts/netlify-build.sh`: install and build `backend`, install and build `frontend`, and, when
`RUN_MIGRATIONS=true`, apply database migrations and seed reference data.

## Environment variables (Site configuration > Environment variables)

Values in `netlify.toml` only reach the build. Everything the functions read must be set in the Netlify UI or CLI.

| Variable | Scope | Value |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Builds | Clerk **publishable** key (`pk_live_...`). The build refuses anything that is not `pk_...` |
| `RUN_MIGRATIONS` | Builds | `true` to migrate and seed during the build (also needs `DATABASE_URL` in Builds scope) |
| `NODE_ENV` | Functions | `production` |
| `DATABASE_URL` | Builds, Functions | Neon connection string |
| `REDIS_URL` | Functions | Upstash URL with `rediss://` |
| `STORAGE_DRIVER` | Functions | `neon` |
| `S3_BUCKET_RAW` | Functions | `tactiq` (your Neon bucket) |
| `S3_ENDPOINT` | Functions | the `AWS_ENDPOINT_URL_S3` value from `neon env pull` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Functions | the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` values from `neon env pull` |
| `S3_REGION_OVERRIDE` | Functions | the `AWS_REGION` value from `neon env pull` (`ap-southeast-1`) |
| `CLERK_SECRET_KEY` | Functions | `sk_live_...` |
| `CLERK_PUBLISHABLE_KEY` | Functions | `pk_live_...` |
| `CLERK_JWT_KEY` | Functions | production JWT public key (PEM); optional, avoids a JWKS fetch on cold starts |
| `CLERK_AUTHORIZED_PARTIES` | Functions | your site origin(s), e.g. `https://touchline.example.com` |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Functions | from the Clerk webhook pointing at `https://<site>/v1/webhooks/clerk` |
| `WORKER_TRIGGER_SECRET` | Functions | any long random string; protects the background worker endpoint |
| `STATSBOMB_SOURCE` | Functions | `github` |

Why `S3_*` instead of the `AWS_*` names that `neon env pull` writes: Netlify Functions run on AWS Lambda, which
reserves `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` for the function's own credentials. Inside
Lambda the backend ignores those names and reports a clear error if the `S3_*` values are missing. Locally the
`AWS_*` names keep working.

## Clerk production domain

A Clerk production instance only works on the domain configured in Clerk (its Frontend API lives at
`clerk.<your-domain>`). Add that custom domain to the Netlify site; `*.netlify.app` URLs and `localhost` will not load
the production sign-in. Local testing uses the development instance (`frontend/.env.local` holds its `pk_test_` key).

## Deploy

```bash
npx netlify-cli@27 login
npx netlify-cli@27 init                          # create or link the site
npx netlify-cli@27 env:set NODE_ENV production   # ...and the other variables above
npx netlify-cli@27 deploy --build --prod
```

The Homebrew `netlify` 22.x on this machine crashes on Node 26; use `npx netlify-cli@27` or upgrade it.

## Test locally the way Netlify serves it

```bash
cd backend && docker compose up -d && set -a && . ./.env.docker && set +a && cd ..
npx netlify-cli@27 build --offline     # same build and function bundling as production
npx netlify-cli@27 dev --offline       # http://localhost:8888: static site + functions + redirects
cd frontend && pnpm test:e2e           # Playwright smoke tests (BASE_URL=https://<site> for a deployed site)
```

After deploying, open the site, sign in (Google or email code) and press **Run all checks**. Every row should pass,
including the two expected 401s.

## Serverless limits to keep in mind

- API function: warm requests take milliseconds; a cold start adds the Nest bootstrap.
- Background worker: one run drains the queues until idle or `WORKER_DRAIN_BUDGET_MS` (13 min). A large backfill
  (a whole season from GitHub) may take several runs; `worker-tick` continues it every 10 minutes.
- Each worker run opens Redis connections and polls while active, which counts against an Upstash command quota.
