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

# Self-check: the extracted block must be at least 80 % of the for-loop's
# actual length as measured directly from the source file (not from the
# extracted copy).  This makes the guard self-calibrating: when new case
# branches are added to the loop the minimum grows proportionally, so the
# threshold never goes stale.
#
# If you refactor the for-loop header (rename variable, split across lines,
# etc.) you must also update the awk pattern on line ~51 of this file AND
# the matching pattern in _SUMMARY_SOURCE_LINES below.
_SUMMARY_LINE_COUNT="$(printf '%s\n' "$SUMMARY_BLOCK" | wc -l | tr -d ' ')"
_SUMMARY_SOURCE_LINES="$(awk \
  '/^for entry in "\$\{results\[@\]\}"/,/^done$/' \
  scripts/pre-release-check.sh | wc -l | tr -d ' ')"
# 80 % of source length, rounded down.  Bump the percentage here if you want
# a stricter guard after a large refactor shrinks the loop intentionally.
_SUMMARY_MIN_LINES=$(( _SUMMARY_SOURCE_LINES * 80 / 100 ))
if [[ "$_SUMMARY_LINE_COUNT" -lt "$_SUMMARY_MIN_LINES" ]]; then
  printf '\n❌  SUMMARY_BLOCK extraction looks broken: got %s line(s), expected at least %s (80%% of %s source lines).\n' \
    "$_SUMMARY_LINE_COUNT" "$_SUMMARY_MIN_LINES" "$_SUMMARY_SOURCE_LINES"
  printf '    The awk pattern on line ~51 of test-pre-release-hints.sh matches:\n'
  printf '      /^for entry in "\\$\\{results\\[\\@\\]\\}"/,/^done$/\n'
  printf '    Update that pattern to match the current for-loop header in\n'
  printf '    scripts/pre-release-check.sh.\n\n'
  exit 1
fi
unset _SUMMARY_LINE_COUNT _SUMMARY_SOURCE_LINES _SUMMARY_MIN_LINES

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
  [bundle-id-placeholder]="fix: update ios.bundleIdentifier and android.package in travel-buddy-standalone/app.json"
)

# ── cross-reference: EXPECTED_HINTS keys vs run_check names ──────────────────
# Guard against a check being renamed in pre-release-check.sh without updating
# EXPECTED_HINTS here, or vice-versa.  Both directions are checked so neither
# side can silently go stale.

printf '\n'
sep
printf '  Cross-reference: EXPECTED_HINTS ↔ run_check names\n'
sep

# Extract the first argument of every `run_check "…"` call in the real script.
mapfile -t SCRIPT_NAMES < <(
  grep -E '^run_check "' scripts/pre-release-check.sh \
    | sed 's/^run_check "\([^"]*\)".*/\1/'
)

if [[ ${#SCRIPT_NAMES[@]} -eq 0 ]]; then
  printf '  ✘  Could not extract any run_check names from pre-release-check.sh.\n'
  printf '     Has the call style changed? Update the grep pattern in this test.\n'
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  xref_ok=1

  # Keys in EXPECTED_HINTS that have no matching run_check call → stale hint entry
  for name in "${!EXPECTED_HINTS[@]}"; do
    found=0
    for sname in "${SCRIPT_NAMES[@]}"; do
      [[ "$sname" == "$name" ]] && found=1 && break
    done
    if [[ $found -eq 0 ]]; then
      printf '  ✘  EXPECTED_HINTS["%s"] has no matching run_check call in pre-release-check.sh\n' "$name"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      xref_ok=0
    fi
  done

  # run_check names that have no entry in EXPECTED_HINTS → missing hint
  for name in "${SCRIPT_NAMES[@]}"; do
    if [[ -z "${EXPECTED_HINTS[$name]+set}" ]]; then
      printf '  ✘  run_check "%s" has no entry in EXPECTED_HINTS\n' "$name"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      xref_ok=0
    fi
  done

  if [[ $xref_ok -eq 1 ]]; then
    printf '  ✔  All %d check names are in sync\n' "${#SCRIPT_NAMES[@]}"
  fi
fi

sep

# ── run assertions ────────────────────────────────────────────────────────────

printf '\n'
sep
printf '  Pre-release fix-hint assertions\n'
sep

for check_name in typecheck typecheck-standalone dependency-drift source-drift api-server-build lockfile-drift bundle-id-placeholder; do
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
