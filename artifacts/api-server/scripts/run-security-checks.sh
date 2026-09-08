#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run-security-checks.sh — the SECURITY & PRIVACY subset of this tree's guards,
# in one entry point, with a true and ATTRIBUTABLE verdict.
#
# ── WHAT THIS RUNS ───────────────────────────────────────────────────────────
# The subset was picked from the `responsibility` field of every entry in
# src/scripts/guardRegistry.ts — not from filenames — keeping the guards whose
# stated job is one of: authorization, RLS / privilege boundaries, fail-closed
# reads and writes, deletion and data-rights coverage, location privacy,
# credential-guard coverage, client write boundaries. Each invocation below
# carries the one sentence that says why it is in this suite.
#
# ── THE EXIT-CODE CONTRACT, WHICH IS THE POINT OF THIS SCRIPT ────────────────
# It is the contract stated in the `run_gate` comment block of
# scripts/run-all-checks.sh, applied to every check here rather than to one:
#
#   1. EVERY CHECK RUNS TO COMPLETION regardless of earlier failures, so a
#      failure is attributable to a named check instead of being buried in one
#      undifferentiated log blob. `set -e` is deliberately NOT set.
#
#   2. THE STATUS COMES FROM THE CHECK, NEVER FROM A PIPE. Output is tee'd so an
#      operator still sees it live, and the score is read off ${PIPESTATUS[0]}.
#      `cmd | tee log` reports TEE's status — tee almost always succeeds, so a
#      suite that reads $? there reports "pass" for a check that died. Nothing in
#      this file ever decides a verdict from `| grep` or `| tail` either.
#
#   3. ONLY EXIT 0 IS A PASS. Every other code fails, INCLUDING codes a given
#      check does not currently emit, because an unrecognised code is an unknown
#      state and an unknown state is not a pass. Exit 1 from a script that never
#      chooses 1 means the process died involuntarily — an uncaught exception, an
#      unhandled rejection, a module-resolution or tsx/TypeScript load failure —
#      and a crash proves nothing.
#
#   4. A CHECK THAT CANNOT RUN FAILS; IT NEVER SKIPS. An unrunnable security
#      check must not read as a clean one. check:authorization-contract exits 2
#      when it has no live credentials: in a credential-less environment this
#      suite goes RED and says so, because "we could not check the authorization
#      boundary" and "the authorization boundary is intact" are different
#      sentences and only one of them is a pass.
#
#   5. WHERE THE EXIT CODE IS NOT THE WHOLE VERDICT, the extra condition is
#      enforced explicitly, exactly as run_gate does for check:rank-events-
#      surfaces. Several guards here report standing, informational findings that
#      deliberately do NOT move their exit code (the deletion backlog, the
#      fail-open ledger, the baselined dead catches) — for those, a process that
#      dies after printing nothing could still leave a passing-looking status
#      behind, so each declares `--require <ERE>` patterns that MUST appear in
#      its output. The patterns also assert NON-VACUITY (`[1-9][0-9]*` where a
#      count is printed): a checker that examined zero files and printed green is
#      the trap this repo has hit repeatedly.
#
#   6. INFORMATIONAL COUNTS ARE NEVER A VERDICT. The unenforced-guard section at
#      the end greps finding counts out of guards this suite does NOT gate. That
#      grep decides nothing; when it fails to match, the count is reported as
#      UNKNOWN and never as 0.
#
#   7. A GREEN IS REPRINTED WITH WHAT IT DOES NOT COVER. Several of these guards
#      are RATCHETS: they refuse a NEW defect while a large, decided-to-be-
#      standing backlog sits behind them and does not move the exit code.
#      "check:deletion-coverage passed" is a true sentence that a reader will
#      take to mean far more than it does — 225 of 248 user-keyed tables are
#      UNCLASSIFIED, meaning they survive account deletion and nobody has decided
#      whether they should (owner decision D6). So every such check declares
#      `--report-ere` patterns, and the lines they match are lifted verbatim into
#      a WHAT THESE GREENS DO NOT COVER section of the summary. Those lines are
#      DISCLOSURE, not verdict: they move nothing, and a pattern that matches
#      nothing is printed as UNKNOWN rather than dropped, because a disclosure
#      that silently disappears is worse than one that was never made.
#
# ── WHAT THIS SUITE REFUSES TO DO ────────────────────────────────────────────
# It does not gate a guard that would go permanently red. A permanently-red check
# is one `|| true` away from being no check at all — that is written down twice in
# this repo and is how the 'living_page' defect survived for months. The
# security-relevant guards that are unenforced today are therefore REPORTED BY
# NAME WITH THEIR CURRENT FINDING COUNT at the end of every run, so the gap is
# measured on every run rather than implied. A suite that prints "all passed"
# while privacy guards were never invoked is exactly the false green this exists
# to prevent.
#
# ── TEST SEAMS (nothing in CI sets these) ────────────────────────────────────
#   SECURITY_SUITE_CHECKS      path to a bash manifest sourced INSTEAD of the
#                              built-in check list. It calls security_check.
#   SECURITY_SUITE_UNENFORCED  path to a bash manifest sourced INSTEAD of the
#                              built-in unenforced list. It calls
#                              security_unenforced.
# They exist so the mutation suite (src/test/securityCheckSuite.test.ts) can
# reach the failure paths — which are otherwise unreachable while the real tree
# passes — and a checker whose failure paths cannot be reached cannot be proven.
# Either seam prints a FIXTURE MODE banner and stamps the summary, so a fixture
# run can never be mistaken for a real one.
#
# ── THIS SCRIPT'S OWN EXIT CODES ─────────────────────────────────────────────
#   0  every check ran and passed
#   1  at least one check FAILED (see the ✘ FAILED lines, each names its check)
#   2  the suite itself could not run correctly — a missing manifest, a malformed
#      entry, or zero checks executed. A suite that examines nothing must not
#      report success, so vacuity is a hard failure and not a quiet 0.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portava-security-checks.XXXXXX")"
cleanup() { rm -rf "$LOG_DIR"; }
trap cleanup EXIT

RAN=0
PASSED=0
FAILED=0
CONFIG_ERRORS=0
FAILED_LABELS=()
RAN_LABELS=()
RAN_GUARDS=()
UNENFORCED_LINES=()
UNENFORCED_NAMES=()
DISCLOSURES=()
UNENFORCED=0
FIXTURE_MODE=""

# The check whose output the registry cross-reference is read from. Informational
# only: it tells the operator which of the checks that just ran are declared
# MANUAL / not enforced by CI in src/scripts/guardRegistry.ts, so this suite
# cannot leave the impression that CI is doing what only this suite does.
REACHABILITY_LABEL="check:guard-reachability"

rule() { echo "──────────────────────────────────────────────────────────"; }

slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

config_error() {
  echo ""
  echo "✘ SUITE CONFIGURATION ERROR: $*"
  CONFIG_ERRORS=$((CONFIG_ERRORS + 1))
}

# security_check "label" [--guard PATH] [--codes TEXT] [--require ERE]... -- cmd...
#
#   --guard    the guard file this check runs, as it appears in guardRegistry.ts.
#              Used only for the registry cross-reference in the summary.
#   --codes    a human-readable exit-code map, printed when the check fails so
#              the operator can tell "found a defect" from "died on the way".
#   --require  an extended regular expression that MUST match a line of the
#              check's output. Repeatable. Absent line = FAIL, whatever the exit
#              code (contract rule 5).
#   --report-ere  an extended regular expression whose matching line is lifted
#              verbatim into the WHAT THESE GREENS DO NOT COVER section, so the
#              standing backlog behind a ratchet's green is stated on every run
#              (contract rule 7). Repeatable. DISCLOSURE ONLY: it never moves the
#              verdict, and a pattern that matches nothing prints as UNKNOWN.
security_check() {
  local label="${1:-}"
  shift || true
  if [ -z "$label" ]; then
    config_error "security_check called with no label"
    return
  fi

  local guard="" codes=""
  local requires=()
  local reports=()
  local cmd=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --guard)
        if [ $# -lt 2 ]; then config_error "$label: --guard needs a value"; return; fi
        guard="$2"; shift 2 ;;
      --codes)
        if [ $# -lt 2 ]; then config_error "$label: --codes needs a value"; return; fi
        codes="$2"; shift 2 ;;
      --require)
        if [ $# -lt 2 ]; then config_error "$label: --require needs a value"; return; fi
        requires+=("$2"); shift 2 ;;
      --report-ere)
        if [ $# -lt 2 ]; then config_error "$label: --report-ere needs a value"; return; fi
        reports+=("$2"); shift 2 ;;
      --)
        shift; cmd=("$@"); break ;;
      *)
        config_error "$label: unknown option '$1' (expected --guard/--codes/--require/--)"
        return ;;
    esac
  done

  if [ ${#cmd[@]} -eq 0 ]; then
    config_error "$label: no command given after --. A declared check that runs nothing is not a check."
    return
  fi

  echo ""
  rule
  echo "▶ RUNNING: $label"
  rule

  local log="$LOG_DIR/$(slug "$label").log"
  # tee so the operator sees it live; PIPESTATUS[0] so the score comes from the
  # CHECK and not from tee. Never `$?` here — that is tee's status.
  "${cmd[@]}" 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}

  local missing=()
  local re
  for re in ${requires[@]+"${requires[@]}"}; do
    grep -qE -- "$re" "$log" || missing+=("$re")
  done

  # Disclosure lines. Lifted verbatim from the check's own output; they decide
  # nothing. A pattern that matches nothing is reported as UNKNOWN rather than
  # dropped — a disclosure that quietly disappears is the false green again.
  local hit
  for re in ${reports[@]+"${reports[@]}"}; do
    hit="$(grep -m1 -E -- "$re" "$log" | sed 's/^[[:space:]]*//')"
    if [ -n "$hit" ]; then
      DISCLOSURES+=("$label: $hit")
    else
      DISCLOSURES+=("$label: UNKNOWN — no line matched /$re/ (UNKNOWN is not 'none')")
    fi
  done

  RAN=$((RAN + 1))
  RAN_LABELS+=("$label")
  RAN_GUARDS+=("$guard")

  if [ "$rc" -eq 0 ] && [ ${#missing[@]} -eq 0 ]; then
    PASSED=$((PASSED + 1))
    if [ ${#requires[@]} -eq 0 ]; then
      echo "✔ PASSED: $label (exit 0)"
    else
      echo "✔ PASSED: $label (exit 0, ${#requires[@]} required verdict line(s) present)"
    fi
    return
  fi

  FAILED=$((FAILED + 1))
  FAILED_LABELS+=("$label")
  if [ "$rc" -eq 0 ]; then
    echo "✘ FAILED: $label (exit 0 but a REQUIRED verdict line is absent — the check"
    echo "          never reached a verdict, and an absent verdict is not a pass)"
    for re in "${missing[@]}"; do
      echo "          missing: /$re/"
    done
  elif [ "$rc" -eq 127 ]; then
    echo "✘ FAILED: $label (exit 127 — the check COULD NOT RUN: command not found."
    echo "          An unrunnable security check must never read as a clean one)"
  else
    echo "✘ FAILED: $label (exit $rc — only exit 0 is a pass; every other code,"
    echo "          including one this check does not document, is an unknown"
    echo "          state, and an unknown state is not a pass)"
  fi
  if [ -n "$codes" ]; then
    echo "          declared exit codes: $codes"
  fi
}

# security_unenforced "guard/path.ts" "one line: what it protects and why it is
#                     not gated" [--count-ere ERE] [--needs-credentials] -- cmd...
#
# REPORTED, NOT GATED. These are security-relevant guards that this suite
# deliberately does not run as gates — because they are red today, or because
# they read live project state CI cannot see. Their findings are counted here so
# the gap is measured on every run; nothing they do moves this suite's exit code.
# The count is extracted with grep, which is legitimate precisely because it
# decides nothing: no match means UNKNOWN, never 0.
security_unenforced() {
  local guard="${1:-}" why="${2:-}"
  shift 2 || true
  if [ -z "$guard" ] || [ -z "$why" ]; then
    config_error "security_unenforced needs a guard path and a reason"
    return
  fi

  local count_ere="" needs_creds=0
  local cmd=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --count-ere)
        if [ $# -lt 2 ]; then config_error "$guard: --count-ere needs a value"; return; fi
        count_ere="$2"; shift 2 ;;
      --needs-credentials) needs_creds=1; shift ;;
      --) shift; cmd=("$@"); break ;;
      *) config_error "$guard: unknown option '$1'"; return ;;
    esac
  done

  if [ ${#cmd[@]} -eq 0 ]; then
    config_error "$guard: no command given after --"
    return
  fi

  local log="$LOG_DIR/unenforced.$(slug "$guard").log"
  "${cmd[@]}" >"$log" 2>&1
  local rc=$?

  local count="UNKNOWN"
  if [ -n "$count_ere" ]; then
    local n
    n="$(grep -oE -- "$count_ere" "$log" | head -1 | grep -oE '[0-9]+' | head -1)"
    [ -n "$n" ] && count="$n"
  fi
  local detail
  if [ "$count" = "UNKNOWN" ]; then
    if [ "$needs_creds" -eq 1 ]; then
      detail="findings UNKNOWN — needs live credentials this environment does not have (exit $rc)"
    else
      detail="findings UNKNOWN — its output did not yield a count (exit $rc). UNKNOWN is not 0."
    fi
  else
    detail="$count standing finding(s) (exit $rc)"
  fi

  UNENFORCED=$((UNENFORCED + 1))
  UNENFORCED_NAMES+=("$guard")
  UNENFORCED_LINES+=("$guard — $detail")
  UNENFORCED_LINES+=("    $why")

  echo ""
  echo "  ● NOT GATED: $guard"
  echo "      $detail"
  echo "      $why"
}

# ── the security & privacy check list ────────────────────────────────────────
default_checks() {
  # The guard over the guards. In a security suite its verdict is the suite's own
  # premise: a security guard that quietly stopped being reached by anything is
  # indistinguishable from one that is passing. Its MANUAL rows are also what the
  # registry cross-reference below is read from.
  security_check "$REACHABILITY_LABEL" \
    --guard "src/scripts/checkGuardReachability.ts" \
    --codes "0 = every declaration verifies; 1 = a declaration is false or a guard is unregistered" \
    --require '^check:guard-reachability — [1-9][0-9]* guard\(s\) on disk' \
    --require '^✅ every guard on disk is registered and its reach declaration verifies\.' \
    -- pnpm run check:guard-reachability

  # CREDENTIAL-GUARD COVERAGE: every file that can reach Supabase directly either
  # imports a CI guard front door or carries a written exemption. This is the
  # closure property that keeps service-role credentials from reaching a new file
  # unnoticed.
  security_check "check:guard-coverage" \
    --guard "scripts/check-guard-coverage.mjs" \
    --codes "0 = every Supabase-reaching file accounted for; 1 = an unaccounted file" \
    --require '^All [1-9][0-9]* Supabase-reaching file\(s\) accounted for' \
    --report-ere '^All [0-9]+ Supabase-reaching file\(s\) accounted for.*exempt with a reason\.$' \
    -- pnpm run check:guard-coverage

  # AUTHORIZATION: requireUser is the only place the account ban/suspend gate is
  # applied, and banning does not revoke sessions — a handler that verifies its
  # own JWT accepts a banned user's still-valid token.
  security_check "check:route-auth-gate" \
    --guard "scripts/check-route-auth-gate.mjs" \
    --codes "0 = every state-changing handler goes through requireUser; 1 = one does not" \
    --require '^check:route-auth-gate — [1-9][0-9]* route files scanned; no state-changing handler verifies its own JWT\.' \
    -- pnpm run check:route-auth-gate

  # CLIENT WRITE BOUNDARY + RLS: no migration restores broad anon/authenticated
  # mutation privileges, exposes a server-derived column to client writes, or adds
  # an unapproved RLS policy.
  #
  # It reads the live CI database, so in a credential-less environment it exits 2
  # and THIS SUITE GOES RED. That is the intended behaviour and the whole of
  # contract rule 4: an unverified authorization boundary is not a verified one.
  # The required line also refuses a vacuous pass over zero protected tables.
  security_check "check:authorization-contract" \
    --guard "src/scripts/checkAuthorizationContract.ts" \
    --codes "0 = contract holds; 1 = drift found; 2 = CANNOT RUN (missing creds) — a failure, never a skip" \
    --require '^check:authorization-contract PASSED — [1-9][0-9]* protected tables match the approved boundary' \
    -- pnpm run check:authorization-contract

  # PRIVILEGE BOUNDARY: no migration grants a client role a privilege RLS cannot
  # police — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN. RLS filters rows; it does
  # not filter these, so a grant here is a boundary RLS was never going to hold.
  security_check "check:client-privilege-boundary" \
    --guard "src/scripts/checkClientPrivilegeBoundary.ts" \
    --codes "0 = no unpoliceable grant; non-zero = a grant RLS cannot police" \
    --require '^check:client-privilege-boundary — [1-9][0-9]* migration file\(s\), [1-9][0-9]* GRANT statement\(s\) examined' \
    --require '^✅ no migration grants a client role a privilege RLS cannot police\.' \
    -- node --import tsx/esm src/scripts/checkClientPrivilegeBoundary.ts

  # FAIL-CLOSED READS: a read that discards its .error is turned by supabase-js
  # into an empty result on a database failure — which on an authorization or
  # blocklist read means "no restrictions found", i.e. it fails OPEN.
  # Its ledger of known defects is informational and does not move its exit code,
  # so the verdict line is required explicitly, with non-vacuous scan counts.
  security_check "check:unchecked-supabase-reads" \
    --guard "src/scripts/checkUncheckedSupabaseReads.ts" \
    --codes "0 = no NEW unchecked read; non-zero = a new read discards its .error" \
    --require '^✅ check-unchecked-supabase-reads: no NEW in-scope read ignores its \.error\. scanned [1-9][0-9]* file\(s\); judged [1-9][0-9]* read site\(s\)' \
    --report-ere '[0-9]+ ledgered known defects: [0-9]+ FAIL-OPEN' \
    -- node --import tsx/esm src/scripts/checkUncheckedSupabaseReads.ts

  # FAIL-CLOSED WRITES: the write-side twin — a mutation whose error is swallowed
  # reports success for a write that did not happen. Baselined sites are
  # informational, so the verdict line is required explicitly.
  security_check "check:silent-supabase-writes" \
    --guard "src/scripts/checkSilentSupabaseWrites.ts" \
    --codes "0 = no NEW dead catch; non-zero = a new mutation discards its error" \
    --require '^✅ check-silent-supabase-writes: no NEW dead catch around a resolving PostgREST write' \
    --report-ere '[0-9]+ pre-existing site\(s\) baselined for burn-down' \
    -- pnpm run check:silent-supabase-writes

  # FAIL-CLOSED SAFETY CONTROLS: every flag is classified STOP/CAPABILITY/CONFIG
  # and read through the reader that classification demands. Eleven emergency
  # stops once read through isFlagEnabled, where a DB error returns false — "do
  # not stop" — disengaging every one of them at the moment an operator reaches
  # for it. A STOP flag that fails open is a safety control that is not there.
  security_check "check:flag-polarity" \
    --guard "scripts/check-flag-polarity.mjs" \
    --codes "0 = every flag classified and read correctly; 1 = a stop read through a fail-open reader" \
    --require '^✓ check-flag-polarity: [1-9][0-9]* flags classified' \
    -- pnpm run check:flag-polarity

  # DELETION COVERAGE — a legal-surface guarantee: a new user-keyed table cannot
  # be added without someone writing down what happens to it when a user deletes
  # their account.
  #
  # guardRegistry.ts declared this MANUAL on the grounds that it "carries standing
  # findings" and wiring it would make check:all permanently red. MEASURED, THAT
  # REASON IS FALSE: it exits 0 today, and the registry owner is correcting the
  # entry to check-all. What is true is that it is a RATCHET — it refuses a NEW
  # unclassified table while 225 of 248 existing user-keyed tables sit in
  # UNCLASSIFIED_BACKLOG, surviving account deletion with nobody having decided
  # whether they should (owner decision D6). That backlog does not move its exit
  # code, so "check:deletion-coverage passed" says far less than it sounds like:
  # the --report-ere lines below reprint the count in the summary on every run.
  # It is an OWNER decision and this suite does not attempt to resolve it.
  security_check "check:deletion-coverage" \
    --guard "src/scripts/checkDeletionCoverage.ts" \
    --codes "0 = every baseline user-keyed table has a stated deletion fate; 1 = one does not" \
    --require '^check-deletion-coverage: [1-9][0-9]* user-keyed table\(s\) in the baseline' \
    --require '^✓ every user-keyed table in the baseline has a stated deletion fate\.' \
    --report-ere '^[[:space:]]*[0-9]+ UNCLASSIFIED — survive deletion' \
    --report-ere '^check-deletion-coverage: [0-9]+ user-keyed table\(s\) in the baseline' \
    -- pnpm run check:deletion-coverage

  # DATA RIGHTS: every intel column has a stated ownership class, so no personal
  # data column exists with no declared retention/erasure route. Same shape as
  # deletion coverage — the registry's "standing findings" reason was false, it is
  # green today, and it is a ratchet: the green means every column is CLASSIFIED,
  # not that none of them is sensitive. 26 of the 74 carry or could reconstruct
  # personal data; that count is reprinted in the summary.
  security_check "check:data-rights" \
    --guard "src/scripts/checkDataRights.ts" \
    --codes "0 = every intel column classified; 1 = an unclassified column" \
    --require '^check-data-rights: [1-9][0-9]* intel field\(s\) classified' \
    --require '^✓ every intel column has a stated ownership class\.' \
    --report-ere '^[[:space:]]*[0-9]+ carry or could reconstruct personal data' \
    -- pnpm run check:data-rights

  # LOCATION PRIVACY: every coordinate-holding table is claimed by a documented
  # purpose. Green today, and gated here as a ratchet — a NEW coordinate-holding
  # table with no purpose fails. Nothing here encodes a guess at the open
  # LOCATION_PRECISION_DEFAULT owner decision: the check enforces only that a
  # purpose is STATED, and the summary reprints how many tables process precise
  # location and how many still need a separate user control, so the green is not
  # read as "location handling is settled".
  security_check "check:location-purposes" \
    --guard "src/scripts/checkLocationPurposes.ts" \
    --codes "0 = every coordinate table has a documented purpose; 1 = one does not" \
    --require '^check-location-purposes: [1-9][0-9]* table\(s\) hold coordinates in the baseline' \
    --require '^✓ every coordinate-holding table is claimed by a documented purpose\.' \
    --report-ere '^[[:space:]]*[0-9]+ process PRECISE location' \
    --report-ere '^[[:space:]]*[0-9]+ require a separate user control' \
    --report-ere '^[[:space:]]*[0-9]+ have an UNDECIDED retention window' \
    -- pnpm run check:location-purposes
}

# ── security-relevant guards this suite does NOT gate ────────────────────────
# Measured, not implied. Each is named with its current finding count on every
# run. None of them moves the exit code: gating a permanently-red guard is one
# `|| true` away from being no guard at all.
default_unenforced() {
  security_unenforced \
    "src/scripts/checkAdminGuard.ts" \
    "Admin route privilege checks re-implemented per file — authorisation drift. RED TODAY, so gating it would make this suite permanently red; wiring needs the findings fixed first (route files, other lanes' territory)." \
    --count-ere 'FAILED — [0-9]+ locally declared admin guard' \
    -- node --import tsx/esm src/scripts/checkAdminGuard.ts

  security_unenforced \
    "src/scripts/check-media-bucket-privacy.ts" \
    "Storage buckets whose public/private flag disagrees with the media privacy contract. Reads live project state; no CI run can observe the project it matters for. EXEMPT MEANS UNENFORCED, NOT SAFE." \
    --needs-credentials \
    --count-ere 'bucket\(s\) disagree|[0-9]+ mismatch' \
    -- node --import tsx/esm src/scripts/check-media-bucket-privacy.ts

  # Its credential guard (ciProdReadOnlyAuditGuard) refuses a non-sanctioned
  # target, so outside the credentialed job its verdict is UNAVAILABLE. Reported
  # here rather than gated: an unavailable verdict is not a clean one, and saying
  # so out loud is the whole point of this section.
  security_unenforced \
    "src/scripts/checkMediaUrlsExternalOnly.ts" \
    "Media URLs built against an INTERNAL host — a client-unreachable URL, and an internal hostname disclosed to clients. Verdict UNAVAILABLE without a sanctioned live target; unavailable is not clean." \
    --needs-credentials \
    --count-ere '[0-9]+ internal (host|url)' \
    -- pnpm run check:media-urls-external-only

  security_unenforced \
    "src/scripts/checkDiscoveryCacheKeys.ts" \
    "Discovery cache keys whose shape would collide or LEAK ACROSS VIEWERS. Needs a live database with real cache rows; in CI it would examine nothing and print green." \
    --needs-credentials \
    --count-ere '[0-9]+ (leaky|colliding|unsafe) key' \
    -- node --import tsx/esm src/scripts/checkDiscoveryCacheKeys.ts
}

# ── run ──────────────────────────────────────────────────────────────────────
echo ""
rule
echo "▶ PORTAVA SECURITY & PRIVACY CHECK SUITE"
rule

if [ -n "${SECURITY_SUITE_CHECKS:-}" ] || [ -n "${SECURITY_SUITE_UNENFORCED:-}" ]; then
  FIXTURE_MODE="yes"
  echo ""
  echo "!! FIXTURE MODE — the check list has been overridden by a test seam."
  echo "!! SECURITY_SUITE_CHECKS=${SECURITY_SUITE_CHECKS:-<unset>}"
  echo "!! SECURITY_SUITE_UNENFORCED=${SECURITY_SUITE_UNENFORCED:-<unset>}"
  echo "!! THIS IS NOT A REAL SECURITY RUN. Nothing in CI sets these."
fi

if [ -n "${SECURITY_SUITE_CHECKS:-}" ]; then
  if [ ! -f "$SECURITY_SUITE_CHECKS" ]; then
    config_error "SECURITY_SUITE_CHECKS=$SECURITY_SUITE_CHECKS does not exist"
  else
    # shellcheck disable=SC1090
    source "$SECURITY_SUITE_CHECKS"
  fi
else
  default_checks
fi

echo ""
rule
echo "▶ SECURITY-RELEVANT GUARDS THIS SUITE DOES NOT GATE"
rule

if [ -n "${SECURITY_SUITE_UNENFORCED:-}" ]; then
  if [ ! -f "$SECURITY_SUITE_UNENFORCED" ]; then
    config_error "SECURITY_SUITE_UNENFORCED=$SECURITY_SUITE_UNENFORCED does not exist"
  else
    # shellcheck disable=SC1090
    source "$SECURITY_SUITE_UNENFORCED"
  fi
else
  default_unenforced
fi

# ── registry cross-reference (informational) ─────────────────────────────────
# Which of the checks that just ran are declared MANUAL / not enforced by CI in
# src/scripts/guardRegistry.ts? Read out of check:guard-reachability's own output
# rather than hardcoded, so it cannot go stale. It decides nothing.
MANUAL_RAN=()
REGISTRY_NOTE="registry cross-reference UNAVAILABLE — ${REACHABILITY_LABEL} produced no per-guard rows (it fails before printing them). NOT a statement that nothing is unenforced."
REACH_LOG="$LOG_DIR/$(slug "$REACHABILITY_LABEL").log"
# The ROW form, not the word: a failing run still prints the headline
# "(9 MANUAL / not enforced)" while printing no rows at all, and matching that
# would report "0 of 11 are MANUAL" — a false all-clear on the honesty line
# itself. No rows means UNAVAILABLE, never zero.
if [ -s "$REACH_LOG" ] && grep -qE "MANUAL[[:space:]]+not enforced by CI" "$REACH_LOG"; then
  i=0
  while [ "$i" -lt ${#RAN_LABELS[@]} ]; do
    g="${RAN_GUARDS[$i]}"
    if [ -n "$g" ] && grep -qE "^[[:space:]]*${g//./\\.}[[:space:]]+MANUAL" "$REACH_LOG"; then
      MANUAL_RAN+=("${RAN_LABELS[$i]}")
    fi
    i=$((i + 1))
  done
  REGISTRY_NOTE="${#MANUAL_RAN[@]} of the ${RAN} check(s) above are declared MANUAL / NOT ENFORCED BY CI in guardRegistry.ts"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
rule
echo "▶ SECURITY & PRIVACY SUITE SUMMARY"
rule
echo "  checks run:        $RAN"
echo "  passed:            $PASSED"
echo "  failed:            $FAILED"
for l in ${FAILED_LABELS[@]+"${FAILED_LABELS[@]}"}; do
  echo "                       ✘ $l"
done
echo ""
echo "  NOT RUN AS A GATE: $UNENFORCED security-relevant guard(s) are UNENFORCED."
echo "                     Nothing anywhere fails when these fail. Their counts are"
echo "                     measured below so the gap is not merely implied:"
for l in ${UNENFORCED_LINES[@]+"${UNENFORCED_LINES[@]}"}; do
  echo "                     $l"
done
echo ""
echo "  WHAT THESE GREENS DO NOT COVER — lifted from the checks' own output. Every"
echo "  line below is DISCLOSURE, not verdict: each of these checks is a ratchet"
echo "  that refuses a NEW defect while a standing, decided-to-be-standing backlog"
echo "  sits behind it and moves nothing:"
if [ ${#DISCLOSURES[@]} -eq 0 ]; then
  echo "                     (none declared)"
fi
for l in ${DISCLOSURES[@]+"${DISCLOSURES[@]}"}; do
  echo "                     $l"
done

echo ""
echo "  $REGISTRY_NOTE"
for l in ${MANUAL_RAN[@]+"${MANUAL_RAN[@]}"}; do
  echo "                       • $l — enforced by THIS suite only, and only where this suite runs"
done
if [ -n "$FIXTURE_MODE" ]; then
  echo ""
  echo "  !! FIXTURE MODE WAS ACTIVE — this was not a real security run."
fi
rule

if [ "$CONFIG_ERRORS" -gt 0 ]; then
  echo "✘ SUITE COULD NOT RUN CORRECTLY — $CONFIG_ERRORS configuration error(s) above."
  rule
  exit 2
fi

if [ "$RAN" -eq 0 ]; then
  echo "✘ VACUOUS — 0 checks executed. A suite that examines nothing must not report"
  echo "  success, so this is a hard failure rather than a quiet pass."
  rule
  exit 2
fi

if [ "$FAILED" -eq 0 ]; then
  echo "✔ ALL $RAN SECURITY CHECK(S) PASSED — with $UNENFORCED security-relevant"
  echo "  guard(s) still unenforced, listed above. This is not a clean bill."
  rule
  exit 0
fi

echo "✘ $FAILED of $RAN SECURITY CHECK(S) FAILED — see the ✘ FAILED lines above;"
echo "  each names the check it belongs to."
rule
exit 1
