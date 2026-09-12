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
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test --test-reporter=tap $FILES | tee "$OUT"
rc=${PIPESTATUS[0]}
set -e
pass=$(grep -E '^# pass ' "$OUT" | awk '{print $3}'); skip=$(grep -E '^# skipped ' "$OUT" | awk '{print $3}'); fail=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
echo "local-db tests: pass=${pass:-?} fail=${fail:-?} skipped=${skip:-?} (exit $rc)"
[ "$rc" = "0" ] || exit "$rc"
[ "${skip:-1}" = "0" ] || { echo "::error::local-db: ${skip:-?} test(s) skipped — a skipped database test verified nothing" >&2; exit 1; }
[ "${pass:-0}" -gt 0 ] || { echo "::error::local-db: no test passed" >&2; exit 1; }
