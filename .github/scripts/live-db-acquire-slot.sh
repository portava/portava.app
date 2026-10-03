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

# ── WHEN THE API REFUSES TO ANSWER ───────────────────────────────────────────
#
# Measured 2026-10-03 on run 37113934334 job 111186609364. The listing call
# below came back as a REST error body, not a listing:
#
#   { "message": "API rate limit exceeded ...",
#     "documentation_url": ".../getting-started-with-the-rest-api#rate-limiting",
#     "status": "403" }
#
# That body was piped into the decider, which refused it as unparseable (exit
# 3, correctly — a listing we cannot read is not proof the database is free).
# The loop then logged "empty or unusable", slept a FIXED 20s, and asked again,
# for 1211s, until the cap. Three things were wrong with that, none of them in
# the decider:
#
#   1. Nothing said "403". The log blamed the queue — the timeout error even
#      advised re-running because "the attempt starts at the BACK of the
#      queue" — so the morning's diagnosis was slot starvation and lane count,
#      which is not what happened at all.
#   2. A fixed poll interval under a rate limit makes the rate limit worse.
#      Each iteration costs one listing call plus one jobs call per older run,
#      every waiting lane pays it in parallel, and past exhaustion NO lane can
#      prove a claim — so each one burns its whole budget and fails closed.
#      More waiters exhaust the quota faster. The queue poisons itself.
#   3. The annotation calls were spent on a listing already known to be junk.
#
# So: back off exponentially while the API is refusing, skip the annotation and
# the decider on those polls (there is nothing to decide from), and name the
# refusal in the log and in the final error. THIS DOES NOT RELAX MUTUAL
# EXCLUSION. A refused poll still never counts as "the slot is free"; the loop
# still ends in exit 75 having certified nothing. It fails closed more slowly
# and says why.
# 60s, not the 300s this first shipped with. Measured on run 37122355417: a
# 2700s wait at a 300s ceiling asked only TWELVE times, so a cause that cleared
# at minute 20 would not have been noticed for five more. The ceiling exists to
# stop a refused poller making exhaustion worse, and with the listing down to
# two server-filtered requests (and no annotation calls on a refused poll) that
# costs ~2 requests a minute — cheap enough to keep asking.
POLL_MAX="${LIVE_DB_SLOT_POLL_MAX_SECONDS:-60}"
SLEEP_FOR="$POLL"
API_REFUSALS=0
POLLS=0
# Distinct holders seen across the parsed polls, oldest sighting first. A
# timeout that names them says "I queued behind these runs"; one that names
# none says "I never saw a queue", and the two want different responses.
HOLDERS_SEEN=""
# Polls where the decider could not reach a verdict at all (exit 3): an empty
# listing, or one that does not contain this run. Counted apart from the API
# refusals above, because the two have different remedies and NEITHER of them
# is "re-run when the queue drains". Measured 2026-10-03 on run 37117788717,
# which polled 135 times over 2710s and got `the run listing is empty` every
# single time, with no 403 body and no holder ever named: a listing that omits
# the asking run cannot be true while that run is in progress, and the old
# timeout error called it a queue backlog anyway.
UNDECIDED=0

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
SLOT_JOB_NAME="live DB · acquire the shared-database slot"

# Forfeiture is monotonic — a concluded job does not un-conclude — so a verdict
# of `forfeited` is cached for the life of this process. `held` is NOT cached,
# because a run that is fine now may time out during our wait, which is the
# whole case this exists for.
FORFEITED_CACHE=" "

run_claim() {
  local run_id="$1"
  case "$FORFEITED_CACHE" in *" ${run_id} "*) echo "forfeited"; return ;; esac

  local conclusion
  conclusion="$(gh api --paginate \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/jobs?per_page=100" \
      --jq ".jobs[] | select(.name == \"${SLOT_JOB_NAME}\") | .conclusion // \"\"" \
    2>/dev/null | head -1)"

  case "$conclusion" in
    failure|cancelled)
      FORFEITED_CACHE="${FORFEITED_CACHE}${run_id} "
      echo "forfeited"
      ;;
    *)
      # success, skipped, null (still running), empty (unreachable/unknown).
      echo "held"
      ;;
  esac
}

# Reads `<started> <id>` lines, writes `<started> <id> <claim>` lines.
annotate_claims() {
  local listing="$1"
  local my_started
  my_started="$(printf '%s\n' "$listing" | awk -v me="$GITHUB_RUN_ID" '$2 == me {print $1; exit}')"

  printf '%s\n' "$listing" | while IFS= read -r line; do
    [ -z "${line//[[:space:]]/}" ] && continue
    local started id
    started="$(printf '%s' "$line" | awk '{print $1}')"
    id="$(printf '%s' "$line" | awk '{print $2}')"
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
      printf '%s %s %s\n' "$started" "$id" "$(run_claim "$id")"
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

# One file, truncated per poll, so a refusal can quote gh's own words. Keeping
# stderr was the difference between "exit 1" and a cause.
GH_STDERR="$(mktemp)"
trap 'rm -f "$GH_STDERR"' EXIT

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
    if [ "$API_REFUSALS" -eq "$POLLS" ]; then
      # Never once got an answer. Saying "the queue is long" here would be a
      # guess, and the guess cost three sessions a morning.
      echo "::error::live-db slot: the Actions API refused ALL ${POLLS} run-listing requests over ${ELAPSED}s (most recently: ${WHY:-unknown}). This job never learned who holds the shared database, so it has certified NOTHING and is failing closed. This is NOT a queue backlog and re-running will not shorten it — the request budget is the shared resource that ran out. Reduce the number of live-DB lanes running at once, or wait for the rate limit to reset."
    elif [ -z "$HOLDERS_SEEN" ]; then
      # Polls happened, none of them ever produced a queue position. Whatever
      # went wrong, a backlog is not it, and re-running changes nothing.
      echo "::error::live-db slot: ${POLLS} polls over ${ELAPSED}s and NOT ONE named a holder, so this job never established a queue position and has certified NOTHING. ${API_REFUSALS} refused by the Actions API (${WHY:-n/a}), ${UNDECIDED} returned a listing that did not account for this run — which cannot be true while this job is running. This is NOT a queue backlog; re-running it will not shorten anything. Treat it as an Actions API fault and check the request budget for this repository."
    elif [ "$API_REFUSALS" -gt 0 ] || [ "$UNDECIDED" -gt 0 ]; then
      # The mixed case, which is what every run measured on 2026-10-03 actually
      # was. Give BOTH numbers, so nobody has to read 554 log lines to find out
      # which phase the budget went on.
      echo "::error::live-db slot: waited ${ELAPSED}s without acquiring the shared database, and this run has certified NOTHING. ${POLLS} polls: $(( POLLS - API_REFUSALS - UNDECIDED )) queued behind ${HOLDERS_SEEN}, ${API_REFUSALS} refused by the Actions API (${WHY:-n/a}), ${UNDECIDED} answered with a listing that did not account for this run. Part queue, part Actions API — re-running helps only the first part."
    elif [ "$ROLE" = "verify" ]; then
      echo "::error::live-db slot: this job waited ${ELAPSED}s and could NOT prove that run ${GITHUB_RUN_ID} attempt ${ATTEMPT} holds the shared database. It has certified NOTHING and is failing rather than running against a database another run is mutating. If this is a partial re-run (\`gh run rerun --failed\`), re-run the whole workflow instead — a re-run does not re-execute the queue job, so the attempt starts at the BACK of the queue."
    else
      echo "::error::live-db slot: waited ${ELAPSED}s without acquiring the shared database. This run has certified NOTHING. It is NOT a pass — re-run it when the queue drains."
    fi
    # THE WAIT IS THE FINDING, so record it on this path too. Only the
    # acquired path used to emit it, which left `outputs.waited` EMPTY exactly
    # when the duration was the whole story: live-db-verdict printed
    # "waited=?s", and the telemetry artifact — whose stated purpose is the two
    # facts the Actions API cannot reconstruct afterwards, how long THIS run
    # waited and whether it got the database — recorded "queue_wait_seconds":
    # "null". Measured on run 37111083339: 2721s of waiting, reported as "?".
    emit "live_db_slot=timeout"
    emit "live_db_slot_wait_seconds=${ELAPSED}"
    emit "live_db_slot_attempt=${ATTEMPT}"
    # Additive, so live-db-verdict.sh and the telemetry artifact keep reading
    # the same three keys they always did. This one separates "the queue was
    # long" from "the API never answered", which the wait duration alone cannot.
    emit "live_db_slot_api_refusals=${API_REFUSALS}/${POLLS}"
    emit "live_db_slot_holders=${HOLDERS_SEEN}"
    emit "live_db_slot_undecided=${UNDECIDED}"
    exit 75
  fi

  # Every in-progress/queued run of this workflow, `<started> <id>` per line.
  #
  # ASK THE SERVER TO FILTER. This used to walk the workflow's ENTIRE run
  # history with `--paginate` and select the active ones client-side, which is
  # what exhausted the request budget in the first place: `--jq` filters each
  # page without stopping the walk, so one poll cost ceil(total/100) requests.
  # Measured 2026-10-03: live-db.yml has 2919 runs, so that was 30 requests per
  # poll, every 20s, from every waiting lane, against a budget that is per
  # REPOSITORY. The backoff below cannot prevent that — exhaustion arrives
  # before the first 403 does.
  #
  # `?status=` is applied by the API across all runs, so this is strictly more
  # precise than the walk it replaces, not a bounded approximation of it: it
  # CANNOT miss an older holder, however long that holder has been running.
  # Measured the same day: status=in_progress returned total_count 8 and
  # status=queued returned 4 — the whole queue, in two requests instead of 30.
  #
  # ORDER MATTERS, and it is the one way two calls can be worse than one. The
  # calls are not a single atomic snapshot, so a run that changes status
  # between them could fall through the gap — and a MISSED run is how this
  # script concludes a database is free when it is not. Runs only ever move
  # queued -> in_progress, so asking for `queued` FIRST makes a miss
  # impossible: a run queued at the first call is seen there, and one already
  # in progress by then is seen by the second. The reverse order has a real
  # hole (queued at call one's instant, in progress by call two's, listed by
  # neither). The cost of this order is that a run transitioning mid-poll can
  # appear TWICE, which is why the ids are de-duplicated below — a double
  # listing cannot make the slot look free, but it does inflate `active=`, and
  # that number is read by humans deciding whether to push.
  #
  # No `|| echo ""` here: that discarded gh's exit status, which is the one
  # unambiguous signal that the API refused us rather than answered us. Each
  # status keeps `--paginate` because correctness needs every page OF THE
  # FILTERED SET, which is the queue depth, not the run history.
  RAW_RUNS=""
  GH_RC=0
  : > "$GH_STDERR"
  for RUN_STATUS in queued in_progress; do
    STATUS_PAGE="$(gh api --paginate \
              "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?status=${RUN_STATUS}&per_page=100" \
              --jq '.workflow_runs[] | "\(.run_started_at // .created_at) \(.id)"' \
            2>>"$GH_STDERR")"
    STATUS_RC=$?
    # Either call failing means we do not have the queue. Fail closed: keep the
    # non-zero status so the refusal branch below owns this poll.
    [ "$STATUS_RC" -ne 0 ] && GH_RC="$STATUS_RC"
    RAW_RUNS="${RAW_RUNS}${STATUS_PAGE}"$'\n'
  done
  # First sighting of each run id wins. Lines that do not parse are passed
  # through untouched, because the decider must still refuse them.
  RAW_RUNS="$(printf '%s\n' "$RAW_RUNS" | awk 'NF == 0 { next } NF < 2 { print; next } !seen[$2]++')"
  POLLS=$(( POLLS + 1 ))
  ASKED=1

  # A non-zero exit, or an error body on stdout, means we were refused. Both are
  # checked: the exit code is authoritative, and the body names the reason.
  if [ "$GH_RC" -ne 0 ] || printf '%s' "$RAW_RUNS" | grep -q '"status": *"[45][0-9][0-9]"'; then
    API_REFUSALS=$(( API_REFUSALS + 1 ))
    # Why we were refused, in descending order of specificity. The exit code
    # alone is NOT an answer: run 37122355417 reported `exit 1` on all twelve
    # of its polls over 2700s, and a number is not a diagnosis.
    #
    # What went wrong there was not the detector but the plumbing: the listing
    # call ended `2>/dev/null`, and with `--jq` the filter does not run on an
    # HTTP error, so stdout was empty too. Both greps below ran against an
    # empty string, and the job log contains no `gh:` line at all — the reason
    # was discarded at the call site, so which refusal it was is STILL unknown.
    #
    # So read both streams and match all three shapes a reason arrives in:
    # `rate.limit` in prose (GitHub's rate-limit body has NO `status` key, so a
    # code-only detector misses the commonest refusal), a `"status": "4xx"`
    # field, and gh's own one-line `... (HTTP 4xx)` summary.
    GH_SAID="$(tr -d '\r' < "$GH_STDERR" | grep -v '^[[:space:]]*$' | head -1 | cut -c1-200)"
    GH_ANY="$(printf '%s\n' "$RAW_RUNS"; tr -d '\r' < "$GH_STDERR")"
    WHY="exit ${GH_RC}"
    if printf '%s' "$GH_ANY" | grep -qi 'rate.limit'; then
      WHY="HTTP 403, rate limit"
    elif printf '%s' "$GH_ANY" | grep -q '"status": *"[45][0-9][0-9]"'; then
      WHY="HTTP $(printf '%s' "$GH_ANY" | sed -n 's/.*"status": *"\([45][0-9][0-9]\)".*/\1/p' | head -1)"
    elif printf '%s' "$GH_ANY" | grep -qE '\(HTTP [45][0-9][0-9]\)'; then
      WHY="HTTP $(printf '%s' "$GH_ANY" | sed -n 's/.*(HTTP \([45][0-9][0-9]\)).*/\1/p' | head -1)"
    fi
    if [ -n "$GH_SAID" ]; then
      WHY="${WHY} — gh said: ${GH_SAID}"
    fi
    # Never sleep past the budget. The deadline is checked at the top of the
    # loop, so an unclamped backoff would overshoot the job's stated wait by up
    # to POLL_MAX — a 1200s verify budget reporting 1500s of waiting, which is
    # the kind of number this script exists to report honestly.
    WAIT_NOW="$SLEEP_FOR"
    REMAIN=$(( TIMEOUT - ELAPSED ))
    [ "$REMAIN" -lt 1 ] && REMAIN=1
    [ "$WAIT_NOW" -gt "$REMAIN" ] && WAIT_NOW="$REMAIN"
    echo "live-db slot [${ROLE}]: the Actions API REFUSED the run listing (${WHY}) — this says nothing about who holds the database. Waited ${ELAPSED}s/${TIMEOUT}s, ${API_REFUSALS} of ${POLLS} polls refused. Backing off ${WAIT_NOW}s."
    sleep "$WAIT_NOW"
    SLEEP_FOR=$(( SLEEP_FOR * 2 ))
    [ "$SLEEP_FOR" -gt "$POLL_MAX" ] && SLEEP_FOR="$POLL_MAX"
    continue
  fi
  SLEEP_FOR="$POLL"

  # Annotate each line with whether that run still has a CLAIM on the slot. See
  # live-db-slot-decide.sh's header for why a run can be the oldest and still
  # hold nothing. Runs newer than this one are left unannotated (`held` by
  # default): they cannot block us, so spending an API call on them is waste.
  RUNS="$(annotate_claims "$RAW_RUNS")"

  DECISION="$(printf '%s\n' "$RUNS" | bash "$DECIDE" 2>&1)"
  RC=$?

  case "$RC" in
    0)
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      echo "live-db slot [${ROLE}]: ACQUIRED after ${ELAPSED}s (this run is the oldest of ${ACTIVE:-?} active)"
      emit "live_db_slot=acquired"
      emit "live_db_slot_wait_seconds=${ELAPSED}"
      emit "live_db_slot_attempt=${ATTEMPT}"
      # Also on the SUCCESS path. A run that queued 738s behind two named
      # holders and then acquired is the case where these matter most: the wait
      # is real, nothing is broken, and the only way to tell that apart from a
      # refused poller is to say who was ahead. An acquisition that reports a
      # long wait and no holder is a finding, not a queue.
      emit "live_db_slot_api_refusals=${API_REFUSALS}/${POLLS}"
      emit "live_db_slot_holders=${HOLDERS_SEEN}"
      emit "live_db_slot_undecided=${UNDECIDED}"
      exit 0
      ;;
    1)
      HOLDER="$(printf '%s\n' "$DECISION" | sed -n 's/^holder=//p')"
      ACTIVE="$(printf '%s\n' "$DECISION" | sed -n 's/^active=//p')"
      FORF="$(printf '%s\n' "$DECISION" | sed -n 's/^forfeited=//p')"
      if [ -n "$HOLDER" ]; then
        case ",${HOLDERS_SEEN}," in
          *",${HOLDER},"*) : ;;
          *) HOLDERS_SEEN="${HOLDERS_SEEN:+${HOLDERS_SEEN},}${HOLDER}" ;;
        esac
      fi
      echo "live-db slot [${ROLE}]: waiting ${ELAPSED}s/${TIMEOUT}s — holder=${HOLDER:-?}, ${ACTIVE:-?} active, ${FORF:-0} forfeited"
      ;;
    3)
      # We are in-progress ourselves, so an unusable list means the API is not
      # telling us the truth. Do not treat "I cannot see" as "nobody is there".
      UNDECIDED=$(( UNDECIDED + 1 ))
      echo "live-db slot [${ROLE}]: the listing parsed but does not account for this run, which cannot be true while this job is running — the API answered, and its answer is wrong. Retrying in ${SLEEP_FOR}s"
      printf '%s\n' "$DECISION" | sed 's/^/  /'
      ;;
    *)
      echo "::error::live-db slot: the decider exited ${RC}, which is not a verdict. Refusing to assume the slot is free."
      emit "live_db_slot=undecided"
      exit 75
      ;;
  esac

  sleep "$SLEEP_FOR"
done
