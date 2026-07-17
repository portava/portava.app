#!/usr/bin/env bash
# check-schema-audit.sh — run the migrations-vs-live schema audit
# (artifacts/api-server/src/scripts/auditMigrationsVsLive.ts) as a
# pre-release gate.
#
# Called by scripts/pre-release-check.sh as the "schema-audit" check.
#
# Behavior (designed to be non-flaky):
#   • Missing credentials (no SUPABASE_ACCESS_TOKEN, or no SUPABASE_URL in
#     artifacts/api-server/.env or the environment) → SKIP with a loud
#     warning, exit 0.  Developers without Supabase credentials configured
#     locally are not blocked on unrelated work.
#   • Audit exits 2 (environment / Management API error — e.g. offline,
#     API unreachable, 5xx) → SKIP with a loud warning, exit 0.  A network
#     blip must not hard-fail the gate; the warning makes the skip visible.
#   • Audit exits 1 (real schema drift: migrations claim objects the live
#     schema does not have) → FAIL, exit 1.
#   • Audit exits 0 → PASS.
#
# The audit itself loads artifacts/api-server/.env via node
# --env-file-if-exists, so SUPABASE_URL normally needs no extra setup.
# SUPABASE_ACCESS_TOKEN must be present in the environment (workspace
# secret, CI secret, or exported manually).
#
# Exit codes:
#   0  audit passed, or was skipped (missing credentials / API unreachable)
#   1  audit found never-applied migrations (real drift)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Allow tests to redirect the workspace root without touching the real repo
# (mirrors CHECK_TRIGGERS_WORKSPACE_ROOT in check-db-triggers.sh).
if [[ -n "${CHECK_SCHEMA_AUDIT_WORKSPACE_ROOT:-}" ]]; then
  WORKSPACE_ROOT="$CHECK_SCHEMA_AUDIT_WORKSPACE_ROOT"
fi

cd "$WORKSPACE_ROOT"

API_SERVER_DIR="artifacts/api-server"

# ── credential presence pre-check (soft skip, not failure) ───────────────────
have_url=0
if [[ -n "${SUPABASE_URL:-}" ]]; then
  have_url=1
elif [[ -f "${API_SERVER_DIR}/.env" ]] && grep -q '^SUPABASE_URL=' "${API_SERVER_DIR}/.env"; then
  have_url=1
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" || "$have_url" -eq 0 ]]; then
  printf '  ⚠  schema-audit SKIPPED — Supabase credentials not configured.\n'
  if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
    printf '     SUPABASE_ACCESS_TOKEN is not set.\n'
    printf '     Generate at: https://supabase.com/dashboard/account/tokens\n'
  fi
  if [[ "$have_url" -eq 0 ]]; then
    printf '     SUPABASE_URL not set and not found in %s/.env\n' "$API_SERVER_DIR"
  fi
  printf '     The migrations-vs-live audit was NOT run. Do not ship a release\n'
  printf '     without running it at least once:\n'
  printf '       cd %s && pnpm run audit:schema\n' "$API_SERVER_DIR"
  exit 0
fi

# ── run the audit ─────────────────────────────────────────────────────────────
# Exit code contract of auditMigrationsVsLive.ts:
#   0 → no missing objects
#   1 → missing objects found (drift — hard failure)
#   2 → environment / API error (offline — soft skip)
set +e
(cd "$API_SERVER_DIR" && pnpm run audit:schema)
audit_exit=$?
set -e

case "$audit_exit" in
  0)
    exit 0
    ;;
  1)
    printf '  ✘  schema-audit FAILED — migrations claim objects the live schema does not have.\n'
    exit 1
    ;;
  2)
    printf '  ⚠  schema-audit SKIPPED — Supabase Management API unreachable or misconfigured (audit exit 2).\n'
    printf '     This is treated as a soft skip so a network blip does not block\n'
    printf '     unrelated work, but the audit did NOT verify the live schema.\n'
    printf '     Re-run when online:  cd %s && pnpm run audit:schema\n' "$API_SERVER_DIR"
    exit 0
    ;;
  *)
    # Unexpected exit (e.g. tsx crash) — fail loudly, this is a broken check,
    # not a network condition.
    printf '  ✘  schema-audit errored unexpectedly (exit %s) — the check itself may be broken.\n' "$audit_exit"
    exit 1
    ;;
esac
