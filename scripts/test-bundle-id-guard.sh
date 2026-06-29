#!/usr/bin/env bash
# test-bundle-id-guard.sh — end-to-end test for the bundle-id-placeholder guard.
#
# How it works
# ────────────
# The body of the `bash -c '…'` block inside the run_check "bundle-id-placeholder"
# call is extracted from the real pre-release-check.sh using awk (pattern-based,
# not line numbers, so this test stays correct through refactors).  The guard is
# then exercised in two scenarios:
#
#   (a) A scratch app.json that contains the placeholder  com.travelbuddy.app
#       → the guard must exit 1 (failing the check).
#   (b) A scratch app.json that contains the real bundle ID  com.passporttravelbuddy.app
#       → the guard must exit 0 (passing the check).
#
# Usage (from the workspace root):
#   bash scripts/test-bundle-id-guard.sh
#
# Exit code: 0 when every assertion passes, 1 on any failure.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_NAMES=()

sep() { printf '%s\n' "$(printf '─%.0s' {1..60})"; }

assert_exit() {
  local label="$1"
  local expected_exit="$2"
  local actual_exit="$3"
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    printf '  ✔  %s — exit %d as expected\n' "$label" "$actual_exit"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✘  %s — expected exit %d, got %d\n' "$label" "$expected_exit" "$actual_exit"
    FAILED_NAMES+=("$label")
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ── Extract the guard body from the real script ───────────────────────────────
# We pull the lines between "bash -c '" and the closing standalone "  '" that
# ends the run_check "bundle-id-placeholder" block.  The awk range spans the
# entire run_check call; sed then strips the outer wrapper lines so only the
# inner shell commands remain.

GUARD_RAW="$(awk \
  '/^run_check "bundle-id-placeholder"/,/^  '"'"'$/' \
  scripts/pre-release-check.sh)"

if [[ -z "$GUARD_RAW" ]]; then
  printf '\n❌  Could not extract the bundle-id-placeholder block from pre-release-check.sh.\n'
  printf '    Has the check been renamed or the bash -c block restructured?\n'
  printf '    Update the awk pattern on line ~52 of this test to match.\n\n'
  exit 1
fi

# Strip the run_check/bash -c wrapper lines; keep only the inner body lines.
GUARD_BODY="$(printf '%s\n' "$GUARD_RAW" \
  | sed -n "/bash -c '/,/^  '$/{ /bash -c '/d; /^  '$/d; p }")"

if [[ -z "$GUARD_BODY" ]]; then
  printf '\n❌  Extracted guard block is empty after stripping the bash -c wrapper.\n'
  printf '    The inner body between bash -c '"'"'...'"'"' must not be empty.\n\n'
  exit 1
fi

# Structural sanity-check: the extracted body must contain key identifiers.
_body_ok=1
for _kw in 'PLACEHOLDER' 'BUNDLE_ID' 'exit $ok'; do
  if ! printf '%s\n' "$GUARD_BODY" | grep -qF "$_kw"; then
    printf '\n❌  Extracted guard body is missing expected token: %s\n' "$_kw"
    _body_ok=0
  fi
done
if [[ $_body_ok -eq 0 ]]; then
  printf '    The guard body does not look correct. Update the awk/sed patterns\n'
  printf '    in this test to match the current structure of the run_check block.\n\n'
  exit 1
fi
unset _body_ok _kw

# ── Helpers ───────────────────────────────────────────────────────────────────

# Build a minimal app.json with the given ios.bundleIdentifier and android.package.
make_app_json() {
  local id="$1"
  cat <<JSON
{
  "expo": {
    "name": "Travel Buddy",
    "slug": "travel-buddy",
    "ios": {
      "bundleIdentifier": "${id}"
    },
    "android": {
      "package": "${id}"
    }
  }
}
JSON
}

# Run the extracted guard body against a given app.json path.
# Guard stdout/stderr are forwarded to the terminal (via stderr) so the
# assertion output is visible; only the numeric exit code is printed to
# stdout so the caller's $() substitution captures just the number.
run_guard() {
  local app_json_path="$1"
  local body_with_path
  # Substitute the hardcoded standalone path with the temp file path.
  body_with_path="$(printf '%s\n' "$GUARD_BODY" \
    | sed "s|travel-buddy-standalone/app\.json|${app_json_path}|g")"
  set +e
  bash -c "$body_with_path" >&2
  local rc=$?
  set -e
  echo "$rc"
}

# ── Temporary workspace ───────────────────────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PLACEHOLDER_JSON="${TMP_DIR}/app_placeholder.json"
REAL_JSON="${TMP_DIR}/app_real.json"

make_app_json "com.travelbuddy.app"        > "$PLACEHOLDER_JSON"
make_app_json "com.passporttravelbuddy.app" > "$REAL_JSON"

# ── Run assertions ────────────────────────────────────────────────────────────

printf '\n'
sep
printf '  Bundle-ID guard end-to-end assertions\n'
sep
printf '\n'

printf '  Scenario A: app.json contains the placeholder (com.travelbuddy.app)\n'
printf '              → guard must fail (exit 1)\n\n'
rc_a="$(run_guard "$PLACEHOLDER_JSON")"
assert_exit "placeholder bundle ID → guard exits 1" "1" "$rc_a"

printf '\n'
printf '  Scenario B: app.json contains the real identifier (com.passporttravelbuddy.app)\n'
printf '              → guard must pass (exit 0)\n\n'
rc_b="$(run_guard "$REAL_JSON")"
assert_exit "real bundle ID → guard exits 0" "0" "$rc_b"

sep

# ── Summary ───────────────────────────────────────────────────────────────────

total=$((PASS_COUNT + FAIL_COUNT))
printf '\n'
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf 'All %d bundle-ID guard assertions passed.\n\n' "$total"
  exit 0
else
  printf '%d of %d assertions failed: %s\n\n' \
    "$FAIL_COUNT" "$total" "${FAILED_NAMES[*]}"
  printf 'Fix: review the run_check "bundle-id-placeholder" block in\n'
  printf '     scripts/pre-release-check.sh and ensure it exits 1 for\n'
  printf '     com.travelbuddy.app and exits 0 for the real identifier.\n\n'
  exit 1
fi
