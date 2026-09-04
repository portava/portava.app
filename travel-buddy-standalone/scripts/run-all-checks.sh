#!/usr/bin/env bash
# Runs standalone test + typecheck validation in one workflow slot.
# Each step is labeled and runs to completion regardless of earlier
# failures, so a failure is always attributable to a specific step instead
# of being buried in one undifferentiated log blob. Exits non-zero if any
# step failed.
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

run_check "test" pnpm run test
run_check "test:component" pnpm run test:component
run_check "typecheck" pnpm run typecheck
run_check "typecheck:tests" pnpm run typecheck:tests
run_check "lint:bare-image" pnpm run lint:bare-image
run_check "lint:avatar-icon-sizing" pnpm run lint:avatar-icon-sizing
run_check "test:avatar-icon-sizing-guard" pnpm run test:avatar-icon-sizing-guard
run_check "lint:dev-proxy-not-shipped" pnpm run lint:dev-proxy-not-shipped
run_check "lint:orphan-tests" pnpm run lint:orphan-tests
run_check "check:test-fixture-shapes" pnpm run check:test-fixture-shapes

echo ""
echo "──────────────────────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  echo "✔ ALL CHECKS PASSED"
else
  echo "✘ ONE OR MORE CHECKS FAILED — see ✘ FAILED lines above"
fi
echo "──────────────────────────────────────────────────────────"

exit $FAILED
