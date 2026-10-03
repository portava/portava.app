#!/usr/bin/env bash
#
# live-db-coverage-decide.sh — "does every open PR's head SHA have a live-DB
# run at all", with the network taken out.
#
# WHY THIS FILE EXISTS SEPARATELY FROM THE FETCHER
# ------------------------------------------------
# This is the live-db-acquire-slot.sh / live-db-slot-decide.sh split, for the
# same reason: only the fetcher needs the network, and only the decision can be
# wrong. Splitting them makes the decision a pure function of (per-PR listing,
# grace window) that a test can execute against a recorded listing instead of
# trusting it — see src/test/ciWorkflowArchitecture.test.ts, which feeds it the
# listing measured on 2026-10-03 and asserts the verdicts below.
#
# THE DEFECT THIS DETECTS, MEASURED
# ---------------------------------
# A pull request with a merge conflict gets NO `CI (live DB)` workflow run
# CREATED. GitHub cannot build the merge ref, so it never fires the
# `pull_request` event, and `push: ['**']` was deliberately removed from that
# workflow on measured evidence (docs/ci/README.md § "Concurrency: the shared
# database is a queue, not a race" — re-adding it is what was evicting other
# branches' verdicts 64 times in 100). `ci.yml` and `unwired-checks.yml` still
# run on `push` and report green, so the PR's check list reads FULLY GREEN with
# no live-database certification and not even a grey entry for the missing one.
#
# Observed 2026-10-03: PR #530 (head 846f58e7…) showed 11 check runs, all
# success, and no live-DB check-run name present at all; its branch's newest
# live-DB run (37097887542) was against an EARLIER commit (0cb20f42…). PR #393
# (head 1b78d3b6…) showed 10/10 success, dirty since 2026-09-05, newest live-DB
# run on its branch (33961248341) against a different commit.
#
# WHAT THIS IS NOT KEYED ON, AND WHY THAT MATTERS
# -----------------------------------------------
#   * NOT `mergeable_state`. That is the CAUSE, not the symptom. Six open PRs
#     were dirty when this was written (#549, #530, #521, #393, #54, #52) and
#     only two were in the bad state: #549 has a live-DB verdict of FAILURE
#     (visibly red), #521 and #54 have one of SUCCESS, #52 has runs from before
#     the trigger narrowed. Keying on the conflict would flag four PRs that are
#     fine and would MISS any future SHA that loses its run for some other
#     reason — a dispatch that never queued, a deleted run, a workflow file
#     that stopped parsing.
#   * NOT the run's CONCLUSION. A superseded SHA has a run whose verdict job
#     reports FAILURE (verified: run 37103666245 is `conclusion: cancelled`,
#     its verdict job 111149624241 is `failure`), so it is already visibly red
#     and a later commit gets certified. 24 of the 98 runs on one branch
#     sampled on 2026-10-03 were cancelled; flagging them would bury this
#     signal in noise.
#
# So the predicate is about EXISTENCE, and only existence:
#
#   A PR is UNCERTIFIED iff NO `CI (live DB)` run exists for its current head
#   SHA, that SHA is older than the grace window, AND the absence is
#   MEASURABLE — see the horizon below.
#
# A run that is queued, in progress, cancelled or failed all count as EXISTING.
# Every one of those renders in the check list; absence does not.
#
# ── THE HORIZON, AND WHY ABSENCE IS NOT ALWAYS EVIDENCE ──────────────────────
#
# "No run exists for this SHA" has two causes and only one of them is the
# defect. GitHub DELETES workflow runs once the repository's log-retention
# period elapses, and a SHA can also simply predate the workflow. In either
# case a run may genuinely have existed, certified the commit, and then stopped
# being visible. Reporting that as UNCERTIFIED would be a false accusation
# against every long-lived PR, arriving on a schedule, forever.
#
# Repository log retention is NOT readable from the REST surface this job has
# (`GET /repos/{o}/{r}/actions/permissions` returns `enabled` and
# `allowed_actions` and no retention field; retention is a UI/org setting). So
# it is not guessed. The fetcher measures the thing that actually matters
# instead: the `created_at` of the OLDEST `CI (live DB)` run still visible to
# the API. That is a directly observed statement about what the API will still
# show, which is strictly better than a configured number — it also covers the
# case retention cannot, a PR whose head predates the workflow's existence.
#
#   horizon=within   the head SHA is at or after that oldest visible run, so a
#                    run for it WOULD still be listed if one had existed. The
#                    absence is real.
#   horizon=before   the SHA predates the visible history. Absence proves
#                    nothing — the run may have existed and been deleted.
#   horizon=unknown  the horizon could not be established at all.
#
# `before` and `unknown` report UNMEASURABLE, and UNMEASURABLE STILL FAILS.
# This repo's rule is that a check which cannot establish its result does not
# pass (ci.yml's header; run_gate() in
# artifacts/api-server/scripts/run-all-checks.sh), and an unmeasurable census
# is explicitly "the weakest of the three states" rather than a pass. The two
# are counted and named separately so a human reads "this SHA has no
# certification" differently from "I cannot tell whether this SHA was ever
# certified", and the remedy differs: the first wants a run, the second wants a
# human to decide whether an ancient open PR should still be open.
#
# ── THE GRACE WINDOW IS LOAD-BEARING, AND ITS TIMESTAMP IS THE WEAK JOINT ────
#
# Run CREATION is near-instant but it is not synchronous with anything, and
# GitHub delays run creation under load. Without a window a SHA pushed seconds
# ago would be flagged — a false positive on a healthy repository, which is the
# one failure mode that gets a check deleted.
#
# The window is measured from one of two timestamps, and WHICH ONE IS ON EVERY
# LINE because they are not equally sound:
#
#   age_source=first-ci-run   the earliest `created_at` among ALL workflow runs
#                             for this SHA — the moment GitHub's own CI first
#                             saw it. SERVER-GENERATED and not settable by a
#                             committer. Preferred, and used whenever any run
#                             at all exists for the SHA.
#   age_source=commit-date    the head commit's committer date, used only when
#                             NO workflow run of any kind exists for the SHA.
#                             AUTHOR-CONTROLLED: `git commit --date`,
#                             GIT_COMMITTER_DATE, a cherry-pick or an imported
#                             patch can back-date it, and a back-dated head
#                             then looks hours old the instant it is pushed —
#                             a false positive on the push that created it.
#                             A forward-dated one is exempt until its own
#                             stamp passes. The decider cannot repair this; it
#                             says which timestamp it used so the reader can
#                             discount the line, and the fetcher repeats the
#                             caveat in the failure text.
#
# AN UNESTABLISHED AGE IS NOT AN EXEMPTION. A line whose age field does not
# parse is REFUSED (exit 3), not waved through — the alternative is a listing
# that silently exempts everything.
#
# INPUT (stdin): one line per OPEN pull request,
#
#   <pr> <head_sha> <age_seconds> <age_source> <run_state> <gate> <horizon>
#
#   age_source   first-ci-run | commit-date      (see above)
#   run_state    run | no-run                    (a `CI (live DB)` run exists?)
#   gate         the conclusion of that run's
#                `api-server · check:all + live_pulse gate` job — success /
#                failure / cancelled / skipped / none / unknown — or `-` when
#                run_state is `no-run`
#   horizon      within | before | unknown       (see above)
#
# `gate` is the (b) half of the question and is DIAGNOSTIC ONLY: it is printed
# so a reader can see WHY a dirty PR was not flagged (#549's gate failed,
# #521's and #54's succeeded), and it is deliberately not part of the
# predicate — see "NOT the run's CONCLUSION" above. Making it fail the check is
# what would flag the cancelled-and-superseded population.
#
# Blank lines are ignored. Lines that do not parse are REFUSED rather than
# skipped: a listing we cannot parse is not a listing that proves every PR is
# certified.
#
# INPUT (env): LIVE_DB_COVERAGE_GRACE_SECONDS — default 1800 (30 minutes).
#
# OUTPUT (stdout): one `pr=` line per PR, then `checked=`, `covered=`,
# `too_new=`, `uncertified=` and `unmeasurable=` (each list a space-separated
# set of `#<pr>@<sha>`).
#
# EXIT CODES
#   0  every open PR's head SHA has a live-DB run (or is inside the window)
#   1  at least one does not, or at least one could not be measured. The names
#      are printed and the caller must FAIL.
#   3  the listing could not be used. NEVER treated as "everything is fine":
#      "I cannot see a problem" is not "there is no problem". The caller fails.
#   64 usage error
set -uo pipefail

GRACE="${LIVE_DB_COVERAGE_GRACE_SECONDS:-1800}"

if ! printf '%s' "$GRACE" | grep -Eq '^[0-9]+$'; then
  echo "live-db-coverage-decide: LIVE_DB_COVERAGE_GRACE_SECONDS must be a whole number of seconds, got '${GRACE}'" >&2
  exit 64
fi

INPUT="$(cat)"

GATES='success|failure|cancelled|skipped|neutral|timed_out|action_required|stale|none|unknown|-'
LINE_RE="^[0-9]+[[:space:]]+[0-9a-f]{7,40}[[:space:]]+-?[0-9]+[[:space:]]+(first-ci-run|commit-date)[[:space:]]+(run|no-run)[[:space:]]+(${GATES})[[:space:]]+(within|before|unknown)$"

VALID=""
MALFORMED=0
while IFS= read -r line; do
  [ -z "${line//[[:space:]]/}" ] && continue
  if printf '%s\n' "$line" | grep -Eq "$LINE_RE"; then
    VALID="${VALID}${line}"$'\n'
  else
    MALFORMED=1
    echo "live-db-coverage-decide: unparseable listing line: ${line}" >&2
  fi
done <<< "$INPUT"

if [ "$MALFORMED" -ne 0 ]; then
  echo "live-db-coverage-decide: refusing to decide from a listing that did not parse" >&2
  exit 3
fi

VALID="$(printf '%s' "$VALID" | sed '/^$/d')"

# AN EMPTY LISTING IS NOT THIS SCRIPT'S CALL TO MAKE.
#
# "No open pull requests" and "the fetcher handed me nothing" are the same
# bytes here, and only the fetcher can tell them apart — it is the half that
# saw the HTTP response, and it cross-checks an empty pulls listing against the
# repository's own open-issue count before it ever reaches this script (see its
# header). So an empty listing is reported as the vacuous state it is, in those
# words, and the FETCHER owns whether that state is legitimate.
if [ -z "$VALID" ]; then
  echo "checked=0"
  echo "covered=0"
  echo "too_new=0"
  echo "uncertified="
  echo "unmeasurable="
  echo "live-db-coverage-decide: the listing is empty — NOTHING was certified and nothing was checked. This is vacuous, not clean; the fetcher decides whether an empty listing is legitimate." >&2
  exit 0
fi

CHECKED=0
COVERED=0
TOO_NEW=0
UNCERTIFIED=""
UNMEASURABLE=""

while IFS= read -r line; do
  PR="$(printf '%s' "$line" | awk '{print $1}')"
  SHA="$(printf '%s' "$line" | awk '{print $2}')"
  AGE="$(printf '%s' "$line" | awk '{print $3}')"
  SRC="$(printf '%s' "$line" | awk '{print $4}')"
  STATE="$(printf '%s' "$line" | awk '{print $5}')"
  GATE="$(printf '%s' "$line" | awk '{print $6}')"
  HORIZON="$(printf '%s' "$line" | awk '{print $7}')"
  CHECKED=$(( CHECKED + 1 ))

  if [ "$STATE" = "run" ]; then
    COVERED=$(( COVERED + 1 ))
    echo "pr=${PR} sha=${SHA} verdict=covered gate=${GATE}"
    continue
  fi

  # A negative age means the SHA is stamped in the future relative to this
  # runner. Treat it as INSIDE the window rather than as a finding: a clock
  # disagreement, or a forward-dated commit, is not evidence that a run is
  # missing. It is still printed, with its source, so it is not silent.
  if [ "$AGE" -lt "$GRACE" ]; then
    TOO_NEW=$(( TOO_NEW + 1 ))
    echo "pr=${PR} sha=${SHA} verdict=inside-window age=${AGE}s grace=${GRACE}s age_source=${SRC}"
    continue
  fi

  if [ "$HORIZON" = "within" ]; then
    UNCERTIFIED="${UNCERTIFIED}#${PR}@${SHA} "
    echo "pr=${PR} sha=${SHA} verdict=UNCERTIFIED age=${AGE}s age_source=${SRC} horizon=within"
    continue
  fi

  # `before` or `unknown`. The absence is not evidence, and silence is not an
  # option either — see THE HORIZON in the header.
  UNMEASURABLE="${UNMEASURABLE}#${PR}@${SHA} "
  echo "pr=${PR} sha=${SHA} verdict=UNMEASURABLE age=${AGE}s age_source=${SRC} horizon=${HORIZON}"
done <<< "$VALID"

echo "checked=${CHECKED}"
echo "covered=${COVERED}"
echo "too_new=${TOO_NEW}"
echo "uncertified=${UNCERTIFIED% }"
echo "unmeasurable=${UNMEASURABLE% }"

if [ -n "$UNCERTIFIED" ] || [ -n "$UNMEASURABLE" ]; then
  exit 1
fi
exit 0
