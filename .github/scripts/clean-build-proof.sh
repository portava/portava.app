#!/usr/bin/env bash
# =============================================================================
# clean-build-proof.sh  —  RECONCILIATION-PACKET §6.6, requirement 9
# =============================================================================
# Proves a clean database can be rebuilt from  baseline  +  canonical(>= "2100")
# and that BOTH audits (audit:schema, audit:live-unexplained) then exit 0 against
# the rebuilt schema. This is the counterpart to the already-green read-only prod
# run: rebuilt=0 AND prod=0  =>  live and the canonical model are the same model.
#
# ---------------------------------------------------------------------------
# THIS SCRIPT IS DESTRUCTIVE. It runs `DROP SCHEMA public CASCADE` and rebuilds.
# It is safe ONLY because it targets the SANCTIONED CI Supabase project and
# refuses to run against anything else — see the SAFETY CHAIN below. It is wired
# to a workflow_dispatch-ONLY workflow (.github/workflows/clean-build-proof.yml)
# so it can NEVER run automatically on push / PR / schedule.
# ---------------------------------------------------------------------------
#
# SAFETY CHAIN — every check aborts (exit 1) BEFORE a single destructive
# statement. Two independent gates, because they cover two different targets:
#
#   GATE 1  assert-nonprod-supabase.sh
#           Guards the SUPABASE_URL / env-var path: SUPABASE_URL must resolve to
#           CI_SUPABASE_PROJECT_REF and must not be KNOWN_PROD_PROJECT_REF, plus
#           the coverage preconditions (no supabase CLI, no linked-project.json,
#           no config.toml). This is the same gate the audits import in-process.
#
#   GATE 2  psql-target ref check (this file)
#           assert-nonprod validates only the SUPABASE_URL ref. The DROP runs
#           over a libpq connection string, which that gate CANNOT see. So we
#           parse the project ref out of the connection string ourselves and
#           require it to equal CI_SUPABASE_PROJECT_REF and differ from
#           KNOWN_PROD_PROJECT_REF. A connection string pointing anywhere else
#           — production included — is refused here, before psql is invoked.
#
# REQUIRED ENVIRONMENT (all provided by the workflow from GitHub secrets/vars):
#   CLEAN_BUILD_DATABASE_URL  libpq connection string for the SANCTIONED CI
#                             project's Postgres (session pooler or direct). The
#                             ONE new secret the operator must provision; it must
#                             resolve to CI_SUPABASE_PROJECT_REF or GATE 2 refuses.
#   CI_SUPABASE_PROJECT_REF   the sanctioned CI project ref (the only allowed target)
#   KNOWN_PROD_PROJECT_REF    the production ref (denylist backstop)
#   SUPABASE_URL              the sanctioned CI project URL (for assert-nonprod
#                             + the rebuilt-DB audits)
#   SUPABASE_PROJECT_TOKEN    Management-API token for the audits
#
# UNTESTED-ON-FIRST-RUN NOTE: §6.6 shipped as a specification the packet author
# could not execute ("there is no database here"). This implements it faithfully
# and handles the one collision known statically (the baseline recreates schemas
# `public` and `storage`, which already exist on a Supabase project — both
# CREATE SCHEMA lines are stripped). The first real run may surface further
# baseline-vs-live-project interactions (e.g. storage-object policies, roles)
# that need small follow-ups; that is expected and is why this job is manual and
# isolated. It never touches production regardless.
# =============================================================================
set -euo pipefail

log()    { printf '\n\033[1m» %s\033[0m\n' "$*"; }
refuse() { printf '\n\033[31m✖ REFUSED: %s\033[0m\n' "$*" >&2; exit 1; }

# --- locate repo root + the sibling assert script --------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$REPO_ROOT/artifacts/api-server"
BASELINE="$API_DIR/baseline/20260819_baseline_structure.sql"
MIG_DIR="$API_DIR/src/migrations"
ASSERT="$SCRIPT_DIR/assert-nonprod-supabase.sh"

[ -f "$ASSERT" ]   || refuse "assert-nonprod-supabase.sh not found at $ASSERT"
[ -f "$BASELINE" ] || refuse "baseline not found at $BASELINE"
command -v psql >/dev/null 2>&1 || refuse "psql not on PATH (install postgresql-client)"

# --- required env ----------------------------------------------------------
: "${CLEAN_BUILD_DATABASE_URL:?CLEAN_BUILD_DATABASE_URL is required}"
: "${CI_SUPABASE_PROJECT_REF:?CI_SUPABASE_PROJECT_REF is required}"
: "${KNOWN_PROD_PROJECT_REF:?KNOWN_PROD_PROJECT_REF is required}"

# =============================================================================
# GATE 1 — the SUPABASE_URL / env-var allowlist (same gate the audits use)
# =============================================================================
log "GATE 1: assert-nonprod-supabase.sh"
bash "$ASSERT" || refuse "assert-nonprod-supabase.sh refused the SUPABASE_URL target"

# =============================================================================
# GATE 2 — the psql connection-string target ref (the gap GATE 1 cannot see)
# =============================================================================
log "GATE 2: psql target ref"
# Supabase connection strings carry the ref two ways:
#   session pooler : postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
#   direct         : postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
PSQL_REF="$(printf '%s' "$CLEAN_BUILD_DATABASE_URL" | sed -nE 's#.*://postgres\.([a-z0-9]+):.*#\1#p')"
[ -n "$PSQL_REF" ] || PSQL_REF="$(printf '%s' "$CLEAN_BUILD_DATABASE_URL" | sed -nE 's#.*@db\.([a-z0-9]+)\.supabase\.co.*#\1#p')"

[ -n "$PSQL_REF" ] || refuse "could not parse a project ref from CLEAN_BUILD_DATABASE_URL (expected a Supabase pooler or direct connection string)"
[ "$PSQL_REF" = "$CI_SUPABASE_PROJECT_REF" ] || refuse "psql target ref '$PSQL_REF' is not the sanctioned CI ref '$CI_SUPABASE_PROJECT_REF'"
[ "$PSQL_REF" != "$KNOWN_PROD_PROJECT_REF" ] || refuse "psql target ref '$PSQL_REF' IS the production ref — refusing"

printf '\033[32m✔ psql target verified: %s (sanctioned CI, not prod)\033[0m\n' "$PSQL_REF"

PSQL=(psql "$CLEAN_BUILD_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -w)

# Belt-and-suspenders: prove at the wire that we are NOT on the prod ref, by
# asking the server which project ref it thinks it is (Supabase sets it), and
# abort if it somehow matches prod despite the string check above.
SERVER_REF="$("${PSQL[@]}" -tA -c "select coalesce(current_setting('supabase.project_ref', true), '')" 2>/dev/null || true)"
if [ -n "$SERVER_REF" ] && [ "$SERVER_REF" = "$KNOWN_PROD_PROJECT_REF" ]; then
  refuse "the live server reports it is the PRODUCTION project ($SERVER_REF) — refusing"
fi

# =============================================================================
# REBUILD  (all gates passed — this is the sanctioned CI project)
# =============================================================================
log "STEP 1/4: DROP + recreate public (per §6.6)"
"${PSQL[@]}" -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; GRANT ALL ON SCHEMA public TO postgres;'

log "STEP 2/4: install the extension census (pgcrypto is required)"
# The baseline is a raw pg_dump with 0 CREATE EXTENSION; these seven are the
# live set recorded in explainedLiveObjects.ts. pgcrypto is required by
# gen_random_bytes(); the rest match live so audit:live-unexplained sees parity.
for EXT in pgcrypto plpgsql pg_stat_statements postgis unaccent uuid-ossp supabase_vault; do
  if "${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS \"$EXT\";"; then
    printf '   ✔ %s\n' "$EXT"
  else
    # Non-fatal: a genuinely-required extension missing will surface loudly when
    # the baseline apply below references its types/functions under ON_ERROR_STOP.
    printf '   ⚠ %s could not be installed on this project (continuing)\n' "$EXT"
  fi
done

log "STEP 3/4: apply the baseline (schemas public+storage already exist → strip their CREATE SCHEMA)"
# Both `CREATE SCHEMA public;` and `CREATE SCHEMA storage;` collide with the
# freshly-created public and the Supabase-managed storage schema; drop just
# those two lines. Everything else (tables, policies, functions, …) applies.
sed -E '/^CREATE SCHEMA (public|storage);$/d' "$BASELINE" | "${PSQL[@]}" -f -

log "STEP 4/4: apply canonical migrations sorting >= \"2100\" (post-cutover), in (numeric-prefix, filename) order"
# Lexical >= "2100" is the exact cutover test (packet §6.1). Empty today (highest
# canonical prefix is 2095) — logged, not errored — but correct when 2100+ land.
POST_CUTOVER=()
if [ -d "$MIG_DIR" ]; then
  while IFS= read -r f; do POST_CUTOVER+=("$f"); done < <(
    ls -1 "$MIG_DIR" 2>/dev/null | grep -E '\.sql$' | awk 'substr($0,1,4) >= "2100"' | sort
  )
fi
if [ "${#POST_CUTOVER[@]}" -eq 0 ]; then
  echo "   (none — no canonical migration sorts >= \"2100\" yet; the model rests on the baseline)"
else
  for f in "${POST_CUTOVER[@]}"; do
    echo "   applying $f"
    "${PSQL[@]}" -f "$MIG_DIR/$f"
  done
fi

# =============================================================================
# PROOF — both audits must exit 0 against the REBUILT sanctioned-CI database.
# The audits reach the DB via the Management API (SUPABASE_URL + token); they
# import the guards, so they too refuse anything but the sanctioned CI project.
# =============================================================================
RUN_AUDIT="$REPO_ROOT/.github/scripts/pnpm-run.sh"

log "PROOF 1/2: audit:schema against the rebuilt DB (expect exit 0)"
bash "$RUN_AUDIT" artifacts/api-server @workspace/api-server audit:schema \
  || refuse "audit:schema did NOT exit 0 against the rebuilt DB — the baseline+canonical set does not reproduce the model"

log "PROOF 2/2: audit:live-unexplained against the rebuilt DB (expect exit 0)"
bash "$RUN_AUDIT" artifacts/api-server @workspace/api-server audit:live-unexplained \
  || refuse "audit:live-unexplained did NOT exit 0 against the rebuilt DB — the rebuilt schema carries objects the model does not explain"

log "CLEAN-BUILD PROOF PASSED"
cat <<'DONE'
────────────────────────────────────────────────────────────────────────────
✔ A clean database was rebuilt from baseline + canonical(>= "2100") on the
  sanctioned CI project, and BOTH audits exit 0 against it.
  Combined with the already-green read-only prod run of audit:live-unexplained,
  this is ruling 10's live diff: rebuilt ≡ model ≡ prod.
────────────────────────────────────────────────────────────────────────────
DONE
