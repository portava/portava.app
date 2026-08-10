#!/usr/bin/env bash
#
# run-live-suite.sh <label> <package-dir> <package-name> <script-name>
#
# Runs one of the three credential-dependent api-server test suites and scores
# it on its OUTPUT, not on its exit code alone.
#
# WHY THE EXIT CODE IS NOT ENOUGH
#
# All three suites compute
#   const CREDS_AVAILABLE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);
# and pass `{ skip: !CREDS_AVAILABLE }` to every describe(). None of them sets
# process.exitCode. So with any one credential missing they skip every test and
# exit 0 — a green run that asserted nothing about the profiles.role write
# boundary, the is_official trigger, or the RLS policies.
#
# The preflight step in .github/workflows/live-db.yml is the primary defence
# (it fails the job before this script is ever reached if a secret is empty).
# This script is the second: a suite that reports zero passing tests, or any
# skipped test, or prints its own "SKIPPING — no live credentials" banner, is
# treated as a failure.
#
# Every `skip:` in those three files is `{ skip: !CREDS_AVAILABLE }` — verified
# by reading them — so when credentials ARE present the expected skipped count
# is exactly 0. If a legitimately-skipped test is ever added to one of these
# files, this assertion has to be revisited deliberately rather than relaxed
# reflexively.
#
# This script is intentionally NOT in artifacts/api-server: it is CI scaffolding
# wrapping the repo's own scripts, and adding it to package.json would change a
# manifest this work is not permitted to touch.
#
# WHY IT TAKES THE PACKAGE DIRECTORY AND NAME AS ARGUMENTS
#
# It used to invoke the suite through pnpm's workspace-selector form, which
# EXITS 0 when it matches nothing (pnpm 10.26.1: an unmatched selector prints
# "No projects matched the filters" and exits 0; a matched package with a
# missing script also exits 0). So if one of these three test scripts were
# renamed or removed, this script would have parsed an empty log, found no
# counts... and, as it happens, failed on the "totals could not be parsed" rule
# — but only by luck, and only for the count-based half. It now delegates to
# .github/scripts/pnpm-run.sh, which asserts the directory, the package name and
# the script all exist BEFORE anything runs, and fails loudly and specifically
# when they do not. Passing all three literally also lets
# .github/scripts/assert-ci-scripts.mjs verify these call sites up front.

set -uo pipefail
# Byte-wise matching, so the count parsing below behaves identically whatever
# locale the runner happens to have. See the count_of comment.
export LC_ALL=C

USAGE='usage: run-live-suite.sh <label> <package-dir> <package-name> <script-name>'
LABEL="${1:?$USAGE}"
PKG_DIR="${2:?$USAGE}"
PKG_NAME="${3:?$USAGE}"
SCRIPT="${4:?$USAGE}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOG="${RUNNER_TEMP:-/tmp}/live-suite-${LABEL}.log"

bash "$HERE/pnpm-run.sh" "$PKG_DIR" "$PKG_NAME" "$SCRIPT" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}

# node:test prints `# pass 12` under the TAP reporter and `ℹ pass 12` under the
# spec reporter, depending on whether stdout is a TTY. Match both.
#
# The leading prefix is matched as `[^A-Za-z0-9]*` rather than as a character
# class containing the literal marker characters. A multibyte character (ℹ is
# three UTF-8 bytes) inside a POSIX bracket expression is matched BYTE-WISE in
# a C locale, so `[#ℹ]` matches only the first byte and the pattern then fails
# — silently, on every run. `[^A-Za-z0-9]*` is byte-safe in every locale and
# still rejects TAP body lines such as `ok 1 - pass 3`, because those start
# with an alphanumeric character.
count_of() {
  grep -E "^[^A-Za-z0-9]*$1[[:space:]]+[0-9]+[[:space:]]*$" "$LOG" \
    | tail -n 1 | grep -oE '[0-9]+' | tail -n 1
}

TESTS="$(count_of tests)"
PASS="$(count_of pass)"
FAIL="$(count_of fail)"
SKIPPED="$(count_of skipped)"

echo "──────────────────────────────────────────"
echo "$LABEL: tests=${TESTS:-?} pass=${PASS:-?} fail=${FAIL:-?} skipped=${SKIPPED:-?} exit=$rc"
echo "──────────────────────────────────────────"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### live-DB suite: $LABEL"
    echo ""
    echo "| metric | value |"
    echo "| --- | --- |"
    echo "| tests | ${TESTS:-not reported} |"
    echo "| pass | ${PASS:-not reported} |"
    echo "| fail | ${FAIL:-not reported} |"
    echo "| skipped | ${SKIPPED:-not reported} |"
    echo "| exit code | $rc |"
    echo ""
    echo "A skipped or zero-pass run of this suite is a FAILURE, not a pass:"
    echo "these suites skip silently and exit 0 when credentials are absent."
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$rc" -ne 0 ]; then
  echo "::error::$LABEL failed (exit $rc)"
  exit "$rc"
fi

# The explicit banner two of the three suites print. rlsHardening.test.ts prints
# nothing at all when it skips, which is why the count assertions below exist.
if grep -qF 'SKIPPING — no live credentials' "$LOG"; then
  echo "::error::$LABEL printed its no-live-credentials banner and skipped. Its own message says it: a skip is not a pass. The credentials reaching this process are incomplete."
  exit 1
fi

# ── EVERY count must be readable, and every count is asserted. ───────────────
#
# This block used to check only PASS and FAIL for emptiness. Two holes followed
# from that, both of which turned an unreadable number into a pass:
#
#   * SKIPPED. The skip assertion below was guarded by `[ -n "$SKIPPED" ]`, so
#     when the skipped count could not be parsed the assertion did not run at
#     all. That inverted the rule this file is built on: the count that is
#     hardest to read is the one that most needs asserting, because these three
#     suites report their credential-less state as "every test skipped". An
#     unreadable skipped count is exactly as unverified as a non-zero one, and
#     it now fails the same way.
#   * TESTS. It was parsed, printed in the summary table, and never asserted
#     against anything at all.
#
# `set -uo pipefail` is in force and there is deliberately no `set -e` (the
# counts are printed before anything fails), so an empty operand in
# `[ "$X" -ne 0 ]` makes `test` exit 2 with "integer expression expected" — and
# `if` scores any non-zero status as FALSE. That is why emptiness has to be
# rejected explicitly here rather than left to the comparisons: a non-integer
# does not fail those comparisons, it SKIPS them.
require_count() {
  local name="$1" value="$2"
  case "$value" in
    '' )
      echo "::error::$LABEL exited 0 but its '$name' count could not be parsed from the output. A run whose totals cannot be read has not been verified — and for these three suites an unreadable total is the same evidence as a skipped one: nothing was proved about the RLS policies, the profiles.role write boundary or the is_official trigger. Check the node:test reporter format before trusting this green."
      exit 1
      ;;
    *[!0-9]* )
      echo "::error::$LABEL parsed a '$name' count of '$value', which is not a bare non-negative integer. It cannot be compared: '[ $value -ne 0 ]' exits 2, and 'if' reads that as false, so the assertion would silently become a no-op."
      exit 1
      ;;
  esac
}

require_count tests "$TESTS"
require_count pass "$PASS"
require_count fail "$FAIL"
require_count skipped "$SKIPPED"

if [ "$FAIL" -ne 0 ]; then
  echo "::error::$LABEL exited 0 but reported $FAIL failing test(s)."
  exit 1
fi

if [ "$PASS" -eq 0 ]; then
  echo "::error::$LABEL exited 0 with 0 passing tests. This suite skips every describe() and exits 0 when SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY is missing or wrong. It has asserted nothing."
  exit 1
fi

# No `[ -n "$SKIPPED" ]` guard. An unreadable skipped count is a failure above,
# not a reason to stop asserting.
if [ "$SKIPPED" -ne 0 ]; then
  echo "::error::$LABEL reported $SKIPPED skipped test(s). Every skip in these three files is gated on missing credentials, so a non-zero skipped count means part of the security boundary was not exercised."
  exit 1
fi

# ── TESTS is now asserted, not merely printed. ───────────────────────────────
if [ "$TESTS" -eq 0 ]; then
  echo "::error::$LABEL exited 0 having run 0 tests. The suite file was loaded and produced no tests at all — a describe() that was renamed out of existence, or a file that no longer registers anything. It has asserted nothing about the security boundary it names."
  exit 1
fi

# fail and skipped are both 0 by the assertions above, so every test node:test
# counted must be a passing one. Any shortfall is a test that reached neither
# outcome — a `todo`, or one cancelled when the process died mid-run — and each
# of those asserted nothing while leaving pass > 0, fail == 0 and skipped == 0
# intact. That combination is invisible to every other check in this file.
UNACCOUNTED=$(( TESTS - PASS ))
if [ "$UNACCOUNTED" -ne 0 ]; then
  echo "::error::$LABEL reported tests=$TESTS but pass=$PASS with fail=0 and skipped=0, leaving $UNACCOUNTED test(s) unaccounted for. Those are todo or cancelled tests: they asserted nothing, and they do not show up in any of the other counts. Resolve them, or if a todo is deliberate here, revisit this assertion in the PR that adds it rather than relaxing it after the fact."
  exit 1
fi

echo "$LABEL: verified — $TESTS test(s) run, $PASS passing, 0 failing, 0 skipped, 0 unaccounted."
