#!/usr/bin/env bash
# up.sh — a THROWAWAY PostgreSQL carrying the trip domain's real schema, so
# kernel SQL is EXECUTED by tests instead of read as text.
#
# What it builds, in order:
#   1. shim.sql            — the Supabase surface the chain references (roles, auth schema, PostGIS)
#   2. the baseline        — baseline/20260819_baseline_structure.sql (production's structure, no rows)
#   3. the canonical chain — src/migrations/*.sql from $LOCAL_DB_FROM (default 2093, the first
#                            file whose objects the baseline lacks) in byte order, each file as
#                            psql runs it. A file may fail ONLY if KNOWN_UNREPLAYABLE.json names it.
#
# What it is NOT: a drift audit. docs/ci/BOOTSTRAP.md §1 explains why replaying the
# chain into the CI project would make check:schema-references vacuous; this database
# is never the target of those checks and never holds real data. It exists so that
# `src/test/db/*.db.test.ts` can run command -> event -> outbox -> projection -> replay
# against the functions the migrations actually define.
#
# Two modes:
#   LOCAL_DB_URL set   — use that server (CI: a postgis/postgis service container).
#                        The database named in the URL is created if absent.
#   LOCAL_DB_URL unset — boot a cluster with initdb under $LOCAL_DB_DIR (default
#                        /tmp/portava-local-db) on $LOCAL_DB_PORT (default 54329). As
#                        root, PostgreSQL refuses to start, so the cluster runs as the
#                        unprivileged user $LOCAL_DB_USER (default portava_localdb,
#                        created if missing).
# Writes scripts/local-db/.env.local-db with LOCAL_DB_URL for run-tests.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
API=$(cd "$HERE/../.." && pwd)
BASELINE="$API/baseline/20260819_baseline_structure.sql"
MIGRATIONS="$API/src/migrations"
FROM="${LOCAL_DB_FROM:-2093}"
# Exclusive upper bound, for before/after proofs of one migration: LOCAL_DB_TO=2779 stops before 2779.
TO="${LOCAL_DB_TO:-}"
KNOWN="$HERE/KNOWN_UNREPLAYABLE.json"
ENV_OUT="$HERE/.env.local-db"
WORK="${LOCAL_DB_WORK:-/tmp/portava-local-db-work}"
mkdir -p "$WORK"

log() { printf '%s\n' "local-db: $*"; }
die() { printf '%s\n' "::error::local-db: $*" >&2; exit 1; }

if [ -n "${LOCAL_DB_URL:-}" ]; then
  URL="$LOCAL_DB_URL"
  MODE=external
else
  MODE=booted
  DIR="${LOCAL_DB_DIR:-/tmp/portava-local-db}"
  PORT="${LOCAL_DB_PORT:-54329}"
  PG_BIN="${PG_BIN:-}"
  if [ -z "$PG_BIN" ]; then
    if command -v initdb >/dev/null 2>&1; then PG_BIN=$(dirname "$(command -v initdb)");
    else PG_BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1); fi
  fi
  [ -x "$PG_BIN/initdb" ] || die "no PostgreSQL server binaries found (install postgresql-16 and postgresql-16-postgis-3, or set PG_BIN)"
  RUN_AS=""
  if [ "$(id -u)" = "0" ]; then
    U="${LOCAL_DB_USER:-portava_localdb}"
    id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
    mkdir -p "$DIR"; chown "$U" "$DIR"
    RUN_AS="su $U -c"
  else
    mkdir -p "$DIR"
  fi
  run() { if [ -n "$RUN_AS" ]; then $RUN_AS "$*"; else bash -c "$*"; fi; }
  if [ ! -f "$DIR/data/PG_VERSION" ]; then
    log "initdb -> $DIR/data"
    run "$PG_BIN/initdb -D $DIR/data -U postgres --auth=trust -E UTF8 >/dev/null"
  fi
  if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
    log "starting on 127.0.0.1:$PORT"
    run "$PG_BIN/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off' -l $DIR/pg.log start >/dev/null"
    for i in $(seq 1 30); do "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break; sleep 1; done
  fi
  URL="postgresql://postgres@127.0.0.1:$PORT/portava_local"
fi

# ── the database ──────────────────────────────────────────────────────────────
DBNAME="${URL##*/}"; DBNAME="${DBNAME%%\?*}"
ADMIN_URL="${URL%/*}/postgres"
if [ "${LOCAL_DB_FRESH:-1}" = "1" ]; then
  psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DBNAME\"" >/dev/null
fi
psql -X -tA "$ADMIN_URL" -c "SELECT 1 FROM pg_database WHERE datname = '$DBNAME'" | grep -q 1 \
  || psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "CREATE DATABASE \"$DBNAME\"" >/dev/null

# ── 1. shim ───────────────────────────────────────────────────────────────────
psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$HERE/shim.sql" >"$WORK/shim.out" 2>&1 || { cat "$WORK/shim.out"; die "shim failed"; }
psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c "ALTER DATABASE \"$DBNAME\" SET search_path = \"\$user\", public, extensions" >/dev/null

# ── 2. baseline ───────────────────────────────────────────────────────────────
# The dump is PostgreSQL 17's. Exactly three statement shapes fail on 16 and none
# of them creates an object: the MAINTAIN privilege, the transaction_timeout GUC,
# and the dump's own `CREATE SCHEMA public`. Any other error is a real gap.
psql -X -q "$URL" -f "$BASELINE" >"$WORK/baseline.out" 2>&1 || true
OTHER=$(grep 'ERROR' "$WORK/baseline.out" \
  | grep -v 'unrecognized privilege type "maintain"' \
  | grep -v 'unrecognized configuration parameter "transaction_timeout"' \
  | grep -v 'schema "public" already exists' || true)
if [ -n "$OTHER" ]; then printf '%s\n' "$OTHER" | head -20; die "baseline restore produced errors outside the three PostgreSQL-17-only shapes"; fi
TABLES=$(psql -X -tA "$URL" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$TABLES" -ge 380 ] || die "baseline restored only $TABLES public tables (expected >= 380)"

# ── 3. the chain ──────────────────────────────────────────────────────────────
applied=0; skipped=0; n=0
for f in $(ls "$MIGRATIONS"/*.sql | LC_ALL=C sort); do
  b=$(basename "$f"); [[ "$b" < "$FROM" ]] && continue
  if [ -n "$TO" ] && ! [[ "$b" < "$TO" ]]; then continue; fi
  n=$((n+1))
  if psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$f" >"$WORK/last.out" 2>&1; then
    applied=$((applied+1))
    # A listed file that replays IN ORDER is a stale entry: the list may only shrink.
    if node -e 'const k=require(process.argv[1]).files; process.exit(k[process.argv[2]] ? 0 : 1)' "$KNOWN" "$b"; then STALE="${STALE:-} $b"; fi
  else
    err=$(grep -m1 'ERROR' "$WORK/last.out" | sed 's/^psql:[^:]*:[0-9]*: //' || true)
    if node -e 'const k=require(process.argv[1]).files; process.exit(k[process.argv[2]] ? 0 : 1)' "$KNOWN" "$b"; then
      skipped=$((skipped+1)); log "skipped (known unreplayable) $b :: ${err:0:120}"
    else
      printf '%s\n' "$err"; die "$b failed and is not in KNOWN_UNREPLAYABLE.json"
    fi
  fi
done
[ -z "${STALE:-}" ] || die "KNOWN_UNREPLAYABLE.json names file(s) that replay cleanly in order; remove them:$STALE"
# Second pass: a known-unreplayable file whose precondition a LATER file satisfies
# (2136's FK rulings arrive in 2138) is retried once after the chain. Order-dependent
# and said so; the entry stays in the list because in-order replay still fails.
retried=0
for b in $(node -e 'console.log(Object.keys(require(process.argv[1]).files).join("\n"))' "$KNOWN"); do
  if [ -n "$TO" ] && ! [[ "$b" < "$TO" ]]; then continue; fi
  if psql -X -q -v ON_ERROR_STOP=1 "$URL" -f "$MIGRATIONS/$b" >"$WORK/retry.out" 2>&1; then retried=$((retried+1)); log "applied on retry after the chain: $b"; fi
done

# ── proof the trip domain is there (skipped for a deliberately truncated chain) ─
if [ -z "$TO" ]; then
MISSING=$(psql -X -tA "$URL" -c "SELECT string_agg(t, ', ') FROM unnest(ARRAY['trip_stages','trip_legs','trip_commitments','trip_goals','trip_decision_tasks','trip_risks','trip_presence','trip_proposals','trip_proposal_votes','trip_snapshots','trip_outcomes','trip_plan_participants','trip_events','trip_outbox','trip_command_receipts','trip_map_projections']) t WHERE to_regclass('public.' || t) IS NULL")
[ -z "$MISSING" ] || die "trip-domain tables missing after replay: $MISSING"
psql -X -tA "$URL" -c "SELECT 1 FROM pg_proc WHERE proname = 'trip_kernel_execute'" | grep -q 1 || die "trip_kernel_execute missing after replay"
fi

printf 'LOCAL_DB_URL=%s\nLOCAL_DB_MODE=%s\n' "$URL" "$MODE" > "$ENV_OUT"
log "ready ($MODE): $URL — baseline $TABLES tables; chain from $FROM${TO:+ to before $TO}: $applied applied in order, $skipped known-unreplayable of $n, $retried of those applied on retry"
