#!/usr/bin/env bash
#
# live-db-acquire-slot.sh — WAIT for the shared database, do not evict for it.
#
# THE PROBLEM THIS REPLACES
# -------------------------
# live-db.yml used to serialize with a GLOBAL GitHub concurrency group:
#
#     concurrency:
#       group: live-db-shared-supabase-project
#       cancel-in-progress: false
#
# GitHub concurrency does not queue. It keeps at most ONE in-progress run and
# ONE pending run per group; a third arrival EVICTS the pending one. Because the
# group was global, that eviction crossed branches — a push to branch B
# cancelled branch A's pending certification.
#
# Measured over 100 runs before this change: 64 cancelled, 12 successful, and
# 45% of commits received NO live-DB verdict at all. That is not a performance
# problem. A commit with no verdict is indistinguishable, to anything reading
# GitHub's check list, from a commit that passed — which is how `places.country`
# reached main.
#
# WHAT THIS DOES INSTEAD
# ----------------------
# Concurrency is now keyed per PR (so a newer commit supersedes only its OWN
# obsolete run, never someone else's), and mutual exclusion on the database is
# enforced HERE, by waiting rather than cancelling:
#
#   - List every in-progress run of this workflow.
#   - If this run is the OLDEST of them, the slot is ours; proceed.
#   - Otherwise sleep and re-check.
#
# The decision itself lives in live-db-slot-decide.sh, which takes the listing
# on stdin and no network, so it can be — and is — unit tested.
#
# "Oldest wins" is a total order over a set that only shrinks, so exactly one
# waiter can ever be eligible and the queue cannot deadlock. A run cancelled or
# finished while holding the slot simply leaves the set, and the next oldest
# proceeds.
#
# ─────────────────────────────────────────────────────────────────────────────
# TWO ROLES, ONE IMPLEMENTATION (LIVE_DB_SLOT_ROLE)
# ─────────────────────────────────────────────────────────────────────────────
#
# THE DEFECT THIS SPLIT CLOSES, MEASURED 2026-09-05.
#
# `gh run rerun --failed` re-runs only the jobs that FAILED. The
# `live DB · acquire the shared-database slot` job had SUCCEEDED, so it was NOT
# re-run — GitHub carried its result forward into the new attempt untouched, and
# the database jobs, which merely `needs:` it, started immediately having never
# asked whether the slot was still theirs. From the Actions API:
#
#   run 33967089832 (main) attempt 1 — slot 12:49:14→13:06:58, DB job
#     13:08:09→13:15:46. Both memory suites green (17/17, 11/11).
#   run 33967153487 (PR #408) attempt 1 — slot 12:51:13→13:17:10 (it waited for
#     the run above), DB job 13:17:56→13:23:28.
#   run 33967089832 attempt 2 — run_started_at 13:17:42, DB job
#     13:17:47→13:23:12, and NO acquire-slot job in the attempt at all.
#
# Two attempts ran against the shared CI project 13:17:56–13:23:12. Five suites
# went red across the two runs with "my fixture row vanished" errors. The code
# under test was correct in every one of them.
#
# The root cause is structural, not incidental: THE JOB THAT PROVES THE SLOT WAS
# NOT THE JOB THAT USES IT. A proof carried across a re-run boundary is not a
# proof about this attempt. So every database job now runs this script ITSELF,
# in `verify` role, as its own first executing step:
#
#   LIVE_DB_SLOT_ROLE=queue   (default) — the dedicated queue job. Long timeout;
#                             this is where the honest waiting is paid for.
#   LIVE_DB_SLOT_ROLE=verify            — inside each DB job. Re-asks the same
#                             question with a shorter timeout. In the normal
#                             path the queue job has already drained the queue
#                             and this returns on the first poll (~2s).
#
# Both roles evaluate the SAME predicate through the SAME decider, because two
# implementations of "do I hold the database" is how one of them ends up wrong.
#
# WHY RE-ASKING IS CHEAP AND CANNOT DEADLOCK. The predicate is about the RUN,
# not the job: a run stays in_progress until all its jobs finish, so once a run
# is the oldest it REMAINS the oldest for the rest of its life (no run older
# than it can appear). All four DB jobs therefore satisfy the check at the same
# instant and keep running in parallel exactly as they do today. The only case
# where verify blocks is the case it exists for — an attempt that never queued.
#
# WHY FAIL-CLOSED. A verify that cannot prove the slot exits 75 and the job
# FAILS. It does not proceed, and it does not "warn". The whole lesson of this
# tier is that "it ran and asserted nothing" must be impossible to mistake for a
# pass; "it ran against a database somebody else was mutating" is the same lie
# with extra steps.
#
# WHY NOT JUST ALLOW PARALLELISM
# ------------------------------
# The jobs downstream of this create auth users, mutate profiles.role and
# profiles.is_official, apply migrations, and attempt a (rolled-back) INSERT
# into rank_events, against ONE shared non-production project. Two runs doing
# that at once corrupt each other's fixtures. Waiting is the price of a shared
# mutable database; evicting was paying that price AND losing the verdict.
#
# NOTE — a pre-existing race this does NOT fix, stated rather than hidden:
# WITHIN a single run, database jobs still run concurrently against the same
# project. The dependency graph now serializes them into two waves rather than
# four abreast — {api-server-check-all, schema-drift}, then
# {post-media-revocation-rehearsal, live-db-security-suites}, because the latter
# two gained `needs: schema-drift` — but two jobs of the SAME run still overlap,
# and the slot cannot separate them: the slot is held by the RUN, so every job
# in it holds the slot simultaneously and truthfully.
#
# What actually separates them is that they own disjoint fixtures (distinct
# fixture-email prefixes and distinct row keys), which is a convention, not an
# enforced boundary. Enforcing it would take a per-JOB mutual exclusion the run
# id cannot express — a pg_advisory_lock or a lease row in the CI project keyed
# by job name, taken for the duration of each job — which serializes the waves
# and roughly doubles wall-clock. That is a separate decision; see
# docs/ci/README.md.
#
# TIMEOUT IS NOT A PASS
# ---------------------
# If the slot cannot be acquired within LIVE_DB_SLOT_TIMEOUT_SECONDS this script
# exits 75 (EX_TEMPFAIL). The caller must surface that as NOT EXECUTED /
# infrastructure failure — never as success. See the verdict job.
#
# Required environment:
#   GH_TOKEN        a token that can read Actions runs
#   GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECIDE="${HERE}/live-db-slot-decide.sh"
if [ ! -f "$DECIDE" ]; then
  echo "::error::live-db slot: the decider ${DECIDE} is missing. Refusing to re-implement the predicate inline."
  exit 75
fi

ROLE="${LIVE_DB_SLOT_ROLE:-queue}"
case "$ROLE" in
  queue)  DEFAULT_TIMEOUT=2700 ;;   # 45 min — the honest queue wait
  verify) DEFAULT_TIMEOUT=1200 ;;   # 20 min — normally satisfied on poll 1
  *) echo "::error::live-db slot: unknown LIVE_DB_SLOT_ROLE '${ROLE}' (expected queue|verify)"; exit 64 ;;
esac

TIMEOUT="${LIVE_DB_SLOT_TIMEOUT_SECONDS:-$DEFAULT_TIMEOUT}"
POLL="${LIVE_DB_SLOT_POLL_SECONDS:-20}"
ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"

# ── CLAIM ANNOTATION ─────────────────────────────────────────────────────────
#
# A run FORFEITS the slot when its dedicated queue job — the one named below —
# concludes in failure or cancellation. Such a run demonstrably did not acquire
# the slot, so it must not block anybody and must not license its own remaining
# jobs. The reasoning, and the measured incident that required it, are in
# live-db-slot-decide.sh's header.
#
# FAIL-CLOSED IN BOTH DIRECTIONS, which is what keeps this from weakening
# anything:
#   • cannot reach the API, cannot parse it, cannot find the job  ⇒ `held`.
#     An unknown claim keeps the run blocking, exactly as before this existed.
#   • the queue job is still queued or in progress                ⇒ `held`.
#     A run that is legitimately waiting or working is never dropped.
# Only an explicit `failure` / `cancelled` conclusion forfeits.
#
# A run RELEASES the slot (added 2026-10-03) once every DATABASE job of its
# CURRENT attempt has concluded — success, failure, cancelled or skipped. Measured
# on run 37128138124: all four DB jobs concluded by 14:42:46Z, but the verdict
# job (no database) sat in GitHub's runner queue from 14:42:46Z, the run stayed
# `queued`, and other runs' verify steps timed out (exit 75) behind a run that
# had finished with the database. A released run blocks nobody, exactly like a
# forfeited one, and is reported as `released` so the two stay distinguishable.
#
# Release is the strictest of the three verdicts, and every doubt is `held`:
#   • LIVE_DB_SLOT_DB_JOBS unset or empty                         ⇒ `held`.
#   • the jobs query exits non-zero (even after printing output)  ⇒ `held`.
#   • any named DB job absent from the listing                    ⇒ `held`.
#     GitHub may not list a job blocked on `needs:` until it is queued, so
#     "not listed" is never read as "finished".
#   • any named DB job not `completed`, or with a null conclusion ⇒ `held`.
#   • the run's current attempt unknown, or any named DB job listed from a
#     DIFFERENT attempt (a re-run whose new jobs are not listed yet) ⇒ `held`.
#   • the run asking is the run being judged                      ⇒ `held`.
#     A run that is asking is still working; see annotate_claims.
# Forfeiture is checked FIRST and wins: a run that never acquired the slot is
# reported as forfeited, never as released.
#
# The set of DB jobs comes from ONE place: LIVE_DB_SLOT_DB_JOBS in live-db.yml's
# workflow-level env, exact job display names separated by newlines or `|`.
# ciWorkflowArchitecture.test.ts asserts it equals the workflow's DB jobs.
SLOT_JOB_NAME="live DB · acquire the shared-database slot"
DB_JOBS="$(printf '%s\n' "${LIVE_DB_SLOT_DB_JOBS:-}" | tr '|' '\n' \
            | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')"
if [ -z "$DB_JOBS" ]; then
  echo "live-db slot: LIVE_DB_SLOT_DB_JOBS is not set — no run will be treated as having released the slot (fail closed)."
fi

# Forfeiture is monotonic — a concluded job does not un-conclude — so a verdict
# of `forfeited` is cached for the life of this process. `held` is NOT cached,
# because a run that is fine now may time out during our wait, which is the
# whole case this exists for.
FORFEITED_CACHE=" "

# Succeeds only when EVERY named DB job appears in the jobs listing ($1, the
# tab-separated `attempt status conclusion name` lines run_claim fetches), every
# appearance is from attempt $2, `completed`, with a non-empty conclusion.
db_jobs_concluded() {
  local jobs="$1" attempt="$2" name
  # No list, no release. This guard is the ONLY thing that stops an empty list
  # from vacuously satisfying "every DB job concluded" below.
  [ -n "$DB_JOBS" ] || return 1
  case "$attempt" in ''|*[!0-9]*) return 1 ;; esac
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$jobs" | WANT_NAME="$name" WANT_ATTEMPT="$attempt" awk -F'\t' '
      $4 == ENVIRON["WANT_NAME"] {
        seen = 1
        if ($1 != ENVIRON["WANT_ATTEMPT"] || $2 != "completed" || $3 == "") open = 1
      }
      END { if (!seen || open) exit 1 }' || return 1
  done <<< "$DB_JOBS"
}

run_claim() {
  local run_id="$1" run_attempt="${2:-}"
  case "$FORFEITED_CACHE" in *" ${run_id} "*) echo "forfeited"; return ;; esac

  # One jobs query answers both questions: forfeited (the queue job) and
  # released (the DB jobs). Output and exit code are kept apart on purpose —
  # forfeiture reads whatever was printed, as it always has; release requires
  # the query to have SUCCEEDED as well.
  local jobs rc conclusion
  jobs="$(gh api --paginate \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100" \
      --jq '.jobs[] | "\(.run_attempt // "")\t\(.status // "")\t\(.conclusion // "")\t\(.name)"' \
    2>/dev/null)"
  rc=$?
  conclusion="$(printf '%s\n' "$jobs" | WANT_NAME="$SLOT_JOB_NAME" awk -F'\t' '$4 == ENVIRON["WANT_NAME"] {print $3; exit}')"

  case "$conclusion" in
    failure|cancelled)
      FORFEITED_CACHE="${FORFEITED_CACHE}${run_id} "
      echo "forfeited"
      return
      ;;
  esac
  # success, skipped, null (still running), empty (unreachable/unknown): the
  # queue job did not lose. Released only if the DB jobs say so; else held.
  if [ "$rc" -eq 0 ] && db_jobs_concluded "$jobs" "$run_attempt"; then
    echo "released"
  else
    echo "held"
  fi
}

# Reads `<started> <id> [<run_attempt>]` lines, writes `<started> <id> <claim>`.
annotate_claims() {
  local listing="$1"
  local my_started
  my_started="$(printf '%s\n' "$listing" | awk -v me="$GITHUB_RUN_ID" '$2 == me {print $1; exit}')"

  printf '%s\n' "$listing" | while IFS= read -r line; do
    [ -z "${line//[[:space:]]/}" ] && continue
    local started id attempt claim
    started="$(printf '%s' "$line" | awk '{print $1}')"
    id="$(printf '%s' "$line" | awk '{print $2}')"
    attempt="$(printf '%s' "$line" | awk '{print $3}')"
    if [ -z "$started" ] || [ -z "$id" ]; then
      # Leave malformed lines exactly as they are: the decider REFUSES a
      # listing it cannot parse, and that refusal must not be papered over here.
      printf '%s\n' "$line"
      continue
    fi
    # Only runs at or older than us can block us; and our own run is annotated
    # so that a `verify` step in a forfeited run fails instead of proceeding.
    if [ -n "$my_started" ] && [ "$started" \> "$my_started" ]; then
      printf '%s %s held\n' "$started" "$id"
    else
      claim="$(run_claim "$id" "$attempt")"
      # Our own run is never `released`: the job asking is one of its DB jobs
      # (or its queue job) and is still working. Forfeited still applies.
      if [ "$id" = "$GITHUB_RUN_ID" ] && [ "$claim" = "released" ]; then
        claim="held"
      fi
      printf '%s %s %s\n' "$started" "$id" "$claim"
    fi
  done
}

: "${GH_TOKEN:?GH_TOKEN is required to inspect Actions runs}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"

if [ "$ROLE" = "verify" ]; then
  echo "live-db slot [verify]: run ${GITHUB_RUN_ID} attempt ${ATTEMPT} re-checking that IT, in THIS attempt, holds the shared database"
  # Purely diagnostic: on `gh run rerun --failed` the queue job is not re-run and
  # its outputs are carried forward from the attempt that did run. Saying so out
  # loud makes the bypass legible in the log instead of invisible.
  if [ -n "${LIVE_DB_SLOT_ACQUIRED_IN_ATTEMPT:-}" ] && [ "${LIVE_DB_SLOT_ACQUIRED_IN_ATTEMPT}" != "$ATTEMPT" ]; then
    echo "live-db slot [verify]: the queue job's recorded attempt is ${LIVE_DB_SLOT_ACQUIRED_IN_ATTEMPT} but this is attempt ${ATTEMPT} — the upstream proof belongs to a different attempt and is not being trusted."
  fi
else
  echo "live-db slot: run ${GITHUB_RUN_ID} attempt ${ATTEMPT} requesting the shared database"
fi

# The workflow's numeric id, so we only consider OUR workflow's runs.
WF_ID="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
          --jq '.workflow_id' 2>/dev/null || echo "")"
if [ -z "$WF_ID" ]; then
  echo "::error::live-db slot: could not resolve this run's workflow id. Refusing to guess that the slot is free."
  exit 75
fi

emit() {
  echo "$1" >> "${GITHUB_OUTPUT:-/dev/null}"
}

# The clock starts HERE, not at the top of the script: the budget is named
# "how long am I willing to WAIT for the database", and the workflow-id lookup
# above is setup, not waiting. Starting it earlier meant a slow first API call
# could consume the whole budget and time the job out before it had asked the
# question even once — a starvation report about nothing.
#
# The same promise holds inside the loop: the deadline is only checked once the
# question HAS been asked. `date +%s` has one-second resolution, so a second
# boundary falling between START and the first NOW made ELAPSED=1 before any
# poll, and a 1-second budget then timed out a run that held the slot without
# ever looking. The first poll always runs; every later timeout is unchanged
# (exit 75, certifies nothing).
START="$(date +%s)"
ASKED=0

while :; do
  NOW="$(date +%s)"
  ELAPSED=$(( NOW - START ))
  if [ "$ASKED" -eq 1 ] && [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    if [ "$ROLE" = "verify" ]; then
      echo "::error::live-db slot: this job waited ${ELAPSED}s and could NOT prove that run ${GITHUB_RUN_ID} attempt ${ATTEMPT} holds the shared database. It has certified NOTHING and is failing rather than running against a database another run is mutating. If this is a partial re-run (\`gh run rerun --failed\`), re-run the whole workflow instead — a re-run does not re-execute the queue job, so the attempt starts at the BACK of the queue."
    else
      echo "::error::live-db slot: waited ${ELAPSED}s without acquiring the shared database. This run has certified NOTHING. It is NOT a pass — re-run it when the queue drains."
    fi
    emit "live_db_slot=timeout"
    exit 75
  fi

  # Every in-progress/queued run of this workflow, `<started> <id> <attempt>`
  # per line. The attempt is the run's CURRENT one, which a release must match.
  #
  # FILTERED SERVER-SIDE, ONE STATUS AT A TIME (measured 2026-10-03). The
  # listing used to page through the workflow's WHOLE run history
  # (`runs?per_page=100` with --paginate) and filter in jq. With hundreds of
  # completed runs that is several API calls per poll, every POLL seconds, in
  # every waiting job; with ~12 runs queued the repository hit GitHub's rate
  # limit, every call returned 403, the error was swallowed into an empty
  # listing, and every waiter timed out having certified nothing (PRs #570–#579,
  # 09:40–12:15 UTC). `?status=` returns only the runs the decider can use.
  #
  # ALL OR NOTHING. If either status query fails the listing is EMPTY, which the
  # decider refuses (exit 3) — never a listing with the in-progress half missing,
  # which would let a waiter believe it is the oldest while another run holds the
  # database.
  #
  # QUEUED FIRST. A run that moves queued -> in_progress between the two queries
  # is then seen by the second; asked the other way round it would be seen by
  # neither. A run seen by both is listed once, at its earliest timestamp.
  RAW_RUNS="$(
    listing=""
    for st in queued in_progress; do
      if ! part="$(gh api --paginate \
            "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?status=${st}&per_page=100" \
            --jq '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | "\(.run_started_at // .created_at) \(.id) \(.run_attempt // "")"' \
            2>/dev/null)"; then
        exit 0
      fi
      listing="${listing}${part}"$'\n'
    done
    printf '%s' "$listing" | sed '/^[[:space:]]*$/d' | sort -k1,1 | awk '!seen[$2]++'
  )"

  # Annotate each line with whether that run still has a CLAIM on the slot. See
  # live-db-slot-decide.sh's header for why a run can be the oldest and still
  # hold nothing. Runs newer than this one are left unannotated (`held` by
  # default): they cannot block us, so spending an API call on them is waste.
  RUNS="$(annotate_claims "$RAW_RUNS")"
  ASKED=1

  DECISION="$(printf '%s\n' "$RUNS" | bash "$DECIDE" 2>&1)"
  RC=$?

  case "$RC" in
    0)
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      FORF="$(printf '%s\n' "$DECISION" | sed -n 's/^forfeited=//p')"
      REL="$(printf '%s\n' "$DECISION" | sed -n 's/^released=//p')"
      echo "live-db slot [${ROLE}]: ACQUIRED after ${ELAPSED}s (this run is the oldest of ${ACTIVE:-?} active; ${FORF:-0} forfeited, ${REL:-0} released)"
      emit "live_db_slot=acquired"
      emit "live_db_slot_wait_seconds=${ELAPSED}"
      emit "live_db_slot_attempt=${ATTEMPT}"
      exit 0
      ;;
    1)
      HOLDER="$(printf '%s\n' "$DECISION" | sed -n 's/^holder=//p')"
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      FORF="$(printf '%s\n' "$DECISION" | sed -n 's/^forfeited=//p')"
      REL="$(printf '%s\n' "$DECISION" | sed -n 's/^released=//p')"
      echo "live-db slot [${ROLE}]: waiting ${ELAPSED}s/${TIMEOUT}s — holder=${HOLDER:-?}, ${ACTIVE:-?} active, ${FORF:-0} forfeited, ${REL:-0} released"
      ;;
    3)
      # We are in-progress ourselves, so an unusable list means the API is not
      # telling us the truth. Do not treat "I cannot see" as "nobody is there".
      echo "live-db slot [${ROLE}]: run listing was empty or unusable while this run is in progress — retrying in ${POLL}s"
      printf '%s\n' "$DECISION" | sed 's/^/  /'
      ;;
    *)
      echo "::error::live-db slot: the decider exited ${RC}, which is not a verdict. Refusing to assume the slot is free."
      emit "live_db_slot=undecided"
      exit 75
      ;;
  esac

  sleep "$POLL"
done
