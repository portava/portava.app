#!/usr/bin/env bash
#
# live-db-slot-decide.sh — the slot predicate, with the network taken out.
#
# WHY THIS FILE EXISTS SEPARATELY FROM THE WAIT LOOP
# --------------------------------------------------
# live-db-acquire-slot.sh used to hold both the polling loop AND the decision
# "does this run hold the shared database". Only the loop needs the network, and
# only the decision can be wrong. Splitting them makes the decision a pure
# function of (run listing, this run id) that a test can execute — see
# src/test/ciWorkflowArchitecture.test.ts, which feeds it the ACTUAL listing
# measured during the 2026-09-05 cross-run fixture corruption and asserts the
# verdict that would have prevented it.
#
# THE PREDICATE
# -------------
#   This run holds the slot iff it is the OLDEST of this workflow's
#   in_progress/queued runs THAT HAVE NOT FORFEITED THEIR CLAIM.
#
# ── THE FORFEIT CLAUSE, ADDED 2026-09-21, AND THE TRAP IT CLOSES ─────────────
#
# The predicate used to be "oldest in_progress run", full stop, and the comment
# below still explains why that is safe. It is — for deadlock-freedom. What it
# is not is sufficient, because a run can be the oldest in_progress run WITHOUT
# ever having acquired anything, and then hold the database hostage while it
# finishes work that has nothing to do with it.
#
# Measured on run 35612480282 (2026-09-21): its queue job hit
# LIVE_DB_SLOT_TIMEOUT_SECONDS and FAILED at 45m58s. Its three slot-gated DB
# jobs were skipped, correctly. But `api-server-check-all` carries
# `if: !cancelled()`, so it started anyway, and its `verify` step re-asked this
# predicate — which answered YES, because the run was the oldest in_progress
# run. It was the oldest BECAUSE it was still running, and it was still running
# BECAUSE that job had been told it held the slot. Seven consecutive runs sat in
# that loop, each occupying ~90 minutes against a 45-minute timeout.
#
# So a run whose QUEUE job concluded failure or cancellation has forfeited: it
# demonstrably did not acquire the slot, and nothing it does afterwards may be
# licensed by a claim it never had. Excluding it does two things at once —
# later runs stop waiting behind it, and its own `verify` steps start FAILING
# instead of waving work through on a slot it never won.
#
# THIS STRENGTHENS MUTUAL EXCLUSION, IT DOES NOT RELAX IT. Nothing here evicts a
# run whose queue job SUCCEEDED or is still running; such a run keeps the slot
# until its jobs finish, exactly as before. The only runs dropped are ones that
# already lost, and the effect on them is that they stop touching the database,
# not that somebody else joins them on it.
#
# "Oldest wins" is a total order over a set that only shrinks, so exactly one
# waiter is eligible at a time and the queue cannot deadlock. Two properties
# follow, and the second is the one that was being thrown away:
#
#   1. It is STATELESS. Nothing is stored; the answer is recomputed from the
#      Actions API every time it is asked.
#   2. Therefore it is RE-ASSERTABLE. Any job, at any moment, can ask "do I
#      still hold this?" — which is what makes it safe to stop trusting an
#      upstream job that may belong to a previous ATTEMPT. See the header of
#      live-db-acquire-slot.sh for the re-run bypass this closes.
#
# INPUT (stdin): one line per active run, `<run_started_at> <run_id> [claim]`,
# in any order. Blank lines are ignored. Lines that do not parse are REFUSED
# rather than skipped — a listing we cannot parse is not a listing that proves
# the database is free.
#
# `claim` is optional and is either `held` or `forfeited`. OMITTED MEANS HELD:
# a caller that cannot determine a run's claim must not thereby cause it to be
# ignored, and the two-field form stays valid so the recorded 2026-09-05
# fixture still exercises the same code.
#
# INPUT (env): GITHUB_RUN_ID — the run asking.
#
# OUTPUT (stdout): `holder=<run_id>` plus `active=<n>`.
#
# EXIT CODES
#   0  this run holds the slot
#   1  another run holds it (holder printed)
#   3  the listing is empty or unusable — NEVER treated as "the slot is free".
#      An empty list while the asking run is itself in progress means the API
#      did not tell us the truth, and "I cannot see anybody" is not "nobody is
#      there". The caller retries; it does not proceed.
#   64 usage error (no GITHUB_RUN_ID)
set -uo pipefail

if [ -z "${GITHUB_RUN_ID:-}" ]; then
  echo "live-db-slot-decide: GITHUB_RUN_ID is required" >&2
  exit 64
fi

INPUT="$(cat)"

# Keep only well-formed `<timestamp> <id>` lines, and refuse if anything else
# appeared. Sort is lexicographic, which is correct for ISO-8601 UTC timestamps
# (the Actions API emits `2026-09-05T13:17:42Z`); the run id breaks ties
# deterministically so two runs stamped identically still get a total order.
VALID=""
MALFORMED=0
while IFS= read -r line; do
  [ -z "${line//[[:space:]]/}" ] && continue
  if printf '%s\n' "$line" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?[^ ]*[[:space:]]+[0-9]+([[:space:]]+(held|forfeited))?$'; then
    VALID="${VALID}${line}"$'\n'
  else
    MALFORMED=1
    echo "live-db-slot-decide: unparseable run listing line: ${line}" >&2
  fi
done <<< "$INPUT"

if [ "$MALFORMED" -ne 0 ]; then
  echo "live-db-slot-decide: refusing to decide from a listing that did not parse" >&2
  exit 3
fi

VALID="$(printf '%s' "$VALID" | sed '/^$/d')"
if [ -z "$VALID" ]; then
  echo "live-db-slot-decide: the run listing is empty" >&2
  exit 3
fi

ACTIVE="$(printf '%s\n' "$VALID" | wc -l | tr -d ' ')"

# Runs that forfeited are still ACTIVE (they are in progress, and they are still
# listed) but they are not CLAIMANTS. Reported separately so a waiting run's log
# says how many of the runs ahead of it actually hold anything.
CLAIMANTS="$(printf '%s\n' "$VALID" | awk '$3 != "forfeited"')"
FORFEITED="$(printf '%s\n' "$VALID" | awk '$3 == "forfeited"' | wc -l | tr -d ' ')"

if [ -z "$CLAIMANTS" ]; then
  # Every active run has forfeited, INCLUDING possibly this one. That is not
  # "the slot is free": this run must still establish its own claim, and it does
  # that by being the oldest non-forfeited run — of which there are none. The
  # honest answer is that nobody holds it and neither do we.
  echo "holder="
  echo "active=${ACTIVE}"
  echo "forfeited=${FORFEITED}"
  echo "live-db-slot-decide: every active run has forfeited its claim" >&2
  exit 1
fi

OLDEST="$(printf '%s\n' "$CLAIMANTS" | sort -k1,1 -k2,2n | head -1 | awk '{print $2}')"

echo "holder=${OLDEST}"
echo "active=${ACTIVE}"
echo "forfeited=${FORFEITED}"

# The asking run must appear in its own listing. If it does not, the listing is
# stale or filtered and the "oldest" it names is not authoritative — the same
# "I cannot see" case as an empty list, and it fails the same way.
if ! printf '%s\n' "$VALID" | awk '{print $2}' | grep -qx "$GITHUB_RUN_ID"; then
  echo "live-db-slot-decide: run ${GITHUB_RUN_ID} is not present in its own listing — refusing to conclude anything from it" >&2
  exit 3
fi

# This run forfeited. It does not hold the slot no matter how old it is, and
# saying so is the point: a `verify` step in such a run must FAIL rather than
# wave work through on a claim the queue job never won.
if printf '%s\n' "$VALID" | awk '$3 == "forfeited" {print $2}' | grep -qx "$GITHUB_RUN_ID"; then
  echo "live-db-slot-decide: run ${GITHUB_RUN_ID} forfeited its claim (its queue job did not succeed)" >&2
  exit 1
fi

if [ "$OLDEST" = "$GITHUB_RUN_ID" ]; then
  exit 0
fi
exit 1
