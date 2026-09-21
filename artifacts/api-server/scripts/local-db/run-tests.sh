#!/usr/bin/env bash
# run-tests.sh — run the database-backed suites against the harness and REFUSE a
# vacuous pass: every test must run (skipped == 0) and at least one must pass.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
API=$(cd "$HERE/../.." && pwd)
[ -f "$HERE/.env.local-db" ] || { echo "::error::local-db: no .env.local-db — run scripts/local-db/up.sh first" >&2; exit 2; }
# shellcheck disable=SC1091
set -a; . "$HERE/.env.local-db"; set +a
cd "$API"
FILES=$(ls src/test/db/*.db.test.ts | tr '\n' ' ')
OUT="${LOCAL_DB_WORK:-/tmp/portava-local-db-work}/tests.tap"
mkdir -p "$(dirname "$OUT")"
set +e
# --test-concurrency=1 IS LOAD-BEARING, not a slowdown someone can tidy away.
#
# `node --test` runs FILES IN PARALLEL by default, and all 19 of these share ONE
# mutable database. They were written serially — each seeds users, does its work
# and deletes by owner_id in an after() hook — and none of them was written to be
# concurrent-safe with the others.
#
# MEASURED 2026-09-13 on CI job 103677862222 (head b3c561dc3), which had passed on
# the head before it and on every head before that: TWO suites died in their
# CLEANUP hook with `deadlock detected`, and the cycle is exactly what parallel
# files produce here —
#
#   process 675/699: DELETE FROM public.trips WHERE owner_id = ...
#                    -> cascade -> DELETE FROM ONLY trip_outbox WHERE event_id = ...
#   process 674:     SELECT public.trip_map_projection_drain(1000, false)
#                    -> DELETE FROM trip_outbox WHERE event_id = ...
#
# Two transactions taking the same trip_outbox rows in different orders. Postgres
# picked one and aborted it; the suite reported a hook failure, and the job was
# red on something no commit in it had touched.
#
# REPRODUCED 2026-09-13 before this line was changed, because CI's timing does not
# occur on every machine and "it passes now" would have proved nothing. Three full
# parallel runs of all 19 suites on the dev box: 89/89, zero deadlocks. Eight more
# runs of just the four colliding suites at --test-concurrency=4: zero. The window
# is narrow. So the CYCLE was reproduced directly instead, on the real table, with
# two psql sessions taking the same two trip_outbox rows in opposite order:
#
#   concurrent, opposite order -> `deadlock detected`, psql exit 3   (1 of 1)
#   the same deletes serialised -> both exit 0                       (0 of 2)
#
# Postgres's message there is the same shape as CI's, down to `psql exited 3`.
# What is proved: the cycle is real and serialising removes it. What is NOT proved
# and is not claimed: that these 19 files can never collide some other way.
#
# This is NOT fixed by retrying the deadlock. A retry would make the symptom rarer
# and leave 19 suites racing each other over one database, where the next collision
# is a torn read somebody has to diagnose from scratch. Serial files remove the
# class.
#
# THE COST, measured on the same box rather than guessed: parallel 13s, serial 37s
# for 89/89. ~24 seconds, once per CI run, to stop a shared-database test harness
# racing itself. That trade is the reason this comment is longer than the flag.
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test --test-concurrency=1 --test-reporter=tap $FILES | tee "$OUT"
rc=${PIPESTATUS[0]}
set -e
pass=$(grep -E '^# pass ' "$OUT" | awk '{print $3}'); skip=$(grep -E '^# skipped ' "$OUT" | awk '{print $3}'); fail=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
echo "local-db tests: pass=${pass:-?} fail=${fail:-?} skipped=${skip:-?} (exit $rc)"
[ "$rc" = "0" ] || exit "$rc"
[ "${skip:-1}" = "0" ] || { echo "::error::local-db: ${skip:-?} test(s) skipped — a skipped database test verified nothing" >&2; exit 1; }
[ "${pass:-0}" -gt 0 ] || { echo "::error::local-db: no test passed" >&2; exit 1; }
