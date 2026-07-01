#!/usr/bin/env bash
# check-db-triggers.sh — verify that the DB protection triggers introduced
# in migrations 0071–0074 are present in the Supabase production database.
#
# Called by scripts/pre-release-check.sh as the "db-triggers" check.
#
# Environment variables (checked in order — first one present wins):
#
#   SUPABASE_PROJECT_TOKEN — Project-scoped Supabase API token (preferred for
#                            CI).  Create one in the Supabase dashboard under
#                            Project Settings → API → Project API tokens, then
#                            store it as a repo secret (e.g. SUPABASE_PROJECT_TOKEN
#                            in GitHub Actions secrets).  Scope it to "read"
#                            access — this check never writes to the project.
#                            See docs/eas-runbook.md → "DB triggers check in CI"
#                            for full setup instructions.
#
#   SUPABASE_ACCESS_TOKEN  — Personal access token (Management API).  Suitable
#                            for local developer runs.  Not recommended for CI
#                            because it is tied to an individual account and must
#                            be rotated whenever the developer changes.
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

# ── resolve the Management API bearer token ───────────────────────────────────
# Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the personal
# SUPABASE_ACCESS_TOKEN so that CI runners never need a developer account token.
MGMT_TOKEN=""
TOKEN_SOURCE=""

if [[ -n "${SUPABASE_PROJECT_TOKEN:-}" ]]; then
  MGMT_TOKEN="$SUPABASE_PROJECT_TOKEN"
  TOKEN_SOURCE="SUPABASE_PROJECT_TOKEN"
elif [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  MGMT_TOKEN="$SUPABASE_ACCESS_TOKEN"
  TOKEN_SOURCE="SUPABASE_ACCESS_TOKEN"
else
  printf "  ✘  No Supabase token found.\n"
  printf "\n"
  printf "     For CI / GitHub Actions (recommended):\n"
  printf "       Set SUPABASE_PROJECT_TOKEN as a repository secret.\n"
  printf "       Create the token in Supabase dashboard →\n"
  printf "         Project Settings → API → Project API tokens\n"
  printf "       Scope: read-only.  Store as: SUPABASE_PROJECT_TOKEN\n"
  printf "       See docs/eas-runbook.md → \"DB triggers check in CI\" for details.\n"
  printf "\n"
  printf "     For local runs:\n"
  printf "       export SUPABASE_ACCESS_TOKEN=sbp_...\n"
  printf "       Generate at: https://supabase.com/dashboard/account/tokens\n"
  exit 1
fi

printf "  ℹ  Using %s for Supabase Management API\n" "$TOKEN_SOURCE"

# ── query Management API for all required triggers ────────────────────────────
# Use pg_trigger + pg_class directly — information_schema.triggers only surfaces
# triggers the calling role owns, so it can miss triggers created by other roles
# (e.g. postgres) when queried as the anon/service role via the Management API.
SQL="SELECT t.tgname AS trigger_name, c.relname AS event_object_table \
FROM pg_trigger t \
JOIN pg_class c ON c.oid = t.tgrelid \
WHERE t.tgname IN (\
'enforce_default_collection_no_delete',\
'block_collections_truncate',\
'block_collection_items_truncate',\
'block_saved_places_truncate'\
)"

API_URL="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${SQL}\"}")

HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)

# The Supabase Management API returns 200 or 201 for successful queries.
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s\n" "$HTTP_CODE"
  printf "     Response: %s\n" "$HTTP_BODY"
  printf "     Verify %s is valid and has access to project %s.\n" "$TOKEN_SOURCE" "$PROJECT_REF"
  exit 1
fi

# ── parse response and verify all triggers are present ───────────────────────
TRIGGER_RESPONSE="$HTTP_BODY" node scripts/src/verify-db-triggers.mjs
