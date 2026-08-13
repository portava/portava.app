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
#                            in GitHub Actions secrets).
#                            NOT READ-ONLY (corrected 2026-08-11).  This is a
#                            Management API token and it CAN WRITE; earlier text
#                            here told you to "scope it to read" and treated that
#                            as the safety property.  It is not.  Per
#                            docs/ci/README.md:469-470, this check is read-only
#                            because of what the CHECK does (SELECTs only) and
#                            because the target allowlist pins the project — never
#                            because of the credential.  Store and rotate it as a
#                            write-capable secret.
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

# ── safe-return schema SQL (migration 0040) ───────────────────────────────────
# Checks that safe_return_sessions exists, has RLS enabled, and carries the
# srs_own policy.  If this table is absent the Safe Return history and setup
# screens will 500 or silently return empty on every request.
SAFE_RETURN_SQL="SELECT 'table' AS check_type, relname AS name, relrowsecurity::text AS detail \
FROM pg_class \
WHERE relname = 'safe_return_sessions' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
UNION ALL \
SELECT 'policy' AS check_type, policyname AS name, cmd AS detail \
FROM pg_policies \
WHERE tablename = 'safe_return_sessions' AND schemaname = 'public'"

# ── push tokens schema SQL (migration 0041) ───────────────────────────────────
# Checks that notification_devices exists, has RLS enabled, and carries the
# nd_own policy.  This table stores Expo push tokens; without it the device
# registration endpoint returns a DB error and push notifications cannot be
# delivered.
PUSH_TOKENS_SQL="SELECT 'table' AS check_type, relname AS name, relrowsecurity::text AS detail \
FROM pg_class \
WHERE relname = 'notification_devices' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
UNION ALL \
SELECT 'policy' AS check_type, policyname AS name, cmd AS detail \
FROM pg_policies \
WHERE tablename = 'notification_devices' AND schemaname = 'public'"

# ── rent_buddy rollout tables SQL (migration 0090) ────────────────────────────
# Checks that rent_buddy_global_controls (singleton kill-switch row, RLS enabled)
# and rent_buddy_city_rollouts (RLS + rb_rollout_public_read + rb_rollout_svc
# policies) exist with the correct columns.  Without these tables every call to
# checkRentBuddyAccess returns city_not_available, disabling rent-a-buddy entirely.
RENT_BUDDY_ROLLOUT_SQL="SELECT 'table_global_controls' AS check_type, relname AS name, relrowsecurity::text AS detail \
FROM pg_class \
WHERE relname = 'rent_buddy_global_controls' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
UNION ALL \
SELECT 'col_global_controls' AS check_type, attname AS name, atttypid::regtype::text AS detail \
FROM pg_attribute \
JOIN pg_class ON pg_class.oid = pg_attribute.attrelid \
WHERE pg_class.relname = 'rent_buddy_global_controls' \
AND pg_class.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
AND attnum > 0 AND NOT attisdropped \
AND attname IN ('all_bookings_paused','applications_paused','cash_balance_paused','nightlife_paused','force_full_in_app','force_public_meetup','force_delayed_posting') \
UNION ALL \
SELECT 'table_city_rollouts' AS check_type, relname AS name, relrowsecurity::text AS detail \
FROM pg_class \
WHERE relname = 'rent_buddy_city_rollouts' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') \
UNION ALL \
SELECT 'policy' AS check_type, policyname AS name, cmd AS detail \
FROM pg_policies \
WHERE tablename = 'rent_buddy_city_rollouts' AND schemaname = 'public' \
UNION ALL \
SELECT 'feature_flag' AS check_type, flag AS name, enabled::text AS detail \
FROM feature_flags \
WHERE flag = 'rent_buddy_enabled' \
UNION ALL \
SELECT 'live_city_count' AS check_type, COUNT(*)::text AS name, 'public_mvp,beta_testing' AS detail \
FROM rent_buddy_city_rollouts \
WHERE status IN ('public_mvp', 'beta_testing')"

# ── beta kill-switch and feature-gate flags SQL (migration 0117) ──────────────
# Checks that all 7 rows seeded by 0117_beta_feature_flags.sql exist in the
# feature_flags table.  Without these rows the kill switches (disable_posting,
# disable_messaging, etc.) always fail-open because there is no row to read.
BETA_FLAGS_SQL="SELECT flag, enabled::text \
FROM feature_flags \
WHERE flag IN (\
'disable_signups',\
'disable_posting',\
'disable_messaging',\
'disable_rent_buddy_booking',\
'invite_only_beta',\
'compass_ai_enabled'\
)"

# ── invite-link slot functions SQL (migrations 0109–0111) ─────────────────────
# Checks that the SECURITY DEFINER functions and supporting table introduced by
# migrations 0109 (claim/release slot), 0110 (idempotent claim + attempt ledger
# table), 0111 (reconciliation function), and 0113 (stale-attempt cleanup) all
# exist in the production database.  Without 0109/0110 the accept handler
# returns a DB error on every invite-link join; without 0111/0113
# POST /api/admin/trips/reconcile-invite-slots returns 500.
INVITE_LINK_FUNCS_SQL="SELECT 'function' AS check_type, proname AS name \
FROM pg_proc \
WHERE proname IN (\
'claim_invite_link_slot',\
'release_invite_link_slot',\
'claim_invite_link_slot_for_user',\
'reconcile_invite_link_slots',\
'cleanup_stale_invite_link_attempts'\
) \
UNION ALL \
SELECT 'table' AS check_type, relname AS name \
FROM pg_class \
WHERE relname = 'trip_invite_link_attempts' \
AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')"

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

  # ── Safe Return schema check (psql) ─────────────────────────────────────────
  printf "  ℹ  Checking safe_return_sessions schema (psql)\n"
  SR_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${SAFE_RETURN_SQL}) q"
  SR_JSON=$(psql "$PSQL_URL" -t -A -c "$SR_JSON_SQL" 2>&1)
  SR_PSQL_EXIT=$?
  if [[ $SR_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql safe_return schema query failed (exit %d):\n" "$SR_PSQL_EXIT"
    printf "     %s\n" "$SR_JSON"
    exit 1
  fi
  SAFE_RETURN_SCHEMA_RESPONSE="$SR_JSON" node "${SCRIPT_DIR}/src/verify-db-safe-return.mjs"
  SR_EXIT=$?

  # ── Push tokens schema check (psql) ──────────────────────────────────────────
  printf "  ℹ  Checking notification_devices schema (push tokens) (psql)\n"
  PT_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${PUSH_TOKENS_SQL}) q"
  PT_JSON=$(psql "$PSQL_URL" -t -A -c "$PT_JSON_SQL" 2>&1)
  PT_PSQL_EXIT=$?
  if [[ $PT_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql push_tokens schema query failed (exit %d):\n" "$PT_PSQL_EXIT"
    printf "     %s\n" "$PT_JSON"
    exit 1
  fi
  SCHEMA_TABLE="notification_devices" \
  SCHEMA_POLICIES="nd_own" \
  SCHEMA_MIGRATION="artifacts/api-server/migrations/0041_notifications.sql" \
  SCHEMA_RESPONSE="$PT_JSON" \
    node "${SCRIPT_DIR}/src/verify-db-schema.mjs"
  PT_EXIT=$?

  # ── Rent Buddy rollout tables check (psql) ────────────────────────────────────
  printf "  ℹ  Checking rent_buddy rollout tables (migration 0090) (psql)\n"
  RBR_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${RENT_BUDDY_ROLLOUT_SQL}) q"
  RBR_JSON=$(psql "$PSQL_URL" -t -A -c "$RBR_JSON_SQL" 2>&1)
  RBR_PSQL_EXIT=$?
  if [[ $RBR_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql rent_buddy rollout query failed (exit %d):\n" "$RBR_PSQL_EXIT"
    printf "     %s\n" "$RBR_JSON"
    exit 1
  fi
  RENT_BUDDY_ROLLOUT_RESPONSE="$RBR_JSON" node "${SCRIPT_DIR}/src/verify-db-rent-buddy-rollout.mjs"
  RBR_EXIT=$?

  # ── Invite-link slot functions check (psql) ───────────────────────────────────
  printf "  ℹ  Checking invite-link slot functions (migrations 0109–0111) (psql)\n"
  ILF_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${INVITE_LINK_FUNCS_SQL}) q"
  ILF_JSON=$(psql "$PSQL_URL" -t -A -c "$ILF_JSON_SQL" 2>&1)
  ILF_PSQL_EXIT=$?
  if [[ $ILF_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql invite-link funcs query failed (exit %d):\n" "$ILF_PSQL_EXIT"
    printf "     %s\n" "$ILF_JSON"
    exit 1
  fi
  INVITE_LINK_FUNCS_RESPONSE="$ILF_JSON" node "${SCRIPT_DIR}/src/verify-db-invite-link-funcs.mjs"
  ILF_EXIT=$?

  # ── Beta flags check (psql) ───────────────────────────────────────────────────
  printf "  ℹ  Checking beta kill-switch flags (migration 0117) (psql)\n"
  BF_JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${BETA_FLAGS_SQL}) q"
  BF_JSON=$(psql "$PSQL_URL" -t -A -c "$BF_JSON_SQL" 2>&1)
  BF_PSQL_EXIT=$?
  if [[ $BF_PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql beta-flags query failed (exit %d):\n" "$BF_PSQL_EXIT"
    printf "     %s\n" "$BF_JSON"
    exit 1
  fi
  BETA_FLAGS_RESPONSE="$BF_JSON" node "${SCRIPT_DIR}/src/verify-db-beta-flags.mjs"
  BF_EXIT=$?

  [[ $TRIGGER_EXIT -eq 0 && $SCHEMA_EXIT -eq 0 && $SR_EXIT -eq 0 && $PT_EXIT -eq 0 && $RBR_EXIT -eq 0 && $ILF_EXIT -eq 0 && $BF_EXIT -eq 0 ]] && exit 0 || exit 1
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
  printf "       Pick the narrowest scope offered.  Store as: SUPABASE_PROJECT_TOKEN\n"
  printf "       NOTE: this token is NOT read-only — it can write.\n"
  printf "       See docs/ci/README.md:469-470.\n"
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

# ── Safe Return schema check — safe_return_sessions (migration 0040) ──────────
printf "  ℹ  Checking safe_return_sessions schema\n"
SR_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${SAFE_RETURN_SQL}\"}")

SR_HTTP_BODY=$(printf "%s" "$SR_CURL_RESPONSE" | head -n -1)
SR_HTTP_CODE=$(printf "%s" "$SR_CURL_RESPONSE" | tail -n 1)

if [[ "$SR_HTTP_CODE" != "200" && "$SR_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for safe_return schema check\n" "$SR_HTTP_CODE"
  printf "     Response: %s\n" "$SR_HTTP_BODY"
  exit 1
fi

SAFE_RETURN_SCHEMA_RESPONSE="$SR_HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-safe-return.mjs"
SR_EXIT=$?

# ── Push tokens schema check — notification_devices (migration 0041) ──────────
printf "  ℹ  Checking notification_devices schema (push tokens)\n"
PT_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${PUSH_TOKENS_SQL}\"}")

PT_HTTP_BODY=$(printf "%s" "$PT_CURL_RESPONSE" | head -n -1)
PT_HTTP_CODE=$(printf "%s" "$PT_CURL_RESPONSE" | tail -n 1)

if [[ "$PT_HTTP_CODE" != "200" && "$PT_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for push_tokens schema check\n" "$PT_HTTP_CODE"
  printf "     Response: %s\n" "$PT_HTTP_BODY"
  exit 1
fi

SCHEMA_TABLE="notification_devices" \
SCHEMA_POLICIES="nd_own" \
SCHEMA_MIGRATION="artifacts/api-server/migrations/0041_notifications.sql" \
SCHEMA_RESPONSE="$PT_HTTP_BODY" \
  node "${SCRIPT_DIR}/src/verify-db-schema.mjs"
PT_EXIT=$?

# ── Rent Buddy rollout tables check — rent_buddy_global_controls + rent_buddy_city_rollouts (migration 0090) ──
printf "  ℹ  Checking rent_buddy rollout tables (migration 0090)\n"
RBR_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${RENT_BUDDY_ROLLOUT_SQL}\"}")

RBR_HTTP_BODY=$(printf "%s" "$RBR_CURL_RESPONSE" | head -n -1)
RBR_HTTP_CODE=$(printf "%s" "$RBR_CURL_RESPONSE" | tail -n 1)

if [[ "$RBR_HTTP_CODE" != "200" && "$RBR_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for rent_buddy rollout check\n" "$RBR_HTTP_CODE"
  printf "     Response: %s\n" "$RBR_HTTP_BODY"
  exit 1
fi

RENT_BUDDY_ROLLOUT_RESPONSE="$RBR_HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-rent-buddy-rollout.mjs"
RBR_EXIT=$?

# ── Invite-link slot functions check — claim/release/reconcile (migrations 0109–0111) ──
printf "  ℹ  Checking invite-link slot functions (migrations 0109–0111)\n"
ILF_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${INVITE_LINK_FUNCS_SQL}\"}")

ILF_HTTP_BODY=$(printf "%s" "$ILF_CURL_RESPONSE" | head -n -1)
ILF_HTTP_CODE=$(printf "%s" "$ILF_CURL_RESPONSE" | tail -n 1)

if [[ "$ILF_HTTP_CODE" != "200" && "$ILF_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for invite-link funcs check\n" "$ILF_HTTP_CODE"
  printf "     Response: %s\n" "$ILF_HTTP_BODY"
  exit 1
fi

INVITE_LINK_FUNCS_RESPONSE="$ILF_HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-invite-link-funcs.mjs"
ILF_EXIT=$?

# ── Beta kill-switch flags check — feature_flags rows (migration 0117) ────────
printf "  ℹ  Checking beta kill-switch flags (migration 0117)\n"
BF_CURL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${BETA_FLAGS_SQL}\"}")

BF_HTTP_BODY=$(printf "%s" "$BF_CURL_RESPONSE" | head -n -1)
BF_HTTP_CODE=$(printf "%s" "$BF_CURL_RESPONSE" | tail -n 1)

if [[ "$BF_HTTP_CODE" != "200" && "$BF_HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s for beta-flags check\n" "$BF_HTTP_CODE"
  printf "     Response: %s\n" "$BF_HTTP_BODY"
  exit 1
fi

BETA_FLAGS_RESPONSE="$BF_HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-beta-flags.mjs"
BF_EXIT=$?

[[ $TRIGGER_EXIT -eq 0 && $SCHEMA_EXIT -eq 0 && $SR_EXIT -eq 0 && $PT_EXIT -eq 0 && $RBR_EXIT -eq 0 && $ILF_EXIT -eq 0 && $BF_EXIT -eq 0 ]] && exit 0 || exit 1
