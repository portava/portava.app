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
# check:guard-reachability — the guard OVER the guards. A checker nobody runs is
# decorative architecture: the same defect check:projection-consumers catches for
# data pipes (a producer, a table, no consumer), one level up. It was not
# hypothetical — check:unchecked-supabase-reads, the fail-open ledger and the
# largest guard here, is reached by NOTHING: its mutation suite spawns it only
# with UNCHECKED_READS_SRC_ROOT / UNCHECKED_READS_ALLOWLIST pointed at scratch
# trees, so a new unchecked .error added to the real tree fails no check anywhere
# and the 306 -> 0 burn-down it records is protected by nothing.
#
# Every check*.ts / check*.mjs on disk must DECLARE how it is reached
# (src/scripts/guardRegistry.ts) and this verifies the declaration: check:all
# invocation, a live workflow line, a delegating gate, the production build, a
# registered mutation suite with a REAL-TREE control, or a written statement that
# CI cannot invoke it. Ten currently declare the last of those. That number is
# printed on every run so the unenforced set is measured rather than implied.
run_check "check:guard-reachability" pnpm run check:guard-reachability
# check:route-auth-gate — requireUser is the ONLY place the account ban/suspend
# gate is applied, and banning does not revoke sessions, so a route that verifies
# its own JWT accepts a banned user's still-valid token. Six mutating routes in
# trips.ts did exactly that. Structural rule: if a handler writes, it goes
# through requireUser.
run_check "check:route-auth-gate" pnpm run check:route-auth-gate
# check:admin-guard — every admin-gated handler goes through lib/requireAdmin
# rather than declaring its own role check. It sat MANUAL and unenforced with the
# note "superseded in CI by check:route-auth-gate", which was not true: that check
# enforces the weaker, broader rule (a WRITING handler goes through requireUser)
# and says nothing about who counts as an admin. Nine route files carried their own
# guard; the burn-down routed all nine onto the shared one, preserving two
# deliberate divergences rather than flattening them — rentABuddyRollout still
# admits 'owner', and adminVisuals still requires ai_visual_admin_review_enabled on
# top of the role.
run_check "check:admin-guard" pnpm run check:admin-guard
# check:security-definer-oracles — a SECURITY DEFINER function in `public` that
# nothing in the database references is an authorization answer served over
# PostgREST as POST /rpc/<name>, with EXECUTE granted to anon and authenticated
# by Supabase's default privileges. migration 2533 dropped public.shares_trip_with
# for exactly that shape; this is the check that catches the next one in the diff.
# The remedy it asks for is a DROP, never a REVOKE: revoking EXECUTE on a definer
# function that an RLS policy calls makes the policy itself raise "permission
# denied for function" for every end-user token, measured on CI for both
# `language sql` and `language plpgsql` before the guard was written.
run_check "check:security-definer-oracles" pnpm run check:security-definer-oracles
# check:census-integrity — the thirteen docs/architecture/census-*.md files are
# the only per-architecture measurement this repo has, and their headlines are
# what a reader uses to decide where to spend a month. Three of the thirteen
# already carry a correction header saying the headline had drifted from the
# table beneath it. This recomputes what is machine-readable, takes the LAST
# statement of a revised row, and prints per census how many requirements are
# counted in prose where no tool can read them — so it is visible how much of
# each headline rests on something checkable.
run_check "check:census-integrity" pnpm run check:census-integrity
# check:census-freshness — a census that has gone stale must not be quotable as
# current truth. Two of them sat at numbers measured hundreds of commits earlier
# and were read as present-tense fact; re-measured, one moved up and one moved
# DOWN on correctness. Path-scoped: a README edit must not age a census, because
# a guard that cries stale on every commit gets switched off and then the real
# staleness comes back.
run_check "check:census-freshness" pnpm run check:census-freshness
# check:census-policy-citations — a census that cites an RLS policy must cite the
# migration that CURRENTLY defines it. census-trips made the mistake twice in one
# sitting: it read route_plans' owner-only policy and stopped three lines short
# of the member policy beside it, concluding a trip's crew cannot read the trip's
# own route chain — a claim that shipped, as the reason string on a projection
# layer served as `no_source`. Correcting it, it re-read the same 2016-era file
# and never opened the 2334 migration that had already replaced all three
# policies over authz.is_trip_crew. RLS policies are a UNION and a schema claim
# is a claim about the END of the chain; this checks the citation, not the
# sentence.
# check:census-scope-coverage — a census must WATCH the files it CITES.
# check:census-freshness asks whether anything a census counts has changed, and
# what it counts is declared by hand in CENSUS_SCOPE. Nothing checked that
# declaration against the census. Measured 2026-09-11: census-trips cited 49
# files with 10 in scope, and the scope covered the Trip Kernel programme — so
# it watched the W rows, the ones saying something is NOT right, and left the C
# rows unguarded. A W row that rots stays wrong; a C row that rots becomes a
# false assurance, and census-freshness reported FRESH throughout, truthfully,
# about the wrong half. The inversion is not a Trips quirk: no census watches
# even three quarters of what it cites, and the median is under a third.
# Per-census floors are a ratchet — raise one when you widen a scope; lowering
# one to get green is the single response that is never right.
run_check "check:census-scope-coverage" pnpm run check:census-scope-coverage
# check:census-row-move-labels — a census revises a verdict by RESTATING the row
# in a later "Row moves" section, labelled with the object it is about. When the
# label and the id name different objects, the id wins (every count uses it) and
# the wrong requirement moves. census-trips §29.4 did exactly that: its last two
# rows read TR89 `trip_snapshots` and TR90 `trip_outcomes` while the body assigns
# TR89 `trip_events`, TR90 `trip_snapshots`, TR91 `trip_outcomes`. TR89 was
# already W so the move was a no-op, TR90 was accidentally right, and TR91 —
# never moved — kept NOT-BUILT with the evidence "Does not exist." while CREATE
# TABLE public.trip_outcomes sat in a merged migration. §39 moved it.
# The rule is deliberately narrow: a label that REFINES (a table behind a type,
# a column, a key) is normal and three in the corpus do it. Only a label naming
# ANOTHER row's object in the SAME id sequence fails.
run_check "check:census-row-move-labels" pnpm run check:census-row-move-labels
# check:trip-policy-callsites — Trips spec §6.1 "application code calls policy
# functions rather than scattering host checks", as a ratchet. Measured
# 2026-09-12: the trip route files carried 46 inline owner/host checks, each a
# copy of a rule that lived nowhere else and could be tested only through a
# route. lib/tripPolicy.ts now names the nine §6.1 functions; this check fails
# when a route file's inline count GROWS or a new file gains one, and when a
# §6.1 function has no call site outside the policy module — a policy nobody
# calls is a library, not a capability.
run_check "check:trip-policy-callsites" pnpm run check:trip-policy-callsites
# check:place-id-bridge — census-trips TR32/TR94 said the single place id-space
# crossing was "Enforced by a standing ratchet rather than convention", naming
# check:schema-references as that ratchet. It is not: that check verifies a
# select-list column exists on the table being read, and says nothing about id
# spaces. No file under src/scripts/ or scripts/ mentioned placeIdBridge at all.
# The verdict was true and its stated reason was false. This is the ratchet, so
# the reason is now true: the Discovery serve path emits three id spaces while
# place memory is keyed on discovery_places.id, and crossing without the bridge
# reports EVERY place as new to the user — silent and confident, not an error.
run_check "check:place-id-bridge" pnpm run check:place-id-bridge
# check:trip-write-validation — census-trips TR51 ("Command service validates
# schema") was C, and the row's own testable half is the sentence "every trip
# write parses a zod schema first". Measured 2026-09-11 across the three files it
# cites: 53 write endpoints, 8 reading req.body with NO schema — POST /trips, the
# primary create, among them. TR51 moved C -> W. Shrink-only baseline, same idiom
# as the RLS allowlists: fix one and delete its line, because an entry left in
# after it stops being true goes on excusing the next. Not about authorization —
# that is check:route-auth-gate's job and is enforced independently.
run_check "check:trip-write-validation" pnpm run check:trip-write-validation
# check:trip-push-policy — census-trips TR200 ("Trip events must pass an attention
# policy") read C because NotificationRouter consults preferences, dedup and the
# Compass evaluator. It does. Measured 2026-09-11: TEN trip push sites do not go
# through it — they call sendPushWithRetry, a pure transport wrapper that filters
# tokens and retries, consulting nothing. One says so in a comment. That skips
# per-user channel preferences, per-category preferences and QUIET HOURS, so a
# user who switched a category off still gets all ten. TR200 moved C -> W.
# Shrink-only, and keyed on file:line rather than a count, because a bare total
# stays green across a substitution.
run_check "check:trip-push-policy" pnpm run check:trip-push-policy
run_check "check:census-policy-citations" pnpm run check:census-policy-citations
# check:memory-table-ownership — public.memory_events (the Memory projection
# family's log, live in production and read by the account-deletion cascade) and
# public.memory_domain_events (the Highlights/Memories spec §17 command log, not
# applied) share a prefix and nothing else. Migration 2710 was written to call
# the second one memory_events; with CREATE TABLE IF NOT EXISTS that would not
# have created it and would not have complained, and the command kernel would
# have written domain events into the projection family's table. Every reference
# is classified here, and no object name may straddle the two.
run_check "check:memory-table-ownership" pnpm run check:memory-table-ownership
# check:trust-table-ownership — services/trust owns every read of trust_profiles,
# trust_caps and trust_restrictions. Two docblocks in the tree already said so and
# nothing enforced it: census-trust measured eleven direct reads outside the
# service (A17) and one in an admin route (C15). Three of those could not have
# complied — the seam was per-user where they needed a batch, boolean where they
# needed rows, fail-soft where they needed fail-closed — so the seam was widened
# and this checker keeps the next caller from reaching past it instead.
run_check "check:trust-table-ownership" pnpm run check:trust-table-ownership
# check:trust-event-vocabulary — TRUST_EVENT_TYPES declares every trust event's
# category, delta and severity and calls itself "all event types by source
# system". census-trust C32 measured what that was worth: nineteen types emitted
# that it did not contain, and one emitter awarding 5 where it declared 4 — a
# user's trust moving by a number the system did not say it moved by. It is a
# contract now, and this is what makes it one.
run_check "check:trust-event-vocabulary" pnpm run check:trust-event-vocabulary
# check:production-drift — every table src/migrations declares, checked against a
# committed snapshot of production's public schema. Offline and credential-free by
# construction: CI holds no production secret and must not. It was registered as a
# MANUAL guard on the belief that it reads production live; it does not, and while
# it was failing nobody noticed the claim was untested. Two of its findings on
# 2026-09-08 were false for a reason worth stating here — the snapshot predates
# migrations we applied ourselves — which the checker now excuses from the applied
# ledger rather than reporting as missing storage.
run_check "check:production-drift" pnpm run check:production-drift
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
# The three privacy / legal-surface checks. They were sitting on disk, each with
# a package script, invoked by NOTHING — and the guard registry recorded them as
# unwired "because they carry standing findings and wiring them would make
# check:all permanently red". That reason was written from their headers rather
# than from running them, and it was false: all three exit 0 on this tree.
#
# READ WHAT THEIR GREEN COVERS BEFORE TRUSTING IT. check:deletion-coverage passes
# while reporting 225 of 248 user-keyed tables as UNCLASSIFIED — "survive
# deletion, undecided, owner decision D6". What it enforces is that every table
# has a STATED FATE, not that the fate is erasure. That is the honest contract,
# and it is worth more wired than not: it is what stops a NEW user-keyed table
# from arriving with no stated fate at all.
run_check "check:deletion-coverage" pnpm run check:deletion-coverage
run_check "check:data-rights" pnpm run check:data-rights
run_check "check:location-purposes" pnpm run check:location-purposes
run_check "check:silent-supabase-writes" pnpm run check:silent-supabase-writes
# check:unissued-supabase-writes — the third member of this family, and the one
# no test could have caught. check:unchecked-supabase-reads catches a read whose
# error is discarded; check:silent-supabase-writes catches a write whose error is
# discarded; this catches a write that is NEVER SENT.
#
# PostgrestBuilder is a thenable: it calls _fetch inside then(). So
# `void sc.from(t).insert({...})` with no .then/.catch/await builds a request
# object and discards it — measured, 0 HTTP calls against a counting fetch. Twenty
# such sites existed: essentially the whole Rent-A-Buddy booking audit trail, post
# edit history, the stamp reconciliation log and a delayed-location event.
#
# A fake CANNOT see this, and one in this suite was written around it, capturing
# rows eagerly inside .insert() with a comment noting that _resolve() is never
# reached. The only witness that tells "constructed" from "sent" is the real
# client, which is exactly what a suite replaces — hence a static check.
run_check "check:unissued-supabase-writes" pnpm run check:unissued-supabase-writes
run_check "check:trip-kernel-writers" pnpm run check:trip-kernel-writers
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
