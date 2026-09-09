#!/usr/bin/env bash
# db/harness/run.sh — a local PostgreSQL rehearsal harness for the Trip Kernel.
#
# WHY THIS EXISTS
# ===============
# Neither portava-ci nor production carries the 2590 kernel (both are still at
# 2420), so migration 2764 and every §5 command family after it had no database
# to be rehearsed against. Contract tests can check that TypeScript and SQL
# agree on a command's NAME. They cannot execute it. The first thing this
# harness did on its first run was find a defect no contract test could reach:
# the stage branches never set v_family, so every stage event was filed under
# the plan family. It was fixed before the migration was committed.
#
# WHAT IT PROVES
# ==============
#   * the kernel function COMPILES against the real column lists
#   * a migration's transform applies, and its rollback restores the definition
#     BYTE-FOR-BYTE
#   * commands actually EXECUTE: rows written, events emitted with the right
#     type and family, trips.version bumped, receipts and outbox rows agreeing
#   * refusals actually REFUSE, and leave no partial state behind
#
# WHAT IT DOES NOT PROVE
# ======================
#   * anything about Supabase. This is a bare PostgreSQL 16 cluster: no
#     extensions beyond core, no auth schema, no PostgREST, no realtime.
#   * enum labels. member_role / trip_status / trip_visibility /
#     tag_permission_level are stubbed as text DOMAINs, so a bad label is
#     accepted here and would be refused in a real database.
#   * RLS. Policies are created but every probe runs as superuser, which
#     bypasses them — the same bypass service_role has in production, which is
#     why the probes are still meaningful for the kernel's own writes.
#   * anything about the tables the stubs stand in for. tables.sql carries only
#     column names and types, copied from portava-ci; upgrade.sql adds back the
#     keys and defaults the kernel's writes actually depend on. A constraint
#     that exists in portava-ci and not here will not refuse anything here.
#     The one exception is trip_stages, which is created by running the REAL
#     2760 migration, constraints and all.
#
# A green run here is NOT a rehearsal on portava-ci and NOT permission to touch
# production. It is the strongest evidence available while both databases sit
# behind the repository.
#
# USAGE:  db/harness/run.sh [migration.sql [rollback.sql [probe.sql]]]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MIGS="$REPO/artifacts/api-server/src/migrations"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="${PGDATA_DIR:-/var/tmp/pgdata-harness}"
SOCK="${PGSOCK_DIR:-/var/tmp/pgsock-harness}"
PORT="${PGPORT_HARNESS:-55432}"

MIGRATION="${1:-$MIGS/2764_trip_kernel_stage_family.sql}"
ROLLBACK="${2:-$REPO/db/rollback/2026-09-09-2764-trip-kernel-stage-family-rollback.sql}"
PROBE="${3:-$HERE/probe_stage_family.sql}"

command -v "$PGBIN/initdb" >/dev/null || { echo "no PostgreSQL 16 at $PGBIN"; exit 2; }
id postgres >/dev/null 2>&1 || useradd -m postgres

"$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$DATA"; mkdir -p "$DATA" "$SOCK"; chown -R postgres "$DATA" "$SOCK"
su postgres -c "$PGBIN/initdb -D $DATA -A trust -U postgres" >/dev/null
# Socket-only: the harness must never contend for a TCP port with anything
# else on the machine, including a previous run of itself.
echo "listen_addresses = ''" >> "$DATA/postgresql.conf"
su postgres -c "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k $SOCK' -l $DATA/pg.log start" >/dev/null
trap 'su postgres -c "$PGBIN/pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 20); do "$PGBIN/pg_isready" -h "$SOCK" -p "$PORT" >/dev/null 2>&1 && break; sleep 0.5; done

P=(psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
fn() { psql -h "$SOCK" -p "$PORT" -U postgres -tAc \
  "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='trip_kernel_execute'"; }

# The 2590 kernel body, sliced out of the migration rather than copied, so this
# harness can never drift from the file it is rehearsing.
K="$MIGS/2590_trip_kernel_add_plan_attachment_columns.sql"
S=$(grep -n '^CREATE OR REPLACE FUNCTION public.trip_kernel_execute' "$K" | cut -d: -f1)
E=$(grep -n '^\$fn\$;' "$K" | cut -d: -f1)
[ -n "$S" ] && [ -n "$E" ] || { echo "cannot locate the 2590 function body"; exit 2; }
sed -n "${S},${E}p" "$K" > "$DATA/2590_fn.sql"

# 2450's receipt/event column changes, likewise sliced, not transcribed.
A=$(grep -n '^ALTER TABLE public.trip_events' "$MIGS/2450_trip_kernel_trip_and_participant_families.sql" | head -1 | cut -d: -f1)
B=$(grep -n 'trip_command_receipts_actor_present CHECK' "$MIGS/2450_trip_kernel_trip_and_participant_families.sql" | head -1 | cut -d: -f1)
sed -n "${A},${B}p" "$MIGS/2450_trip_kernel_trip_and_participant_families.sql" > "$DATA/2450_ddl.sql"
grep -q 'actor_role' "$DATA/2450_ddl.sql" || { echo "2450 DDL slice looks wrong"; exit 2; }

echo "== scaffold =="
"${P[@]}" -f "$HERE/scaffold.sql"
"${P[@]}" -f "$HERE/tables.sql"
"${P[@]}" -f "$HERE/upgrade.sql"
"${P[@]}" -f "$DATA/2450_ddl.sql"
echo "== 2760 (the real migration, its own postconditions included) =="
"${P[@]}" -f "$MIGS/2760_trip_stages.sql"
echo "== 2590 kernel =="
"${P[@]}" -f "$DATA/2590_fn.sql"
fn > "$DATA/before.txt"

echo "== apply $(basename "$MIGRATION") =="
"${P[@]}" -f "$MIGRATION"
fn > "$DATA/after.txt"
[ "$(wc -c < "$DATA/after.txt")" -gt "$(wc -c < "$DATA/before.txt")" ] || { echo "FAIL: the migration did not change the function"; exit 1; }

echo "== re-apply must REFUSE =="
if "${P[@]}" -f "$MIGRATION" >/dev/null 2>&1; then echo "FAIL: applied twice"; exit 1; fi
echo "   refused, as designed"

echo "== probes =="
"${P[@]}" -f "$HERE/seed.sql"
psql -h "$SOCK" -p "$PORT" -U postgres -f "$PROBE"

echo "== rollback =="
"${P[@]}" -f "$ROLLBACK"
fn > "$DATA/restored.txt"
if diff -q "$DATA/before.txt" "$DATA/restored.txt" >/dev/null; then
  echo "   round trip: BYTE-IDENTICAL"
else
  echo "FAIL: the rollback did not restore the definition"; diff "$DATA/before.txt" "$DATA/restored.txt" | head -40; exit 1
fi

echo "== rollback again must REFUSE =="
if "${P[@]}" -f "$ROLLBACK" >/dev/null 2>&1; then echo "FAIL: rolled back twice"; exit 1; fi
echo "   refused, as designed"

echo
echo "HARNESS: PASS"
