#!/usr/bin/env bash
#
# assert-live-db-coverage.sh — every open PR's head SHA must have a
# `CI (live DB)` workflow RUN. No run at all is the failure; it is invisible
# from inside the run that never happened, so it is observed from here.
#
# WHY THIS CANNOT LIVE IN live-db.yml
# -----------------------------------
# Nothing a workflow declares makes an event fire that GitHub never sent. A
# conflicted PR produces no `pull_request` event because the merge ref cannot be
# built, and `push: ['**']` was removed from that workflow on measured evidence
# (docs/ci/README.md § "Concurrency: the shared database is a queue, not a
# race": 64 of 100 runs cancelled, 45% of commits with NO verdict). The absence
# is only observable from OUTSIDE the missing run.
#
# WHY IT IS ITS OWN WORKFLOW AND NOT A JOB IN ci.yml
# --------------------------------------------------
# It was built in `ci.yml` first, and that was wrong. The question is
# REPO-WIDE — "does every open PR have a run" — and `ci.yml` is PER-BRANCH. So
# one stale conflicted PR would turn every branch's CI red, and
# src/test/ciWorkflowArchitecture.test.ts requires every job in `ci.yml` to be
# in `ci-verdict`'s `needs:`, which is the context branch protection is meant
# to require. The result would be that one conflicted PR nobody is working on
# blocks the merge of every other PR — a far larger blast radius than the
# defect being reported, and not what anybody approved.
#
# A repo-wide question belongs on a repo-wide trigger. This workflow runs on
# `push: [main]` (the event that CAUSES PRs to conflict) and on a schedule, and
# it reds its own board and nothing else.
#
# WHY THIS IS NOT A GUARD IN artifacts/api-server/src/scripts/guardRegistry.ts
# ---------------------------------------------------------------------------
# Every guard in that registry answers a question about the WORKING TREE; none
# reads GitHub's run history. Two things follow, and the second is decisive:
#
#   1. The registry is invoked by `check:all`, which runs on developer laptops
#      and in `run-all-checks.sh`. A guard that needs the Actions API and a
#      token would fail there for reasons that have nothing to do with the tree.
#   2. `check:all` runs inside live-db.yml's `api-server · check:all +
#      live_pulse gate` job — the very run whose ABSENCE this detects. A
#      detector that only executes inside the missing run cannot observe its
#      own absence. That is disqualifying, not merely awkward.
#
# The precedent for an Actions-API script already exists in this directory:
# live-db-acquire-slot.sh (fetch) + live-db-slot-decide.sh (pure predicate).
# This pair follows that split exactly, for the same reason — the predicate is
# the part that can be wrong, so it is kept executable without a network.
#
# WHAT A RED HERE MEANS, AND WHAT IT DOES NOT
# -------------------------------------------
# UNCERTIFIED means: this SHA has no live-database certification and nothing in
# GitHub's check list says so. The remedy is to make a run exist for that SHA —
# resolve the conflict and push, or dispatch `CI (live DB)` against the branch.
#
# UNMEASURABLE means something different and the two are never merged: the SHA
# predates the oldest `CI (live DB)` run still visible, so a run may have
# existed and been deleted by log retention. The remedy is a human deciding
# whether a PR that old should still be open. It still FAILS, because an
# unestablished result is not a pass.
#
# Neither means the database is broken, and neither means the PR's code is
# wrong. Nor is any of this a claim that a certification PASSED — existence is
# all that is asserted. A run that exists and failed is a different,
# already-visible problem, and deliberately not this check's business (see the
# decider's header for the measured reason).
#
# Required environment:
#   GH_TOKEN             a token with `actions: read` and `pull-requests: read`
#   GITHUB_REPOSITORY    owner/name
#
# Optional:
#   LIVE_DB_COVERAGE_GRACE_SECONDS   grace window, default 1800 (see decider)
#
# EXIT CODES
#   0  every open PR's head SHA has a run (or is inside the grace window)
#   1  at least one does not, at least one could not be measured, OR the
#      question could not be answered at all. All three are failures. A check
#      that cannot establish its result does not pass — the rule stated at the
#      top of ci.yml and in run_gate() in
#      artifacts/api-server/scripts/run-all-checks.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECIDE="${HERE}/live-db-coverage-decide.sh"
if [ ! -f "$DECIDE" ]; then
  echo "::error::live-db coverage: the decider ${DECIDE} is missing. Refusing to re-implement the predicate inline."
  exit 1
fi

: "${GH_TOKEN:?GH_TOKEN is required to read Actions runs and pull requests}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

# The workflow is identified by its `name:`, not by a numeric id or a filename.
# A numeric id is not reviewable and a filename survives a rename of the thing
# that actually appears in the check list. If this lookup finds nothing the
# check FAILS: either the workflow was renamed (in which case this string and
# the branch-protection contexts must be updated together) or the API did not
# answer, and neither is a pass.
WORKFLOW_NAME='CI (live DB)'

# The (b) half of the question: given a run exists, did its gate job reach a
# conclusion of its own? Matched on the leading segment of the job `name:`,
# because the published name carries a trailing "(needs credentials)" that is
# prose rather than identity. Diagnostic only — see the decider's header.
GATE_JOB_PREFIX='api-server · check:all + live_pulse gate'

api() {
  gh api -H 'Accept: application/vnd.github+json' "$@"
}

# NAME THE CAUSE, NOT A GUESS AT IT.
#
# `gh api` does NOT apply `--jq` to a refusal: on a non-2xx with a JSON body it
# copies the BODY to stdout, writes `gh: <message>` to stderr and exits
# non-zero. So a failed call's captured output still carries the reason, and the
# three facts that must never be merged are distinguishable from it — the API
# refused (rate limit, credentials, scope), the API answered nothing at all
# (transport, empty body), and the API answered something unusable.
#
# This is not cosmetic. On 2026-10-03 a 403 rate-limit body was fed to
# live-db-slot-decide.sh as a run listing, and the message that came out named
# the wrong cause; the debugging time went to the wrong place.
why() {
  local rc="$1" text="$2"
  case "$text" in
    *"rate limit"*|*"secondary rate"*|*"abuse detection"*)
      echo "the API REFUSED the call with a RATE LIMIT (HTTP 403). This is not a missing permission and it is NOT an empty answer"; return ;;
    *"Bad credentials"*|*"Requires authentication"*)
      echo "the API rejected GH_TOKEN (bad credentials)"; return ;;
    *"Resource not accessible"*|*"Not Found"*|*"must have admin"*)
      echo "the API refused the call as forbidden or not found — the token is probably missing a scope"; return ;;
  esac
  if [ -z "${text//[[:space:]]/}" ]; then
    if [ "$rc" -ne 0 ]; then
      echo "the call FAILED and produced no output at all — a transport failure, or an empty body"
    else
      echo "the call exited 0 and answered NOTHING, which is not an answer"
    fi
  else
    echo "$([ "$rc" -ne 0 ] && echo "the call failed" || echo "the call exited 0") and its answer names no API error: '$(printf '%s' "$text" | tr '\n\t' '  ' | cut -c1-200)'"
  fi
}

# ── 1. THE WORKFLOW ──────────────────────────────────────────────────────────
# The output is captured BEFORE `head -1` so a refusal's body is still intact
# when the cause is classified: the first line of a 403 body is `{`, which names
# nothing.
WF_RAW="$(api --paginate "repos/${GITHUB_REPOSITORY}/actions/workflows?per_page=100" \
            --jq ".workflows[] | select(.name == \"${WORKFLOW_NAME}\") | .id" 2>/dev/null)"
WF_RC=$?
WF_ID="$(printf '%s' "${WF_RAW}" | head -1)"
if ! printf '%s' "${WF_ID}" | grep -Eq '^[0-9]+$'; then
  echo "::error::live-db coverage: could not resolve the workflow id for '${WORKFLOW_NAME}' in ${GITHUB_REPOSITORY} (gh exit ${WF_RC}): $(why "${WF_RC}" "${WF_RAW}"). Refusing to conclude that every PR is certified — this check establishes nothing without it. If the workflow was renamed, update WORKFLOW_NAME in this script and the required-status-check contexts in the same change."
  exit 1
fi
echo "live-db coverage: '${WORKFLOW_NAME}' is workflow ${WF_ID}"

# ── 2. THE HORIZON ───────────────────────────────────────────────────────────
#
# The `created_at` of the OLDEST `CI (live DB)` run still visible. A head SHA
# older than this cannot be judged: its run may have existed and been deleted
# by log retention, or the workflow may not have existed yet. See THE HORIZON
# in the decider's header for why this is measured rather than read from a
# setting (repository log retention is not on the REST surface this job has).
#
# Two calls, not a full pagination: runs come back newest-first, so the last
# page at per_page=1 IS the oldest run. Verified against this repository on
# 2026-10-03 — total_count 2894, page 2894 returns run_number 1
# (id 31362783748, created_at 2026-08-10T06:39:09Z), so deep pagination is not
# truncated here.
#
# A failure to establish the horizon is NOT fatal on its own: it degrades every
# missing run from UNCERTIFIED to UNMEASURABLE, and both fail. That is why it
# sets `unknown` instead of exiting — the check still reports, and it reports
# the weaker claim it can actually support.
#
# "There are no runs" and "I was not allowed to ask" both land on the warning
# below and both degrade UNCERTIFIED to UNMEASURABLE, so the warning is the only
# place the difference can be read — and the remedies share nothing. The numeric
# test is `case`, not `grep -Eq '^[0-9]+$'`: grep matches PER LINE, so a refusal
# body carrying a digits-only line would pass it, and the arithmetic test on a
# multi-line value then exits 2 — which, with no `set -e`, is merely a false
# condition.
RUN_TOTAL="$(api "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?per_page=1" \
               --jq '.total_count // 0' 2>/dev/null)"
RUN_TOTAL_RC=$?
HORIZON=""
HORIZON_WHY=""
case "${RUN_TOTAL}" in
  ''|*[!0-9]*)
    HORIZON_WHY="the run total for '${WORKFLOW_NAME}' could not be read (gh exit ${RUN_TOTAL_RC}): $(why "${RUN_TOTAL_RC}" "${RUN_TOTAL}")" ;;
  0)
    HORIZON_WHY="the API ANSWERED and reports 0 '${WORKFLOW_NAME}' runs — an EMPTY run history, which is a fact about the repository and not a failed call" ;;
  *)
    HORIZON="$(api "repos/${GITHUB_REPOSITORY}/actions/workflows/${WF_ID}/runs?per_page=1&page=${RUN_TOTAL}" \
                 --jq '.workflow_runs[0].created_at // ""' 2>/dev/null)"
    HORIZON_RC=$?
    # The timestamp is SHAPE-CHECKED before it is used, for the same reason the
    # commit date is: a refusal puts the error BODY here, which is non-empty, so
    # an `-z` test alone carries it into `date -d` and then into the job summary
    # as the horizon. Classified and blanked here instead, so the warning below
    # names the refusal rather than reporting an unparseable date.
    HORIZON_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z?$'
    if [ "$HORIZON_RC" -ne 0 ] || ! [[ "${HORIZON}" =~ $HORIZON_RE ]]; then
      HORIZON_WHY="the oldest page (page ${RUN_TOTAL} of ${RUN_TOTAL}) could not be read (gh exit ${HORIZON_RC}): $(why "${HORIZON_RC}" "${HORIZON}")"
      HORIZON=""
    fi ;;
esac
HORIZON_EPOCH=""
if [ -n "${HORIZON}" ]; then
  HORIZON_EPOCH="$(date -u -d "${HORIZON}" +%s 2>/dev/null)"
fi
if printf '%s' "${HORIZON_EPOCH}" | grep -Eq '^[0-9]+$'; then
  echo "live-db coverage: oldest visible '${WORKFLOW_NAME}' run is from ${HORIZON} (of ${RUN_TOTAL} run(s)); a head SHA older than that cannot be judged"
else
  HORIZON_EPOCH=""
  [ -n "${HORIZON_WHY}" ] || HORIZON_WHY="the oldest run's created_at '${HORIZON}' did not parse as a date"
  echo "::warning::live-db coverage: could not establish the oldest visible '${WORKFLOW_NAME}' run — ${HORIZON_WHY}. Every missing run will be reported UNMEASURABLE rather than UNCERTIFIED — a weaker claim, and still a failure."
fi

# ── 3. THE OPEN PULL REQUESTS ────────────────────────────────────────────────
PR_RAW="$(api --paginate "repos/${GITHUB_REPOSITORY}/pulls?state=open&per_page=100" \
            --jq '.[] | "\(.number) \(.head.sha)"' 2>/dev/null)"
PR_RC=$?
if [ "$PR_RC" -ne 0 ]; then
  echo "::error::live-db coverage: listing open pull requests failed (gh exit ${PR_RC}): $(why "${PR_RC}" "${PR_RAW}"). If the token is what failed, the job needs \`pull-requests: read\`. Not a pass."
  exit 1
fi

# AN EMPTY PR LISTING IS CROSS-CHECKED, NOT TRUSTED.
#
# Every other check in this repo is built on the principle that a count of zero
# is the shape a broken check has, so zero is never accepted on one source's
# word. There is no magic minimum here to invent: the repository itself reports
# how many issues-and-pull-requests are open (GitHub counts PRs in
# `open_issues_count`), so the two answers are simply compared. If the pulls
# endpoint says "none" while the repository says "some", the honest statement is
# that the listing is empty BUT THE API ANSWERED, and nothing has been
# established — so it fails rather than reporting a vacuous pass.
#
# THE KNOWN FALSE REFUSAL, stated rather than discovered: a repository with
# open ISSUES and genuinely no open pull requests lands here too, because
# `open_issues_count` cannot separate the two. The remedy is one line from a
# human, and that is a better failure than a green check that verified nothing.
if [ -z "${PR_RAW//[[:space:]]/}" ]; then
  OPEN_COUNT="$(api "repos/${GITHUB_REPOSITORY}" --jq '.open_issues_count // -1' 2>/dev/null)"
  OPEN_RC=$?
  # `case`, NOT `grep -Eq '^[0-9]+$'`. grep matches PER LINE, so a refusal body
  # carrying one digits-only line passes as "a number"; `[ -gt 0 ]` then exits 2
  # with "integer expression expected", and with no `set -e` that is simply a
  # FALSE condition — falling through to the vacuous `exit 0` below, whose "0
  # open issues-or-PRs" is a literal in this script and not anything the API
  # said. That is the only path here that could go green while nothing was
  # checked, which is the one outcome this file exists to prevent.
  case "${OPEN_COUNT}" in
    ''|*[!0-9]*)
      echo "::error::live-db coverage: the open pull-request listing is empty and the repository's own open-issue count could not be read (gh exit ${OPEN_RC}): $(why "${OPEN_RC}" "${OPEN_COUNT}"). So 'there are no open pull requests' is not established. Not a pass."
      exit 1 ;;
  esac
  if [ "${OPEN_COUNT}" -gt 0 ]; then
    echo "::error::live-db coverage: the pull-request listing is EMPTY but the API answered, and ${GITHUB_REPOSITORY} reports ${OPEN_COUNT} open issue(s)-or-pull-request(s). Nothing was checked, and a count of zero from one source is exactly what a broken listing looks like. If this repository really has open issues and no open pull requests, that is the one legitimate case and it needs a human to say so."
    exit 1
  fi
  echo "live-db coverage: no open pull requests, and ${GITHUB_REPOSITORY} reports 0 open issues-or-PRs. The two sources agree; there is nothing to certify."
  exit 0
fi

# ── 4. PER PULL REQUEST ──────────────────────────────────────────────────────
LISTING=""
while IFS= read -r prline; do
  [ -z "${prline//[[:space:]]/}" ] && continue
  PR="$(printf '%s' "$prline" | awk '{print $1}')"
  SHA="$(printf '%s' "$prline" | awk '{print $2}')"
  if [ -z "$PR" ] || [ -z "$SHA" ]; then
    echo "::error::live-db coverage: unusable pull-request listing line '${prline}'. Not a pass."
    exit 1
  fi

  # ONE CALL ANSWERS BOTH QUESTIONS. The repo-wide runs endpoint filtered by
  # `head_sha` returns EVERY workflow's runs for this exact SHA, so it gives:
  #
  #   (a) does a `CI (live DB)` run exist — select on workflow_id, so this
  #       cannot be satisfied by a run on the branch's PREVIOUS commit, which
  #       is exactly the shape of the measured defect (PR #530's branch had a
  #       recent live-DB run, against an earlier SHA);
  #   (b) when CI first saw this SHA — the minimum `created_at` over all of
  #       them, which is a server-generated timestamp and the sound basis for
  #       the grace window. See age_source in the decider's header.
  #
  # Queued, in-progress, cancelled and failed runs all COUNT as existing for
  # (a). Every one of them renders in the check list. Absence does not.
  # The jq program is SINGLE-quoted with only the numeric workflow id spliced
  # in, and it concatenates with `+ " " +` rather than interpolating. Written
  # the other way — a double-quoted filter with escaped `\"\"` defaults — it is a
  # jq compile error, which `2>/dev/null` would have hidden as an empty answer,
  # i.e. as "no run exists". Verified against four recorded responses; see the
  # test file.
  SHA_RUNS="$(api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${SHA}&per_page=100" \
                --jq '[.workflow_runs[]] as $r | ((([$r[] | select(.workflow_id == '"${WF_ID}"')] | sort_by(.created_at) | last | .id) // "") | tostring) + " " + (([$r[].created_at] | sort | first) // "")' \
              2>/dev/null)"
  SHA_RC=$?
  if [ "$SHA_RC" -ne 0 ]; then
    echo "::error::live-db coverage: listing workflow runs for ${SHA} (PR #${PR}) failed (gh exit ${SHA_RC}): $(why "${SHA_RC}" "${SHA_RUNS}"). If the token is what failed, the job needs \`actions: read\`. Not a pass."
    exit 1
  fi
  # `cut`, NOT `awk`. When no live-DB run exists the first field is EMPTY and
  # awk collapses leading whitespace, so `awk '{print $1}'` would hand back the
  # TIMESTAMP as the run id — a missing run read as a present one, which is the
  # exact failure this whole check exists to catch. Caught by fixture, not by
  # reasoning.
  # AN ANSWER THAT NEVER ARRIVED IS NOT "NO RUN EXISTS".
  #
  # The jq program emits exactly ONE line and its minimum is a single space
  # (`"" + " " + ""`), so an empty capture cannot mean "no `CI (live DB)` run".
  # jq exits 0 and prints nothing on empty input (verified: `printf '' | jq -r
  # '<the program above>'` exits 0 with no output), so a 204, an empty 200 or a
  # truncated body would otherwise read as an absence and publish a PR that HAS
  # a run as UNCERTIFIED. The shape is checked as a WHOLE string — `[[ =~ ]]`
  # anchors across newlines, where `grep` would match any one line — so a body
  # that arrived instead of an answer cannot be split into fields either.
  SHA_RUNS_RE='^[0-9]* [0-9A-Za-z:.+-]*$'
  if ! [[ "$SHA_RUNS" =~ $SHA_RUNS_RE ]]; then
    if [ -z "${SHA_RUNS//[[:space:]]/}" ]; then
      echo "::error::live-db coverage: the workflow-run listing for ${SHA} (PR #${PR}) came back EMPTY while gh exited ${SHA_RC}: $(why "${SHA_RC}" "${SHA_RUNS}"). 'No ${WORKFLOW_NAME} run exists for this SHA' is NOT established by an answer that never arrived. Not a pass."
    else
      echo "::error::live-db coverage: the workflow-run listing for ${SHA} (PR #${PR}) came back in a shape this script cannot read: $(why "${SHA_RC}" "${SHA_RUNS}"). Not a pass."
    fi
    exit 1
  fi
  RUN_ID="$(printf '%s' "$SHA_RUNS" | cut -d' ' -f1)"
  FIRST_SEEN="$(printf '%s' "$SHA_RUNS" | cut -d' ' -f2)"

  # ── the age, and which timestamp it came from ──────────────────────────────
  AGE_SOURCE="first-ci-run"
  SHA_EPOCH=""
  if [ -n "$FIRST_SEEN" ]; then
    SHA_EPOCH="$(date -u -d "$FIRST_SEEN" +%s 2>/dev/null)"
  fi
  if ! printf '%s' "$SHA_EPOCH" | grep -Eq '^[0-9]+$'; then
    # No workflow run of ANY kind for this SHA, so there is no server-generated
    # "CI first saw it" to use. Fall back to the committer date and SAY SO on
    # the line — it is author-controlled and the decider's header explains how
    # that can mislead in both directions.
    AGE_SOURCE="commit-date"
    COMMIT_DATE="$(api "repos/${GITHUB_REPOSITORY}/commits/${SHA}" \
                     --jq '.commit.committer.date' 2>/dev/null)"
    COMMIT_RC=$?
    # A REFUSAL IS NOT A MALFORMED DATE. On a non-2xx the error BODY lands in
    # this variable — non-empty, so an `-z` test alone waves it through to the
    # parse failure below, which then quotes the 403 body back at the reader as
    # if an author had written it into a commit. The exit status and the shape
    # are both checked here so the cause is named where it happened.
    if [ "$COMMIT_RC" -ne 0 ] || [ -z "${COMMIT_DATE//[[:space:]]/}" ] || [ "$COMMIT_DATE" = "null" ]; then
      echo "::error::live-db coverage: could not read the head commit date for PR #${PR} (${SHA}) (gh exit ${COMMIT_RC}): $(why "${COMMIT_RC}" "${COMMIT_DATE}"). No workflow run exists for that SHA to date it from either. An unestablished age is not an exemption. Not a pass."
      exit 1
    fi
    SHA_EPOCH="$(date -u -d "$COMMIT_DATE" +%s 2>/dev/null)"
    if ! printf '%s' "$SHA_EPOCH" | grep -Eq '^[0-9]+$'; then
      echo "::error::live-db coverage: could not parse the head commit date '${COMMIT_DATE}' for PR #${PR}. Not a pass."
      exit 1
    fi
  fi
  AGE=$(( $(date -u +%s) - SHA_EPOCH ))

  # ── is the absence measurable at all ──────────────────────────────────────
  PR_HORIZON="unknown"
  if [ -n "$HORIZON_EPOCH" ]; then
    if [ "$SHA_EPOCH" -ge "$HORIZON_EPOCH" ]; then
      PR_HORIZON="within"
    else
      PR_HORIZON="before"
    fi
  fi

  if [ -z "${RUN_ID//[[:space:]]/}" ]; then
    LISTING="${LISTING}${PR} ${SHA} ${AGE} ${AGE_SOURCE} no-run - ${PR_HORIZON}"$'\n'
    continue
  fi

  # (b) DID THE GATE JOB REACH A CONCLUSION OF ITS OWN. Reported, never gating.
  GATE_RAW="$(api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/jobs?per_page=100" \
                --jq ".jobs[] | select(.name | startswith(\"${GATE_JOB_PREFIX}\")) | .conclusion // \"none\"" \
              2>/dev/null)"
  GATE_RC=$?
  GATE="$(printf '%s' "$GATE_RAW" | head -1)"
  GATE="${GATE//[[:space:]]/}"
  # THIS FIELD IS DIAGNOSTIC AND MUST NOT CHANGE THE VERDICT IN EITHER
  # DIRECTION. The exit status was unchecked here, and the first line of a 403
  # body is `{` — which went into the listing as the gate field, which the
  # decider correctly REFUSES as unparseable (exit 3). So a refusal on the one
  # field that is never gating took the whole check down with "the decider
  # exited 3": a false alarm, naming neither the endpoint nor the rate limit.
  # It is reported as `unknown` with a warning instead, which is the value the
  # decider already defines for "could not be determined".
  if [ "$GATE_RC" -ne 0 ] || ! printf '%s' "$GATE" | grep -Eq '^[a-z_]*$'; then
    echo "::warning::live-db coverage: could not read the gate job's conclusion for run ${RUN_ID} (PR #${PR}) (gh exit ${GATE_RC}): $(why "${GATE_RC}" "${GATE_RAW}"). Reporting gate=unknown. This half of the question is diagnostic only and does not change the verdict — see the decider's header."
    GATE="unknown"
  fi
  if [ -z "$GATE" ]; then
    # The run exists and the gate job is not in it — a legitimate state (the
    # slot job failed and the DB jobs were skipped out of the run's job list on
    # some attempts) and not this check's business. Named rather than blanked.
    GATE="unknown"
  fi

  LISTING="${LISTING}${PR} ${SHA} ${AGE} ${AGE_SOURCE} run ${GATE} ${PR_HORIZON}"$'\n'
done <<< "$PR_RAW"

echo "live-db coverage: listing handed to the decider"
printf '%s' "$LISTING" | sed 's/^/  /'

DECISION="$(printf '%s' "$LISTING" | bash "$DECIDE" 2>&1)"
RC=$?
printf '%s\n' "$DECISION"

CHECKED="$(printf '%s\n' "$DECISION" | sed -n 's/^checked=//p')"
COVERED="$(printf '%s\n' "$DECISION" | sed -n 's/^covered=//p')"
TOO_NEW="$(printf '%s\n' "$DECISION" | sed -n 's/^too_new=//p')"
BAD="$(printf '%s\n' "$DECISION" | sed -n 's/^uncertified=//p')"
UNMEAS="$(printf '%s\n' "$DECISION" | sed -n 's/^unmeasurable=//p')"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### live-DB coverage of open pull requests"
    echo ""
    echo "| open PRs | head SHAs with a run | inside grace window | UNCERTIFIED | UNMEASURABLE |"
    echo "| --- | --- | --- | --- | --- |"
    echo "| ${CHECKED:-?} | ${COVERED:-?} | ${TOO_NEW:-?} | ${BAD:-none} | ${UNMEAS:-none} |"
    echo ""
    echo "Oldest visible \`${WORKFLOW_NAME}\` run: \`${HORIZON:-unknown}\`"
    echo ""
    printf '%s\n' "$DECISION" | sed -n 's/^pr=/- `pr=/p' | sed 's/$/`/'
  } >> "$GITHUB_STEP_SUMMARY"
fi

case "$RC" in
  0)
    echo "live-db coverage: ${COVERED:-0} of ${CHECKED:-0} open PR head SHA(s) have a '${WORKFLOW_NAME}' run; ${TOO_NEW:-0} inside the grace window."
    exit 0
    ;;
  1)
    if [ -n "$BAD" ]; then
      echo "::error::live-db coverage: these open PR head SHAs have NO '${WORKFLOW_NAME}' run at all: ${BAD}. Their check lists read green with zero live-database certification — not a grey entry, not a red one, ABSENT. GitHub never fired the event (a merge conflict means the merge ref cannot be built, and that workflow no longer triggers on feature-branch pushes), so no change to live-db.yml can produce the missing run. Make a run exist for the SHA: resolve the conflict and push, or dispatch '${WORKFLOW_NAME}' against the branch. If a line above reads age_source=commit-date, discount it: that timestamp is the committer date, which an author can back-date, so a SHA pushed moments ago can look old enough to flag."
    fi
    if [ -n "$UNMEAS" ]; then
      echo "::error::live-db coverage: these open PR head SHAs could NOT be measured: ${UNMEAS}. Each predates the oldest '${WORKFLOW_NAME}' run still visible (${HORIZON:-unknown}), so a run MAY have existed, certified the commit, and since been deleted by log retention — or the workflow may not have existed yet. This is NOT a report that they are uncertified, and it is not a pass either: nothing was established. Decide whether a pull request that old should still be open, or dispatch '${WORKFLOW_NAME}' against its branch to produce a verdict that is visible today."
    fi
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        echo ""
        echo "> **This run did not establish live-DB coverage of the open pull requests.**"
        echo ">"
        [ -n "$BAD" ]    && echo "> No run exists for: \`${BAD}\`"
        [ -n "$UNMEAS" ] && echo "> Could not be measured: \`${UNMEAS}\`"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 1
    ;;
  *)
    echo "::error::live-db coverage: the decider exited ${RC}, which is not a verdict. This check has established NOTHING about live-database coverage and is failing rather than reporting a pass it did not observe."
    exit 1
    ;;
esac
