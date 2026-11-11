#!/bin/sh
# Netlify build: backend (API + workers, compiled for the functions) and frontend (static auth tester).
# Uses npx-pinned pnpm so nothing is installed globally; --prod=false because NODE_ENV=production is set.
set -eu
PNPM="npx -y pnpm@10.32.1"
$PNPM --dir backend install --frozen-lockfile --prod=false
$PNPM --dir backend build
$PNPM --dir frontend install --frozen-lockfile --prod=false
$PNPM --dir frontend build
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  (cd backend && node dist/db/migrate.js && node dist/db/seed/index.js)
fi
