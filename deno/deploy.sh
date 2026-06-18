#!/usr/bin/env bash
# Redeploy the Deno backend to the NEW Deno Deploy via the `deno deploy` CLI (built into the Deno
# runtime). The app was first created by the GitHub Actions workflow (.github/workflows/deploy-deno.yml);
# this script re-deploys the current deno/main.ts to it.
#
# IMPORTANT: this uses LOCAL source (uploads only this deno/ directory) — it does NOT use Deno's
# GitHub auto-deploy integration, so the `main` branch is NEVER built or deployed. It targets the
# app's *.deno.net URL, which is isolated from the real production site (GitHub Pages + Supabase).
#
# NOTE: `deno deploy` is the NEW Deno Deploy CLI. `deployctl` is for Deno Deploy CLASSIC and will
# reject a new-Deploy token ("bearer token is invalid"). Org sw-igin is on the NEW Deploy.
#
# Requires a NEW Deno Deploy access token (console.deno.com → org → Settings → Access Tokens):
#   export DENO_DEPLOY_TOKEN=<token>
# Optional overrides: DENO_APP (default biot-dashboard-staging), DENO_ORG (default sw-igin),
#   BIOT_BASE_URL (default the dev BIOT host).
#
# Usage:  DENO_DEPLOY_TOKEN=… bash deno/deploy.sh
set -euo pipefail

: "${DENO_DEPLOY_TOKEN:?Set DENO_DEPLOY_TOKEN — create one at https://console.deno.com (org → Settings → Access Tokens)}"
APP="${DENO_APP:-biot-dashboard-staging}"
ORG="${DENO_ORG:-sw-igin}"
BIOT_BASE_URL="${BIOT_BASE_URL:-https://api.dev.igin.biot-med.com}"

cd "$(dirname "$0")"   # run from deno/ so only this dir is uploaded (main.ts is self-contained)

# Ensure the runtime env var is present (idempotent; ignore "already exists").
deno deploy env add --token "$DENO_DEPLOY_TOKEN" --org "$ORG" --app "$APP" \
  BIOT_BASE_URL "$BIOT_BASE_URL" 2>/dev/null || true

echo "Deploying app='$APP' org='$ORG' entrypoint=main.ts (local source — main never deployed)"
deno deploy --prod \
  --token "$DENO_DEPLOY_TOKEN" \
  --org "$ORG" --app "$APP" \
  .
# A first-ever app must be created instead: see .github/workflows/deploy-deno.yml, or run
#   deno deploy create --org "$ORG" --app "$APP" --source local --region us --entrypoint main.ts deno
