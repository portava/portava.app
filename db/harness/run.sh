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

# ── the base schema the 2400+ migrations assume ───────────────────────────────
echo "== base schema =="
"${P[@]}" -f "$HERE/base_tables.sql"

# ── the authz functions the kernel calls, sliced from the real migrations ─────
echo "== authz (sliced from 2334 / 2337) =="
: > "$DATA/authz.sql"
while IFS='|' read -r f a b; do
  f="$(trim "$f")"; a="$(trim "$a")"; b="$(trim "$b")"
  [ -z "$f" ] && continue
  case "$f" in \#*) continue;; esac
  sed -n "${a},${b}p" "$REPO/$f" >> "$DATA/authz.sql"
  printf '\n' >> "$DATA/authz.sql"
done < "$HERE/authz.txt"
grep -q 'authz.is_accepted_trip_member' "$DATA/authz.sql" || { echo "FAIL: the authz slice is wrong"; exit 2; }
grep -q 'authz.is_trip_crew'            "$DATA/authz.sql" || { echo "FAIL: the authz slice is wrong"; exit 2; }
"${P[@]}" -f "$DATA/authz.sql"

# ── the CANONICAL KERNEL ANCESTRY: real migrations, in order ──────────────────
# Each is run whole, so its own preconditions and postconditions decide whether
# it may apply. Nothing is sliced and nothing is transcribed.
echo "== kernel ancestry =="
while read -r k; do
  k="$(trim "$k")"; [ -z "$k" ] && continue
  case "$k" in \#*) continue;; esac
  echo "   $(basename "$k")"
  "${P[@]}" -f "$REPO/$k"
  # The prosrc md5 after each step. These are the values a real database must
  # reproduce EXACTLY once the same file has been applied to it; anything else
  # means the SQL that reached it was not the SQL in this tree.
  echo "     prosrc md5 $(psql -h "$SOCK" -p "$PORT" -U postgres -tAc \
    "select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='trip_kernel_execute'")"
done < "${KERNEL_CHAIN_FILE:-$HERE/kernel_chain.txt}"

# The ancestry must have produced the kernel the repo's 2590 describes, and the
# harness says so by NAME rather than by trusting that four files ran clean.
for want in CREATE_TRIP JOIN_VIA_LINK SET_TRIP_COVER added_by TRIP_VERSION_CONFLICT; do
  fn | grep -q "$want" || { echo "FAIL: the ancestry did not produce $want"; exit 1; }
done
echo "   ancestry installed: $(fn | wc -c) bytes, all five markers present"

# The ancestry's OWN families, probed before any transform, so a failure here
# belongs to 2450/2500/2590 and not to a 276x file.
if [ -f "$HERE/probe_kernel_ancestry.sql" ]; then
  echo "== probes: the ancestry itself =="
  psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -f "$HERE/probe_kernel_ancestry.sql"
fi

echo "== schema migrations (the real files, their own postconditions included) =="
while read -r t; do
  t="$(trim "$t")"; [ -z "$t" ] && continue
  case "$t" in \#*) continue;; esac
  echo "   $(basename "$t")"
  "${P[@]}" -f "$REPO/$t"
done < "$TABLES"

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
