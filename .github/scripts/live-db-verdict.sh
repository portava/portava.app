#!/usr/bin/env bash
#
# live-db-verdict.sh — classify a live-DB run into PASS / FAIL / NOT_EXECUTED.
#
# WHY THIS IS A SCRIPT AND NOT INLINE YAML
# ----------------------------------------
# It was inline. A mutation that collapsed NOT_EXECUTED into FAIL survived the
# architecture ratchet, because the only thing asserting the distinction was a
# grep for the word — and the word still appeared in the surrounding comment.
# A guard that greps prose is not testing behaviour. As a script, the classifier
# is unit-tested directly by src/test/ciWorkflowArchitecture.test.ts.
#
# THE THREE STATES
# ----------------
#   PASS          every job ran and succeeded.
#   FAIL          a job ran and reported a real failure.
#   NOT_EXECUTED  a job was cancelled, skipped, or never got the database.
#                 Nothing was verified.
#
# The third state is the reason this file exists. This repo has already shipped
# a defect through the gap between "checked and fine" and "never checked": PR
# #339 showed 20/20 green with zero live-DB entries because its runs were
# evicted before any job started, and `places.country` reached main while the
# guard that catches it was being cancelled 64 times in 100.
#
# FAIL outranks NOT_EXECUTED: if anything genuinely failed, that is the headline,
# and an unknown job state is treated as NOT_EXECUTED rather than assumed good.
# Both exit 1. Only PASS exits 0.
#
# Usage:  live-db-verdict.sh <job>=<result> [<job>=<result> ...]
# Reads:  GITHUB_STEP_SUMMARY (optional)
set -uo pipefail

VERDICT=PASS
FAILED=""
NOT_EXEC=""

for PAIR in "$@"; do
  NAME="${PAIR%%=*}"
  RESULT="${PAIR#*=}"
  case "$RESULT" in
    success)
      ;;
    failure)
      FAILED="$FAILED $NAME"
      VERDICT=FAIL
      ;;
    cancelled|skipped|"")
      NOT_EXEC="$NOT_EXEC $NAME"
      [ "$VERDICT" = "FAIL" ] || VERDICT=NOT_EXECUTED
      ;;
    *)
      # An unrecognised state is an UNKNOWN state, and an unknown state is not a
      # pass. Anything GitHub adds later lands here rather than sliding through.
      NOT_EXEC="$NOT_EXEC ${NAME}(${RESULT})"
      [ "$VERDICT" = "FAIL" ] || VERDICT=NOT_EXECUTED
      ;;
  esac
done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### live-DB certification: $VERDICT"
    echo ""
    echo "| job | result |"
    echo "| --- | --- |"
    for PAIR in "$@"; do echo "| ${PAIR%%=*} | ${PAIR#*=} |"; done
    echo ""
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "live-DB certification: $VERDICT"
for PAIR in "$@"; do echo "  ${PAIR%%=*}: ${PAIR#*=}"; done

if [ "$VERDICT" = "PASS" ]; then
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && \
    echo "> Certified. Every live-DB job executed and passed." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

if [ -n "$FAILED" ]; then
  echo "::error::live-DB certification FAILED. Jobs that ran and failed:${FAILED}. These are real findings — read their logs."
fi
if [ -n "$NOT_EXEC" ]; then
  echo "::error::live-DB certification NOT EXECUTED for:${NOT_EXEC}. A cancelled, skipped, or slot-starved job has verified NOTHING about RLS policies, the profiles.role write boundary, the is_official trigger, or schema drift. Absence of evidence is not a pass — re-run this workflow."
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "> **This run did not certify the live database.**"
    echo ">"
    echo "> Verdict: \`$VERDICT\`"
    [ -n "$FAILED" ]   && echo "> Failed:${FAILED}"
    [ -n "$NOT_EXEC" ] && echo "> Not executed:${NOT_EXEC}"
  } >> "$GITHUB_STEP_SUMMARY"
fi

exit 1
