#!/usr/bin/env bash
# Runs all api-server validation checks in one workflow slot.
# Each check is labeled and runs to completion regardless of earlier
# failures, so a failure is always attributable to a specific check instead
# of being buried in one undifferentiated log blob. Exits non-zero if any
# check failed.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=0

run_check() {
  local label="$1"
  shift
  echo ""
  echo "──────────────────────────────────────────────────────────"
  echo "▶ RUNNING: $label"
  echo "──────────────────────────────────────────────────────────"
  "$@"
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "✔ PASSED: $label"
  else
    echo "✘ FAILED: $label (exit $rc)"
    FAILED=1
  fi
}

run_check "check:frozen-dir" pnpm run check:frozen-dir
run_check "check:async-handlers" pnpm run check:async-handlers
run_check "check:migration-prefixes" pnpm run check:migration-prefixes
run_check "check:write-path-columns" pnpm run check:write-path-columns
run_check "check:missing-live-columns" pnpm run check:missing-live-columns

echo ""
echo "──────────────────────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  echo "✔ ALL CHECKS PASSED"
else
  echo "✘ ONE OR MORE CHECKS FAILED — see ✘ FAILED lines above"
fi
echo "──────────────────────────────────────────────────────────"

exit $FAILED
