#!/usr/bin/env bash
# check-db-triggers.sh — verify that the DB protection triggers introduced
# in migrations 0071–0074 are present in the Supabase production database.
#
# Called by scripts/pre-release-check.sh as the "db-triggers" check.
#
# Environment variables:
#   SUPABASE_ACCESS_TOKEN  — Supabase personal access token (Management API).
#                            Generate one at:
#                            https://supabase.com/dashboard/account/tokens
#
# The Supabase project ref is extracted automatically from SUPABASE_URL in
# artifacts/api-server/.env — no extra configuration is needed.
#
# Exit codes:
#   0  all three triggers are confirmed live
#   1  one or more triggers are missing, credentials are absent, or the API
#      call failed

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# ── load SUPABASE_URL from the API server .env ───────────────────────────────
ENV_FILE="artifacts/api-server/.env"
SUPABASE_URL=""
if [[ -f "$ENV_FILE" ]]; then
  SUPABASE_URL=$(grep -E "^SUPABASE_URL=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
if [[ -z "$SUPABASE_URL" ]]; then
  printf "  ✘  SUPABASE_URL not found in %s\n" "$ENV_FILE"
  printf "     Add SUPABASE_URL=https://<project-ref>.supabase.co to %s\n" "$ENV_FILE"
  exit 1
fi

# ── extract project ref from URL ─────────────────────────────────────────────
PROJECT_REF=$(printf "%s" "$SUPABASE_URL" | sed -E "s|https://([^.]+)\\.supabase\\.co.*|\\1|")
if [[ -z "$PROJECT_REF" || "$PROJECT_REF" == "$SUPABASE_URL" ]]; then
  printf "  ✘  Could not extract project ref from SUPABASE_URL: %s\n" "$SUPABASE_URL"
  exit 1
fi

# ── require SUPABASE_ACCESS_TOKEN ─────────────────────────────────────────────
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  printf "  ✘  SUPABASE_ACCESS_TOKEN is not set.\n"
  printf "     This token is required to query the Supabase Management API.\n"
  printf "     Generate one at: https://supabase.com/dashboard/account/tokens\n"
  printf "     Then export it:  export SUPABASE_ACCESS_TOKEN=sbp_...\n"
  exit 1
fi

# ── query Management API for all required triggers ────────────────────────────
# information_schema.triggers is always accessible via the Management API
# regardless of PostgREST schema exposure settings.
SQL="SELECT trigger_name, event_object_table \
FROM information_schema.triggers \
WHERE trigger_schema = 'public' \
  AND trigger_name IN (\
'enforce_default_collection_no_delete',\
'block_collections_truncate',\
'block_collection_items_truncate',\
'block_saved_places_truncate'\
)"

API_URL="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${SQL}\"}")

HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)

if [[ "$HTTP_CODE" != "200" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s\n" "$HTTP_CODE"
  printf "     Response: %s\n" "$HTTP_BODY"
  printf "     Verify SUPABASE_ACCESS_TOKEN is valid and has access to project %s.\n" "$PROJECT_REF"
  exit 1
fi

# ── parse response and verify all triggers are present ───────────────────────
TRIGGER_RESPONSE="$HTTP_BODY" node scripts/src/verify-db-triggers.mjs
