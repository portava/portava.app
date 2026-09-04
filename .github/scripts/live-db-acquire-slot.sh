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
# "Oldest wins" is a total order over a set that only shrinks, so exactly one
# waiter can ever be eligible and the queue cannot deadlock. A run cancelled or
# finished while holding the slot simply leaves the set, and the next oldest
# proceeds.
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
# within a single run, four jobs (api-server-check-all, schema-drift,
# post-media-revocation-rehearsal, live-db-security-suites) all declare only
# `needs: preflight` and therefore run CONCURRENTLY against the same database.
# The old global group never prevented that either — it serialized runs, not
# database access. Serializing those four would roughly quadruple wall-clock for
# every run, so it is left as a separate decision; see docs/ci/README.md.
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

TIMEOUT="${LIVE_DB_SLOT_TIMEOUT_SECONDS:-2700}"   # 45 min default
POLL="${LIVE_DB_SLOT_POLL_SECONDS:-20}"
START="$(date +%s)"

: "${GH_TOKEN:?GH_TOKEN is required to inspect Actions runs}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_RUN_ID:?}"

echo "live-db slot: run ${GITHUB_RUN_ID} requesting the shared database"

# The workflow's numeric id, so we only consider OUR workflow's runs.
WF_ID="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
          --jq '.workflow_id' 2>/dev/null || echo "")"
if [ -z "$WF_ID" ]; then
  echo "::error::live-db slot: could not resolve this run's workflow id. Refusing to guess that the slot is free."
  exit 75
fi

while :; do
  NOW="$(date +%s)"
  ELAPSED=$(( NOW - START ))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "::error::live-db slot: waited ${ELAPSED}s without acquiring the shared database. This run has certified NOTHING. It is NOT a pass — re-run it when the queue drains."
    echo "live_db_slot=timeout" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 75
  fi

  # Every in-progress/queued run of this workflow, oldest first.
  RUNS="$(gh api --paginate \
            "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?per_page=100" \
            --jq '.workflow_runs[] | select(.status == "in_progress" or .status == "queued") | "\(.run_started_at // .created_at) \(.id)"' \
          2>/dev/null | sort || echo "")"

  if [ -z "$RUNS" ]; then
    # We are in-progress ourselves, so an empty list means the API is not
    # telling us the truth. Do not treat "I cannot see" as "nobody is there".
    echo "live-db slot: run list came back empty while this run is in progress — retrying in ${POLL}s"
    sleep "$POLL"
    continue
  fi

  OLDEST="$(echo "$RUNS" | head -1 | awk '{print $2}')"
  if [ "$OLDEST" = "$GITHUB_RUN_ID" ]; then
    echo "live-db slot: ACQUIRED after ${ELAPSED}s (this run is the oldest of $(echo "$RUNS" | wc -l | tr -d ' ') active)"
    echo "live_db_slot=acquired" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "live_db_slot_wait_seconds=${ELAPSED}" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi

  echo "live-db slot: waiting ${ELAPSED}s/${TIMEOUT}s — holder=${OLDEST}, $(echo "$RUNS" | wc -l | tr -d ' ') active"
  sleep "$POLL"
done
