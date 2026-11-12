#!/usr/bin/env bash
# Pushes Touchline's runtime configuration to the linked Netlify site without printing any value.
#
#   scripts/netlify-env-push.sh https://your-domain.com [--dry-run]
#   scripts/netlify-env-push.sh https://your-domain.com --export   # writes .env.netlify for "Import from a .env file"
#
# Reads backend/.env first, then the repo-root .env.local (written by `neon env pull`); the last occurrence of a
# key in a file wins. Neon's AWS_* storage names are renamed to S3_* because AWS Lambda reserves AWS_* names.
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN="${1:-}"
DRY_RUN="${2:-}"
[ -z "$ORIGIN" ] && { echo "usage: $0 https://your-domain.com [--dry-run]"; exit 2; }
NETLIFY="npx -y netlify-cli@27.17.0"
CONTEXTS="production deploy-preview branch-deploy"

get() {
  local key=$1 f v
  for f in backend/.env .env.local; do
    [ -f "$f" ] || continue
    v=$(grep -E "^${key}=" "$f" | tail -1 | cut -d= -f2- || true)
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  return 1
}

EXPORT_FILE=.env.netlify
[ "$DRY_RUN" = "--export" ] && : > "$EXPORT_FILE" && chmod 600 "$EXPORT_FILE"

put() { # key value scopes secret(yes/no)
  local key=$1 val=$2 scopes=$3 secret=$4
  if [ -z "$val" ]; then echo "skip  $key (empty)"; return; fi
  if [ "$DRY_RUN" = "--export" ]; then printf '%s=%s\n' "$key" "$val" >> "$EXPORT_FILE"; echo "wrote $key"; return; fi
  if [ "$DRY_RUN" = "--dry-run" ]; then echo "would set $key [$scopes]$([ "$secret" = yes ] && echo ' secret') (${#val} chars)"; return; fi
  # shellcheck disable=SC2086
  $NETLIFY env:set "$key" "$val" --context $CONTEXTS --scope $scopes $([ "$secret" = yes ] && echo --secret) --force >/dev/null
  echo "set   $key [$scopes]$([ "$secret" = yes ] && echo ' secret')"
}

SK=$(get CLERK_SECRET_KEY || true)
PK=$(get CLERK_PUBLISHABLE_KEY || true)
case "$SK" in sk_*) ;; *) echo "CLERK_SECRET_KEY must start with sk_ (swapped with the publishable key?)"; exit 1 ;; esac
case "$PK" in pk_*) ;; *) echo "CLERK_PUBLISHABLE_KEY must start with pk_"; exit 1 ;; esac
case "$PK" in pk_test_*) echo "warning: deploying the Clerk development instance (pk_test_)";; esac

REDIS=$(get REDIS_URL || true)
case "$REDIS" in redis://*upstash.io*) REDIS="rediss://${REDIS#redis://}";; esac

put NODE_ENV production "functions" no
put RUN_MIGRATIONS true "builds" no
put DATABASE_URL "$(get DATABASE_URL || true)" "builds functions" yes
put REDIS_URL "$REDIS" "functions" yes
put STORAGE_DRIVER neon "functions" no
put S3_BUCKET_RAW "$(get S3_BUCKET_RAW || echo tactiq)" "functions" no
put S3_ENDPOINT "$(get S3_ENDPOINT || get AWS_ENDPOINT_URL_S3 || true)" "functions" no
put S3_ACCESS_KEY_ID "$(get S3_ACCESS_KEY_ID || get AWS_ACCESS_KEY_ID || true)" "functions" yes
put S3_SECRET_ACCESS_KEY "$(get S3_SECRET_ACCESS_KEY || get AWS_SECRET_ACCESS_KEY || true)" "functions" yes
put S3_REGION_OVERRIDE "$(get S3_REGION_OVERRIDE || get AWS_REGION || true)" "functions" no
put CLERK_SECRET_KEY "$SK" "functions" yes
put CLERK_PUBLISHABLE_KEY "$PK" "functions" no
put VITE_CLERK_PUBLISHABLE_KEY "$PK" "builds" no
put CLERK_JWT_KEY "$(get CLERK_JWT_KEY || true)" "functions" no
put CLERK_WEBHOOK_SIGNING_SECRET "$(get CLERK_WEBHOOK_SIGNING_SECRET || true)" "functions" yes
put CLERK_AUTHORIZED_PARTIES "$ORIGIN" "functions" no
put WORKER_TRIGGER_SECRET "$(openssl rand -hex 32)" "functions" yes
put STATSBOMB_SOURCE github "functions" no
[ "$DRY_RUN" = "--export" ] && { echo "wrote $EXPORT_FILE (git-ignored). Import it in Netlify, then delete it."; exit 0; }
echo "done. Deploy with: $NETLIFY deploy --build --prod   (or push to the connected branch)"
