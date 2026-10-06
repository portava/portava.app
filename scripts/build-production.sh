#!/usr/bin/env bash
# Production build script — runs inside the Replit deployment build step.
# Invoked from the api-server artifact's [services.production.build] command.
# Both steps must succeed; a failure in either aborts the deploy.
set -e

# [0/2] A beta build can never bake in production (PORTAVA_DEPLOYMENT_ENV=beta
# requires portava-beta's SUPABASE_URL and EXPO_PUBLIC_SUPABASE_URL). With the
# variable unset — production today — it changes nothing. See the script.
bash "$(dirname "$0")/deployment-env-guard.sh"

echo "[1/2] Building API server (@workspace/api-server)..."
pnpm --filter @workspace/api-server run build

echo "[2/2] Building frontend (travel-buddy-standalone)..."
node travel-buddy-standalone/scripts/build.js

echo "Production build complete."
