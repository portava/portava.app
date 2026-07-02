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
# ── Testing / local-PostgreSQL mode ──────────────────────────────────────────
#
#   TRIGGER_QUERY_MODE=psql — Skip the Supabase Management API entirely and
#                             query a local PostgreSQL instance via psql.
#                             Requires TRIGGER_PSQL_URL to be set.
#
#   TRIGGER_PSQL_URL        — libpq connection string for the test database,
#                             e.g. "postgresql://postgres@helium:5432/heliumdb".
#                             Used only when TRIGGER_QUERY_MODE=psql.
#
# Exit codes:
#   0  all three triggers are confirmed live
#   1  one or more triggers are missing, credentials are absent, or the API
#      call failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Allow tests to redirect the workspace root without touching the real repo.
# Set CHECK_TRIGGERS_WORKSPACE_ROOT to a temp directory in tests; leave unset
# in production. Mirrors the SYNC_STANDALONE_REPO_ROOT pattern in
# scripts/sync-standalone.sh.
if [[ -n "${CHECK_TRIGGERS_WORKSPACE_ROOT:-}" ]]; then
  WORKSPACE_ROOT="$CHECK_TRIGGERS_WORKSPACE_ROOT"
fi

cd "$WORKSPACE_ROOT"

# ── shared SQL ───────────────────────────────────────────────────────────────
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

# ── schema-presence SQL (migration 0076) ─────────────────────────────────────
# Checks that profile_emergency_contacts exists, has RLS enabled, and carries
# the two expected policies (pec_own, pec_svc).  Uses UNION ALL so a single
# query returns both the table row and any policy rows.
SCHEMA_SQL="SELECT 'table' AS check_type, relname AS name, relrowsecurity::text AS detail \
FROM pg_class \
WHERE relname = 'profile_emergency_contacts' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
UNION ALL \
SELECT 'policy' AS check_type, policyname AS name, cmd AS detail \
FROM pg_policies \
WHERE tablename = 'profile_emergency_contacts' AND schemaname = 'public'"

# ── local psql mode (testing / CI with direct DB access) ─────────────────────
if [[ "${TRIGGER_QUERY_MODE:-api}" == "psql" ]]; then
  PSQL_URL="${TRIGGER_PSQL_URL:-}"
  if [[ -z "$PSQL_URL" ]]; then
    printf "  ✘  TRIGGER_PSQL_URL is required when TRIGGER_QUERY_MODE=psql\n"
    printf "     Example: postgresql://postgres@helium:5432/heliumdb\n"
    exit 1
  fi

  printf "  ℹ  Using psql (TRIGGER_QUERY_MODE=psql) for trigger check\n"

  JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${SQL}) q"

  TRIGGER_JSON=$(psql "$PSQL_URL" -t -A -c "$JSON_SQL" 2>&1)
  PSQL_EXIT=$?

  if [[ $PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql query failed (exit %d):\n" "$PSQL_EXIT"
    printf "     %s\n" "$TRIGGER_JSON"
    exit 1
  fi

  TRIGGER_RESPONSE="$TRIGGER_JSON" node "${SCRIPT_DIR}/src/verify-db-triggers.mjs"
  TRIGGER_EXIT=$?

  # ── Schema-presence check (psql) ───────────────────────────────────────────
  printf "  ℹ  Checking profile_emergency_contacts schema (psql)\n"
  SCHEMA_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${SCHEMA_SQL}) q"
  SCHEMA_JSON=$(psql "$PSQL_URL" -t -A -c "$SCHEMA_JSON_SQL" 2>&1)
  SCHEMA_PSQL_EXIT=$?
  if [[ $SCHEMA_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql schema query failed (exit %d):\n" "$SCHEMA_PSQL_EXIT"
    printf "     %s\n" "$SCHEMA_JSON"
    exit 1
  fi
  SCHEMA_RESPONSE="$SCHEMA_JSON" node "${SCRIPT_DIR}/src/verify-db-schema.mjs"
  SCHEMA_EXIT=$?

  [[ $TRIGGER_EXIT -eq 0 && $SCHEMA_EXIT -eq 0 ]] && exit 0 || exit 1
fi

# ── Supabase Management API mode (production / normal CI) ────────────────────

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
TRIGGER_RESPONSE="$HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-triggers.mjs"
TRIGGER_EXIT=$?

# ── Schema-presence check — profile_emergency_contacts (migration 0076) ──────
printf "  ℹ  Checking profile_emergency_contacts schema\n"
SCHEMA_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${SCHEMA_SQL}\"}")

SCHEMA_HTTP_BODY=$(printf "%s" "$SCHEMA_CURL_RESPONSE" | head -n -1)
SCHEMA_HTTP_CODE=$(printf "%s" "$SCHEMA_CURL_RESPONSE" | tail -n 1)

if [[ "$SCHEMA_HTTP_CODE" != "200" && "$SCHEMA_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for schema check\n" "$SCHEMA_HTTP_CODE"
  printf "     Response: %s\n" "$SCHEMA_HTTP_BODY"
  exit 1
fi

SCHEMA_RESPONSE="$SCHEMA_HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-schema.mjs"
SCHEMA_EXIT=$?

[[ $TRIGGER_EXIT -eq 0 && $SCHEMA_EXIT -eq 0 ]] && exit 0 || exit 1
