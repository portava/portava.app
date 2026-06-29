#!/usr/bin/env bash
# test-pre-release-hints.sh — verify that the pre-release summary loop
# prints the correct per-check fix hint for every check name.
#
# How it works
# ────────────
# The summary `for entry in …` block is extracted from the real
# pre-release-check.sh via awk (pattern-based, not line numbers, so the
# test stays correct if the script is refactored).  For each of the six
# checks the block is evaluated in a subshell with a single synthetic FAIL
# result, and the expected fix hint is asserted to appear in stdout.
#
# Usage (from the workspace root):
#   bash scripts/test-pre-release-hints.sh
#
# Exit code: 0 when every assertion passes, 1 on any failure.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

PASS_COUNT=0
FAIL_COUNT=0
FAILED_NAMES=()

# ── helpers ──────────────────────────────────────────────────────────────────

sep() { printf '%s\n' "$(printf '─%.0s' {1..60})"; }

assert_contains() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if printf '%s' "$actual" | grep -qF "$expected"; then
    printf '  ✔  %s\n' "$label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✘  %s\n' "$label"
    printf '       expected : %s\n' "$expected"
    printf '       got      :\n'
    printf '%s\n' "$actual" | sed 's/^/         /'
    FAILED_NAMES+=("$label")
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Extract the summary for-loop from the real script using awk so the test
# is not coupled to specific line numbers.
SUMMARY_BLOCK="$(awk \
  '/^for entry in "\$\{results\[@\]\}"/,/^done$/' \
  scripts/pre-release-check.sh)"

if [[ -z "$SUMMARY_BLOCK" ]]; then
  printf '\n❌  Could not extract the summary for-loop from pre-release-check.sh.\n'
  printf '    Has the script been refactored? Update the awk pattern in this test.\n\n'
  exit 1
fi

# Run the extracted block in a subshell with a single synthetic FAIL result.
run_summary_for() {
  local check_name="$1"
  bash <<EOF
PASS=0
FAIL=1
results=("FAIL|${check_name}|exit code 1")
overall=\$FAIL
sep() { printf '%s\\n' "\$(printf '─%.0s' {1..60})"; }
${SUMMARY_BLOCK}
EOF
}

# ── expected fix hints (must match the case statement in pre-release-check.sh) ─

declare -A EXPECTED_HINTS=(
  [typecheck]="fix: pnpm run typecheck"
  [typecheck-standalone]="fix: cd travel-buddy-standalone && pnpm typecheck"
  [dependency-drift]="fix: bash scripts/sync-standalone.sh --apply-deps && pnpm install"
  [source-drift]="fix: bash scripts/sync-standalone.sh --fix-source"
  [api-server-build]="fix: pnpm --filter @workspace/api-server run build"
  [lockfile-drift]="fix: bash scripts/sync-standalone.sh --fix-lockfile"
)

# ── run assertions ────────────────────────────────────────────────────────────

printf '\n'
sep
printf '  Pre-release fix-hint assertions\n'
sep

for check_name in typecheck typecheck-standalone dependency-drift source-drift api-server-build lockfile-drift; do
  expected="${EXPECTED_HINTS[$check_name]}"
  output="$(run_summary_for "$check_name")"
  assert_contains "$check_name" "$expected" "$output"
done

sep

# ── summary ───────────────────────────────────────────────────────────────────

total=$((PASS_COUNT + FAIL_COUNT))
printf '\n'
if [[ $FAIL_COUNT -eq 0 ]]; then
  printf "All %d fix-hint assertions passed.\n\n" "$total"
  exit 0
else
  printf "%d of %d assertions failed: %s\n\n" \
    "$FAIL_COUNT" "$total" "${FAILED_NAMES[*]}"
  printf 'Fix: update the case statement in scripts/pre-release-check.sh\n'
  printf '     so the hint for each failing check matches EXPECTED_HINTS above.\n\n'
  exit 1
fi
