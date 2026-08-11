#!/usr/bin/env bash
# check-engagement-indexes.sh — verify that all ten engagement indexes are
# present in the Supabase production database:
#
#   migration 0106 — five post-perspective indexes (cursor-based pagination in
#                    GET /api/engagement/likes ordered by post/comment/etc. ID)
#   migration 0123 — five user-perspective indexes (profile-page + 'liked by
#                    me' feed lookups by user_id)
#
# Called by scripts/pre-release-check.sh as the "engagement-indexes" check.
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
#                            because of what the CHECK does and because the target
#                            allowlist pins the project — never because of the
#                            credential.  Store and rotate it as a write-capable
#                            secret.
#                            See docs/eas-runbook.md → "DB triggers check in CI"
#                            for full setup instructions.
#
#   SUPABASE_ACCESS_TOKEN  — Personal access token (Management API).  Suitable
#                            for local developer runs.
#                            Generate one at:
#                            https://supabase.com/dashboard/account/tokens
#
# If neither token is set the check is SKIPPED with a warning (exit 0).
# This differs from check-db-triggers.sh which requires a token; the index
# check is informational and should never block a developer who is working
# without Supabase credentials configured locally.
#
# The Supabase project ref is extracted automatically from SUPABASE_URL in
# artifacts/api-server/.env — no extra configuration is needed.
#
# ── Testing / local-PostgreSQL mode ──────────────────────────────────────────
#
#   ENGAGEMENT_QUERY_MODE=psql — Skip the Supabase Management API entirely and
#                                query a local PostgreSQL instance via psql.
#                                Requires ENGAGEMENT_PSQL_URL to be set.
#
#   ENGAGEMENT_PSQL_URL        — libpq connection string for the test database,
#                                e.g. "postgresql://postgres@localhost:5432/testdb".
#                                Used only when ENGAGEMENT_QUERY_MODE=psql.
#
# Exit codes:
#   0  all ten indexes confirmed present, or check was skipped (no token)
#   1  one or more indexes are missing or the API call failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# CHECK_ENGAGEMENT_WORKSPACE_ROOT can be set by tests to point at a temp
# directory that contains a minimal artifacts/api-server/.env, which allows
# the test suite to run offline without touching the real Supabase project.
if [[ -n "${CHECK_ENGAGEMENT_WORKSPACE_ROOT:-}" ]]; then
  WORKSPACE_ROOT="$CHECK_ENGAGEMENT_WORKSPACE_ROOT"
else
  WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
cd "$WORKSPACE_ROOT"

# ENGAGEMENT_SCHEMA_FILTER allows the test suite to point at an isolated schema
# instead of 'public' so test indexes don't collide with production objects.
SCHEMA_FILTER="${ENGAGEMENT_SCHEMA_FILTER:-public}"

SQL="SELECT indexname FROM pg_indexes \
WHERE schemaname = '${SCHEMA_FILTER}' \
AND indexname IN (\
'idx_posts_likes_post_created',\
'idx_post_reactions_post_emoji_created',\
'idx_comment_likes_comment_created',\
'idx_highlight_likes_highlight_created',\
'idx_memory_likes_memory_created',\
'idx_posts_likes_user_created',\
'idx_post_reactions_user_created',\
'idx_comment_likes_user_created',\
'idx_highlight_likes_user_created',\
'idx_memory_likes_user_created'\
)"

# ── local psql mode (testing / CI with direct DB access) ─────────────────────
if [[ "${ENGAGEMENT_QUERY_MODE:-api}" == "psql" ]]; then
  PSQL_URL="${ENGAGEMENT_PSQL_URL:-}"
  if [[ -z "$PSQL_URL" ]]; then
    printf "  ✘  ENGAGEMENT_PSQL_URL is required when ENGAGEMENT_QUERY_MODE=psql\n"
    printf "     Example: postgresql://postgres@localhost:5432/testdb\n"
    exit 1
  fi

  printf "  ℹ  Using psql (ENGAGEMENT_QUERY_MODE=psql) for engagement index check\n"

  JSON_SQL="SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${SQL}) q"
  INDEX_JSON=$(psql "$PSQL_URL" -t -A -c "$JSON_SQL" 2>&1)
  PSQL_EXIT=$?

  if [[ $PSQL_EXIT -ne 0 ]]; then
    printf "  ✘  psql query failed (exit %d):\n" "$PSQL_EXIT"
    printf "     %s\n" "$INDEX_JSON"
    exit 1
  fi

  ENGAGEMENT_INDEX_RESPONSE="$INDEX_JSON" node "${SCRIPT_DIR}/src/verify-db-engagement-indexes.mjs"
  exit $?
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
MGMT_TOKEN=""
TOKEN_SOURCE=""

if [[ -n "${SUPABASE_PROJECT_TOKEN:-}" ]]; then
  MGMT_TOKEN="$SUPABASE_PROJECT_TOKEN"
  TOKEN_SOURCE="SUPABASE_PROJECT_TOKEN"
elif [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  MGMT_TOKEN="$SUPABASE_ACCESS_TOKEN"
  TOKEN_SOURCE="SUPABASE_ACCESS_TOKEN"
else
  printf "  ⚠️   No Supabase token found — skipping engagement index check.\n"
  printf "      Set SUPABASE_ACCESS_TOKEN (local) or SUPABASE_PROJECT_TOKEN (CI)\n"
  printf "      to verify that migration 0106 + 0123 engagement indexes are live.\n"
  printf "      Without this check a schema reset could silently drop the indexes\n"
  printf "      and degrade engagement likes and profile-page queries.\n"
  exit 0
fi

printf "  ℹ  Using %s for Supabase Management API\n" "$TOKEN_SOURCE"

# ── query Management API for all ten engagement indexes ──────────────────────
API_URL="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_URL" \
  -H "Authorization: Bearer ${MGMT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-raw "{\"query\":\"${SQL}\"}")

HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  printf "  ✘  Supabase Management API returned HTTP %s\n" "$HTTP_CODE"
  printf "     Response: %s\n" "$HTTP_BODY"
  printf "     Verify %s is valid and has access to project %s.\n" "$TOKEN_SOURCE" "$PROJECT_REF"
  exit 1
fi

ENGAGEMENT_INDEX_RESPONSE="$HTTP_BODY" node "${SCRIPT_DIR}/src/verify-db-engagement-indexes.mjs"
