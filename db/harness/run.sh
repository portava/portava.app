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

# Trim leading/trailing whitespace without a subprocess: xargs treats quotes as
# special and the manifests' comment lines contain apostrophes.
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }

# The chain and the schema migrations it needs are declared in chain.txt and
# tables.txt, not on the command line, so that what is rehearsed is a committed
# fact rather than whatever the last invocation happened to pass.
CHAIN="${CHAIN_FILE:-$HERE/chain.txt}"
TABLES="${TABLES_FILE:-$HERE/tables.txt}"

# Schema-migration rollbacks, rehearsed after the chain has been withdrawn. One
# path per line in schema_rollbacks.txt, run TOP TO BOTTOM — the file is written
# in reverse dependency order, because a rollback list is not a migration list
# read backwards: 2767 undoes a correction to 2763 and must run before it.
SCHEMA_ROLLBACKS="${SCHEMA_ROLLBACKS_FILE:-$HERE/schema_rollbacks.txt}"

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
echo "== schema migrations (the real files, their own postconditions included) =="
while read -r t; do
  t="$(trim "$t")"; [ -z "$t" ] && continue
  case "$t" in \#*) continue;; esac
  echo "   $(basename "$t")"
  "${P[@]}" -f "$REPO/$t"
done < "$TABLES"
echo "== 2590 kernel =="
"${P[@]}" -f "$DATA/2590_fn.sql"
fn > "$DATA/before.txt"

# ── apply the chain ───────────────────────────────────────────────────────────
STEP=0
declare -a MIGS_A ROLLS_A PROBES_A
while IFS='|' read -r m r pr; do
  m="$(trim "$m")"; r="$(trim "$r")"; pr="$(trim "$pr")"
  [ -z "$m" ] && continue
  case "$m" in \#*) continue;; esac
  MIGS_A+=("$m"); ROLLS_A+=("$r"); PROBES_A+=("$pr")
done < "$CHAIN"

for i in "${!MIGS_A[@]}"; do
  m="$REPO/${MIGS_A[$i]}"
  echo "== apply $(basename "$m") =="
  fn > "$DATA/before.$i.txt"
  "${P[@]}" -f "$m"
  fn > "$DATA/after.$i.txt"
  if ! [ "$(wc -c < "$DATA/after.$i.txt")" -gt "$(wc -c < "$DATA/before.$i.txt")" ]; then
    echo "FAIL: $(basename "$m") did not change the function"; exit 1
  fi
  if "${P[@]}" -f "$m" >/dev/null 2>&1; then echo "FAIL: $(basename "$m") applied twice"; exit 1; fi
  echo "   re-apply refused, as designed"
done

# ── probes, against the fully-applied chain ───────────────────────────────────
# The seed is re-run before EACH probe file, so a probe never inherits rows or a
# version number from the one before it. A probe whose expectations depend on
# what ran earlier is a probe that will lie the first time the order changes.
for i in "${!PROBES_A[@]}"; do
  pr="${PROBES_A[$i]}"
  [ -z "$pr" ] && continue
  echo "== probes: $(basename "$pr") =="
  "${P[@]}" -f "$HERE/seed.sql"
  psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -f "$REPO/$pr"
done

# ── roll back in reverse; each must restore its own step byte-for-byte ────────
for (( i=${#ROLLS_A[@]}-1; i>=0; i-- )); do
  r="${ROLLS_A[$i]}"
  echo "== rollback $(basename "$r") =="
  "${P[@]}" -f "$REPO/$r"
  fn > "$DATA/restored.$i.txt"
  if diff -q "$DATA/before.$i.txt" "$DATA/restored.$i.txt" >/dev/null; then
    echo "   round trip: BYTE-IDENTICAL"
  else
    echo "FAIL: $(basename "$r") did not restore the definition"
    diff "$DATA/before.$i.txt" "$DATA/restored.$i.txt" | head -40; exit 1
  fi
  if "${P[@]}" -f "$REPO/$r" >/dev/null 2>&1; then echo "FAIL: $(basename "$r") rolled back twice"; exit 1; fi
  echo "   second rollback refused, as designed"
done

# ── schema rollbacks, once nothing writes the tables any more ─────────────────
if [ -f "$SCHEMA_ROLLBACKS" ]; then
  echo "== schema rollbacks =="
  while read -r sr; do
    sr="$(trim "$sr")"; [ -z "$sr" ] && continue
    case "$sr" in \#*) continue;; esac
    echo "   $(basename "$sr")"
    "${P[@]}" -f "$REPO/$sr"
  done < "$SCHEMA_ROLLBACKS"
fi

echo
echo "HARNESS: PASS"
