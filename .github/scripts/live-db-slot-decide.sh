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
#   in_progress/queued runs.
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
# INPUT (stdin): one line per active run, `<run_started_at> <run_id>`, in any
# order. Blank lines are ignored. Lines that are not two fields are REFUSED
# rather than skipped — a listing we cannot parse is not a listing that proves
# the database is free.
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
  if printf '%s\n' "$line" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z?[^ ]*[[:space:]]+[0-9]+$'; then
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
OLDEST="$(printf '%s\n' "$VALID" | sort -k1,1 -k2,2n | head -1 | awk '{print $2}')"

echo "holder=${OLDEST}"
echo "active=${ACTIVE}"

# The asking run must appear in its own listing. If it does not, the listing is
# stale or filtered and the "oldest" it names is not authoritative — the same
# "I cannot see" case as an empty list, and it fails the same way.
if ! printf '%s\n' "$VALID" | awk '{print $2}' | grep -qx "$GITHUB_RUN_ID"; then
  echo "live-db-slot-decide: run ${GITHUB_RUN_ID} is not present in its own listing — refusing to conclude anything from it" >&2
  exit 3
fi

if [ "$OLDEST" = "$GITHUB_RUN_ID" ]; then
  exit 0
fi
exit 1
