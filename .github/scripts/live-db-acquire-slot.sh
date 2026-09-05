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
START="$(date +%s)"

while :; do
  NOW="$(date +%s)"
  ELAPSED=$(( NOW - START ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    if [ "$ROLE" = "verify" ]; then
      echo "::error::live-db slot: this job waited ${ELAPSED}s and could NOT prove that run ${GITHUB_RUN_ID} attempt ${ATTEMPT} holds the shared database. It has certified NOTHING and is failing rather than running against a database another run is mutating. If this is a partial re-run (\`gh run rerun --failed\`), re-run the whole workflow instead — a re-run does not re-execute the queue job, so the attempt starts at the BACK of the queue."
    else
      echo "::error::live-db slot: waited ${ELAPSED}s without acquiring the shared database. This run has certified NOTHING. It is NOT a pass — re-run it when the queue drains."
    fi
    emit "live_db_slot=timeout"
    exit 75
  fi

  # Every in-progress/queued run of this workflow, `<started> <id>` per line.
  RUNS="$(gh api --paginate \
            "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?per_page=100" \
            --jq '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | "\(.run_started_at // .created_at) \(.id)"' \
          2>/dev/null || echo "")"

  DECISION="$(printf '%s\n' "$RUNS" | bash "$DECIDE" 2>&1)"
  RC=$?

  case "$RC" in
    0)
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      echo "live-db slot [${ROLE}]: ACQUIRED after ${ELAPSED}s (this run is the oldest of ${ACTIVE:-?} active)"
      emit "live_db_slot=acquired"
      emit "live_db_slot_wait_seconds=${ELAPSED}"
      emit "live_db_slot_attempt=${ATTEMPT}"
      exit 0
      ;;
    1)
      HOLDER="$(printf '%s\n' "$DECISION" | sed -n 's/^holder=//p')"
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      echo "live-db slot [${ROLE}]: waiting ${ELAPSED}s/${TIMEOUT}s — holder=${HOLDER:-?}, ${ACTIVE:-?} active"
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
