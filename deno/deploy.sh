#!/usr/bin/env bash
# Deploy the Deno backend to Deno Deploy via deployctl.
#
# SAFETY: this uploads ONLY this `deno/` directory's files (main.ts is self-contained) from the
# branch you run it on (migration/deno-runtime). It does NOT use Deno's GitHub auto-deploy
# integration, so the `main` branch is NEVER built or deployed by this path. It publishes a
# `*.deno.dev` URL that is fully isolated from the real production site (GitHub Pages + Supabase).
#
# Requires a Deno Deploy access token (Deno dashboard → Account → Settings → Access Tokens).
#   export DENO_DEPLOY_TOKEN=<token>
# Optional overrides: DENO_PROJECT (default biot-dashboard-staging), DENO_ORG (default sw-igin),
#   BIOT_BASE_URL (default the dev BIOT host).
#
# Usage:  DENO_DEPLOY_TOKEN=… bash deno/deploy.sh
set -euo pipefail

: "${DENO_DEPLOY_TOKEN:?Set DENO_DEPLOY_TOKEN — create one at https://dash.deno.com (Account → Settings → Access Tokens)}"
PROJECT="${DENO_PROJECT:-biot-dashboard-staging}"
ORG="${DENO_ORG:-sw-igin}"
BIOT_BASE_URL="${BIOT_BASE_URL:-https://api.dev.igin.biot-med.com}"

cd "$(dirname "$0")"   # run from deno/ so only this dir is uploaded

echo "Deploying project='$PROJECT' org='$ORG' entrypoint=main.ts (BIOT_BASE_URL set as env)"
deployctl deploy \
  --project="$PROJECT" \
  --org="$ORG" \
  --entrypoint=main.ts \
  --include=. \
  --env=BIOT_BASE_URL="$BIOT_BASE_URL" \
  --prod \
  --token="$DENO_DEPLOY_TOKEN"
