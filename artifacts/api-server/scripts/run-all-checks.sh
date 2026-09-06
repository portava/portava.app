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

# A check whose result is not read off the exit code alone.
#
# check:rank-events-surfaces reports two independent things: (1) the deploy
# gate — a BEHAVIOURAL PROBE that attempts a real INSERT with the required
# surface and always rolls it back, which is the only thing that decides the
# verdict; and (2) an informational report on the standing, pre-existing
# 'living_page' / 'compass' rejections, which fires on EVERY run and is not
# something a build can fix. That informational finding is printed prominently
# and does NOT move the exit code, so check:all does not go permanently red on
# it — a permanently-red check is one `|| true` away from being no check at all,
# which is precisely how 'living_page' went months silently dropping rows.
#
# TWO CONDITIONS, BOTH REQUIRED, TO SCORE A PASS:
#
#   1. exit 0 — and ONLY 0. Every other code fails, including codes the script
#      does not currently emit, because an unrecognised code is an unknown state
#      and an unknown state is not a pass. In particular exit 1 FAILS: nothing
#      in that script chooses 1, so 1 can only mean the process died
#      involuntarily (uncaught exception, unhandled rejection, module-resolution
#      or tsx/TypeScript load failure). A crash proves nothing. 2 = CANNOT-RUN
#      (no live credentials — this gate must FAIL rather than skip in a
#      credential-less environment); 3 = BLOCKED (rejected, or the result could
#      not be established); every fail-closed condition in the script exits 2
#      or 3.
#
#   2. a `GATE <surface>: PERMITTED` line present for EVERY required surface.
#      The documented contract is "proceed only when that line is present", and
#      an exit code alone cannot express it: a process that dies before printing
#      a verdict can still leave a passing-looking status behind. Absent line =
#      FAIL, whatever the exit code.
#
# GATE_REQUIRED_SURFACES below MUST mirror REQUIRED_SURFACES in
# src/scripts/checkRankEventsSurfaces.ts. They are two lists in two languages;
# if they drift, this gate silently stops checking a surface it believes it is
# checking. Migration 0202 added living_page and watch_feed to both.
# See the EXIT CODE CONTRACT in src/scripts/checkRankEventsSurfaces.ts.
GATE_REQUIRED_SURFACES=("live_pulse" "living_page" "watch_feed")

run_gate() {
  local label="$1"
  shift
  echo ""
  echo "──────────────────────────────────────────────────────────"
  echo "▶ RUNNING: $label"
  echo "──────────────────────────────────────────────────────────"
  local gate_log
  gate_log="$(mktemp)"
  # tee so the operator still sees the output live; PIPESTATUS[0] so the score
  # comes from the check, not from tee.
  "$@" 2>&1 | tee "$gate_log"
  local rc=${PIPESTATUS[0]}
  local verdict=1
  local missing=""
  local s
  for s in "${GATE_REQUIRED_SURFACES[@]}"; do
    if ! grep -qxF "GATE ${s}: PERMITTED" "$gate_log"; then
      verdict=0
      missing="${missing:+$missing, }$s"
    fi
  done
  rm -f "$gate_log"
  local required_desc="${GATE_REQUIRED_SURFACES[*]}"
  if [ "$rc" -eq 0 ] && [ "$verdict" -eq 1 ]; then
    echo "✔ PASSED: $label (exit 0, GATE PERMITTED for: ${required_desc})"
  elif [ "$rc" -eq 0 ]; then
    echo "✘ FAILED: $label (exit 0 but NO 'GATE <surface>: PERMITTED' line for:"
    echo "          ${missing} — the gate never reached a verdict for those"
    echo "          surfaces; an absent GATE line is a block)"
    FAILED=1
  elif [ "$rc" -eq 1 ]; then
    echo "✘ FAILED: $label (exit 1 — the script never chooses 1, so the process"
    echo "          died involuntarily and proved nothing; read the error above)"
    FAILED=1
  else
    echo "✘ FAILED: $label (exit $rc — deploy-blocking; read the GATE lines above)"
    FAILED=1
  fi
}

run_check "check:guard-coverage" pnpm run check:guard-coverage
# check:route-auth-gate — requireUser is the ONLY place the account ban/suspend
# gate is applied, and banning does not revoke sessions, so a route that verifies
# its own JWT accepts a banned user's still-valid token. Six mutating routes in
# trips.ts did exactly that. Structural rule: if a handler writes, it goes
# through requireUser.
# check:route-shadowing — Express matches in registration order, so a literal
# path registered after a parameterised one that fits it is never reached. The
# handler exists and typechecks; it is simply never called, and the caller gets
# whatever the parameterised handler does with a non-id. Silent by construction.
run_check "check:route-shadowing" pnpm run check:route-shadowing

run_check "check:route-auth-gate" pnpm run check:route-auth-gate
# check:flag-polarity — every feature flag is classified STOP/CAPABILITY/CONFIG
# and read through the reader that classification demands. Wired 2026-08-10
# after c89f09a7 converted eleven emergency stops that had been reading
# through isFlagEnabled, where a DB error returned false — "do not stop" —
# disengaging every one of them at the moment an operator would reach for it.
# The check exists so the TWELFTH stop cannot be added the same way: a new
# disable_* flag read through isFlagEnabled goes red, and so does any flag
# whose name matches neither convention until a human classifies it.
#
# It enforces that a classification EXISTS and MATCHES its reader. It does
# NOT enforce that the classification is RIGHT — that judgment stays human
# and is recorded in the script. Read its header before adding an exemption.
run_check "check:flag-polarity" pnpm run check:flag-polarity
run_check "check:frozen-dir" pnpm run check:frozen-dir
run_check "check:async-handlers" pnpm run check:async-handlers
run_check "check:migration-prefixes" pnpm run check:migration-prefixes
# check:not-null-writes — no write payload anywhere may put null in a NOT NULL
# column. Wired for the anonymise_profile step, which nulled profiles.handle (text
# NOT NULL UNIQUE), which made it raise 23502 on every run. That step is fatal, so
# deletion aborted AFTER the irreversible content steps had already succeeded:
# content destroyed, auth user and email retained, request left retrying forever.
# Widening it to the whole tree found three more of the same class.
# Static, so it needs no database and runs on every push.
# check:compiler-authentic — proves the resolved TypeScript compiler REJECTS a
# program it must reject. A tool that exits 0 on a type error is not a checker,
# and a green from it means nothing; this ran first in CI for that reason.
run_check "check:compiler-authentic" pnpm run check:compiler-authentic
run_check "check:not-null-writes" pnpm run check:not-null-writes
run_check "check:silent-supabase-writes" pnpm run check:silent-supabase-writes
run_check "check:test-runner-flags" pnpm run check:test-runner-flags
run_check "check:write-path-columns" pnpm run check:write-path-columns
run_check "check:missing-live-columns" pnpm run check:missing-live-columns
# check:authorization-contract — the client-write authorization regression guard:
# fails when a migration restores broad anon/authenticated mutation privileges,
# exposes a server-derived column to client writes, or adds an unapproved RLS
# policy on a protected table (2144-2154). Reads the live CI DB via the Mgmt API.
run_check "check:authorization-contract" pnpm run check:authorization-contract
# check:media-objects — WIRED 2026-08-10, and the delay was the point.
#
# It reconciles post_media rows against actual Storage objects, which is the one
# thing processing_status structurally cannot do: that column records what the
# pipeline BELIEVED happened and cannot see the bucket. On 2026-08-09 all 116
# rows read 'ready' while 114 pointed at objects that did not exist, on
# published public posts, rendering as broken images for three weeks with
# nothing anywhere flagging it.
#
# It was deliberately left unwired while it failed BY DESIGN — the seeded rows
# were real, so wiring it then would have meant a permanently-red check, and a
# permanently-red check is one `|| true` away from being no check at all. That
# is exactly how 'living_page' spent months silently dropping rows. 0206 removed
# the 14 polluted post_media rows and 0207 removed the 21 seed posts; it has
# passed since, so it is wired now with nothing suppressed.
#
# run_check, not run_gate: unlike check:rank-events-surfaces this script's exit
# code IS the whole verdict, so there is no second condition to enforce.
#   0 = every row has its object   1 = at least one dangling row (FAIL)
#   2 = no live credentials (FAIL, never a skip — an unrunnable reconciliation
#       must not read as a clean one)
# Orphan objects are reported but do NOT move the exit code: they are wasted
# storage rather than a broken image, and a sweep should be scheduled
# deliberately instead of triggered by a red build.
run_check "check:media-objects" pnpm run check:media-objects
run_gate  "check:rank-events-surfaces" pnpm run check:rank-events-surfaces

echo ""
echo "──────────────────────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  echo "✔ ALL CHECKS PASSED"
else
  echo "✘ ONE OR MORE CHECKS FAILED — see ✘ FAILED lines above"
fi
echo "──────────────────────────────────────────────────────────"

exit $FAILED
