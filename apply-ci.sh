#!/usr/bin/env bash
#
# apply-ci.sh — CI hardening: workflows, scripts, and the runtime Supabase chokepoint.
#
# Run from the REPO ROOT (~/workspace) after unzipping ci-drop.zip there.
#
# ─────────────────────────────────────────────────────────────────────────────
#  READ FIRST — WHAT THIS CHANGES ABOUT HOW THE REPO BEHAVES
# ─────────────────────────────────────────────────────────────────────────────
# artifacts/api-server/src/lib/ciSupabaseGuard.mjs is a SIDE-EFFECT IMPORT. Any
# script or test that imports it asserts, IN-PROCESS and before constructing a
# client, that the Supabase project it is about to talk to is the sanctioned
# non-production one. If it cannot prove that, it calls process.exit(2) and
# nothing downstream runs.
#
# That means: AFTER THIS IS APPLIED, the eight guarded scripts REFUSE TO RUN
# unless CI_SUPABASE_PROJECT_REF and KNOWN_PROD_PROJECT_REF are set in the
# environment. That is deliberate — it is what makes the guard unskippable by
# editing YAML — but it WILL change what happens when you run them by hand.
#
# To run any guarded script locally against the CI project:
#     export CI_SUPABASE_PROJECT_REF=hwokxgbmezheskbzskfr
#     export KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb
#
# docs/ci/BOOTSTRAP.md §5.2 covers this. If a check that used to run starts
# exiting 2, this is why, and it is not a bug.
#
# WHAT IS AND IS NOT IN THIS DROP
#   IN:  3 workflows, 5 CI scripts, the chokepoint + its type stub, the
#        Discovery cache diagnostic, docs/ci/{README,BOOTSTRAP}.md, and the
#        guard import added to 8 existing entry points.
#   OUT: the .agents/memory corrections, check-memory-citations.mjs, and the
#        docs/security/admin-authz-audit.md status fix. Those are still being
#        repaired and ship separately, so this drop does not capture them
#        mid-edit.
#
# HOW EXISTING FILES ARE TREATED
#   The 8 entry points are NOT overwritten. This drop was built against
#   13dcfe3 and your tree has moved on (checkMediaObjects.ts gained the feed
#   variant work in c56223a76). Replacing them would silently destroy that.
#   Instead a single import line is INSERTED, idempotently. Nothing else in
#   those files is touched.

set -uo pipefail

ROOT="$(pwd)"
STAGE="$ROOT/_ci"
BACKUP="$ROOT/.ci-backup"
MANIFEST="$STAGE/MANIFEST.sha"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { red "✗ $*"; exit 1; }

echo "──────────────────────────────────────────────"
echo "  CI hardening + Supabase chokepoint — preflight"
echo "──────────────────────────────────────────────"

[ -d "$ROOT/artifacts/api-server" ] || fail "No artifacts/api-server here. Run from the repo root."
[ -d "$STAGE" ] || fail "No _ci/ here. Unzip ci-drop.zip at the repo root first."
[ -f "$MANIFEST" ] || fail "No _ci/MANIFEST.sha — incomplete archive."

# ── 1. Payload integrity ─────────────────────────────────────────────────────
echo "── verifying the archive itself ──"
BAD=0
while read -r EXPECT REL; do
  [ -n "${REL:-}" ] || continue
  [ "$REL" = "MANIFEST.sha" ] && continue
  ACTUAL=$(shasum -a 256 "$STAGE/$REL" 2>/dev/null | cut -d' ' -f1)
  [ "$ACTUAL" = "$EXPECT" ] || { red "  ✗ corrupt in archive: $REL"; BAD=1; }
done < "$MANIFEST"
[ "$BAD" -eq 0 ] || fail "archive is corrupt — re-download"
grn "  ✓ archive intact"

# ── 2. Refuse to clobber ─────────────────────────────────────────────────────
# Every payload file is NEW. If one already exists, this drop has been applied
# before or someone wrote there independently. Either way, stop.
echo
echo "── checking for collisions ──"
COLLIDE=0
while read -r _ REL; do
  [ -n "${REL:-}" ] || continue
  [ "$REL" = "MANIFEST.sha" ] && continue
  if [ -e "$ROOT/$REL" ]; then
    if cmp -s "$STAGE/$REL" "$ROOT/$REL"; then
      ylw "  • already identical: $REL"
    else
      red  "  ✗ EXISTS AND DIFFERS: $REL"; COLLIDE=1
    fi
  fi
done < "$MANIFEST"
if [ "$COLLIDE" -ne 0 ]; then
  echo
  red "REFUSING TO APPLY — at least one target exists with different content."
  red "Diff it against _ci/ and merge by hand. Overwriting could destroy work."
  exit 1
fi
grn "  ✓ no collisions"

# ── 3. Copy the new files ────────────────────────────────────────────────────
echo
echo "── applying new files ──"
N=0
while read -r _ REL; do
  [ -n "${REL:-}" ] || continue
  [ "$REL" = "MANIFEST.sha" ] && continue
  mkdir -p "$ROOT/$(dirname "$REL")"
  cp "$STAGE/$REL" "$ROOT/$REL"
  N=$((N+1))
done < "$MANIFEST"
chmod +x "$ROOT/.github/scripts/"*.sh 2>/dev/null || true
grn "  wrote $N file(s)"

# ── 4. Insert the guard import, idempotently ─────────────────────────────────
# Inserted before the FIRST top-level `import` in each file, so the assertion
# runs before @supabase/supabase-js is even loaded. ES module side-effect
# imports execute in source order — position is the whole mechanism.
echo
echo "── inserting the guard import (idempotent) ──"
mkdir -p "$BACKUP"

GUARDED="
artifacts/api-server/src/scripts/auditMigrationsVsLive.ts
artifacts/api-server/src/scripts/checkMissingLiveColumns.ts
artifacts/api-server/src/scripts/checkMediaObjects.ts
artifacts/api-server/src/scripts/checkWritePathColumns.ts
artifacts/api-server/src/scripts/checkRankEventsSurfaces.ts
artifacts/api-server/src/test/rlsHardening.test.ts
artifacts/api-server/src/test/profileRoleNotSelfWritable.test.ts
artifacts/api-server/src/test/isOfficialPrivileged.test.ts
"

ADDED=0; SKIPPED=0; MISSING=0
for REL in $GUARDED; do
  [ -n "$REL" ] || continue
  DST="$ROOT/$REL"
  if [ ! -f "$DST" ]; then
    red "  ✗ missing, cannot guard: $REL"; MISSING=1; continue
  fi
  if grep -qF 'ciSupabaseGuard.mjs' "$DST"; then
    ylw "  • already guarded: ${REL##*/}"; SKIPPED=$((SKIPPED+1)); continue
  fi
  LINE=$(grep -n '^import ' "$DST" | head -1 | cut -d: -f1)
  if [ -z "$LINE" ]; then
    red "  ✗ no top-level import found, refusing to guess: $REL"; MISSING=1; continue
  fi
  mkdir -p "$BACKUP/$(dirname "$REL")"
  cp "$DST" "$BACKUP/$REL"
  TMP="$(mktemp)"
  awk -v n="$LINE" 'NR==n{
    print "// THE CHOKEPOINT. Side-effect import, deliberately FIRST: it asserts this"
    print "// process is pointed at the sanctioned non-production Supabase project"
    print "// before any client is constructed. Not skippable by editing workflow YAML."
    print "// See src/lib/ciSupabaseGuard.mjs and docs/ci/BOOTSTRAP.md."
    print "import \"../lib/ciSupabaseGuard.mjs\";"
    print ""
  }{print}' "$DST" > "$TMP" && mv "$TMP" "$DST"
  grn "  ✓ guarded ${REL##*/} (before line $LINE)"
  ADDED=$((ADDED+1))
done
[ "$MISSING" -eq 0 ] || fail "at least one entry point could not be guarded — see above"
echo "  added $ADDED, already present $SKIPPED"

# ── 5. Prove the guard actually refuses ──────────────────────────────────────
echo
echo "── proving the chokepoint fails closed ──"
if command -v node >/dev/null 2>&1; then
  OUT=$(cd "$ROOT/artifacts/api-server/src/lib" && \
        env -u KNOWN_PROD_PROJECT_REF -u CI_SUPABASE_PROJECT_REF -u SUPABASE_URL \
        node -e 'import("./ciSupabaseGuard.mjs").catch(()=>{})' 2>&1 || true)
  if printf '%s' "$OUT" | grep -q 'REFUSED'; then
    grn "  ✓ guard refuses when the allowlist is unset (this is the point)"
  else
    red "  ✗ guard did NOT refuse with no allowlist configured."
    red "    That is the one behaviour this whole change depends on. Investigate"
    red "    before trusting anything below. Output was:"
    printf '%s\n' "$OUT" | sed 's/^/      /'
    exit 1
  fi
else
  ylw "  node not found — SKIPPING. Missing tooling is NOT a passing check."
fi

echo
echo "──────────────────────────────────────────────"
grn "  applied — NOTHING DEPLOYED, NOTHING QUERIED, NO SCHEMA LOADED"
echo "──────────────────────────────────────────────"
cat <<'EOF'

WHAT TO DO NEXT, IN ORDER

1. TYPECHECK. The guard is .mjs with a .d.mts stub so the bare side-effect
   import resolves. This is the step most likely to surface a problem:
       cd artifacts/api-server && pnpm run typecheck

2. CONFIRM THE GUARDED CHECKS STILL BEHAVE. They now REFUSE without the
   allowlist. That is correct. To run one deliberately:
       export CI_SUPABASE_PROJECT_REF=hwokxgbmezheskbzskfr
       export KNOWN_PROD_PROJECT_REF=ajrurzioarfkagpuxfnb
       cd artifacts/api-server && pnpm run check:all
   check:all should be unchanged at 8/8 — the guarded scripts are the ones that
   already needed credentials.

3. DO NOT LOAD THE CI SCHEMA YET. Read docs/ci/BOOTSTRAP.md first, all of it.
   The one-line summary: restore production's schema (schema ONLY, no data),
   never replay the 255 migration files. Replaying makes audit:schema compare
   the migrations against a database built from those same migrations — it
   passes by construction and detects nothing.

   §2.5 has a trap worth reading before you touch the dashboard: 2030 runs a
   bare CREATE EXTENSION postgis with no SCHEMA clause, so if you enable postgis
   into a different schema than production's, the dump's own CREATE EXTENSION
   silently no-ops and every spatial column fails — while select postgis_version()
   reports success either way.

4. EXPECT THE FIRST audit:schema RUN TO BE RED, AND EXPECT IT TO BE BORING.
   BOOTSTRAP.md §5.2 lists exactly which objects it will name. That list is a
   known constant, not a discovery. If you see something NOT on it, that is the
   signal.

WHAT THIS DOES NOT GIVE YOU
  auditMigrationsVsLive compares NAME EXISTENCE only, in one direction:
  migrations ⊆ live. It never enumerates live objects that no migration
  declares, and never compares definitions. Widened CHECK constraints, rewritten
  functions and the 12-of-15 untracked triggers stay invisible. A green
  schema-drift means the migrations are a SUBSET of the schema, not that they
  describe it. docs/ci/README.md §7 says this; do not let a green badge say
  otherwise.

  check:media-objects cannot be trusted in CI until a storage fixture exists.
  seed-test-media.ts inserts post_media rows and performs ZERO uploads, so
  running it manufactures 100% dangling rows. BOOTSTRAP.md §4.2.

NOT VERIFIED BY ME
  No node_modules, no database, no runner here. I ran no typecheck, no test, no
  query and no workflow. The guard's refusal above is the one thing executed.
  Everything else was built by reading and reviewed adversarially. Do not read
  "it was reviewed" as "it was run".

COMMIT (explicit paths only — the Agent has uncommitted work in this tree)
  cd ~/workspace && git add \
    .github/workflows/ci.yml \
    .github/workflows/live-db.yml \
    .github/workflows/unwired-checks.yml \
    .github/scripts/assert-ci-scripts.mjs \
    .github/scripts/assert-nonprod-supabase.sh \
    .github/scripts/check-unrunnable-tests.mjs \
    .github/scripts/pnpm-run.sh \
    .github/scripts/run-live-suite.sh \
    docs/ci/README.md \
    docs/ci/BOOTSTRAP.md \
    artifacts/api-server/src/lib/ciSupabaseGuard.mjs \
    artifacts/api-server/src/lib/ciSupabaseGuard.d.mts \
    artifacts/api-server/src/scripts/checkDiscoveryCacheKeys.ts \
    artifacts/api-server/src/scripts/auditMigrationsVsLive.ts \
    artifacts/api-server/src/scripts/checkMissingLiveColumns.ts \
    artifacts/api-server/src/scripts/checkMediaObjects.ts \
    artifacts/api-server/src/scripts/checkWritePathColumns.ts \
    artifacts/api-server/src/scripts/checkRankEventsSurfaces.ts \
    artifacts/api-server/src/test/rlsHardening.test.ts \
    artifacts/api-server/src/test/profileRoleNotSelfWritable.test.ts \
    artifacts/api-server/src/test/isOfficialPrivileged.test.ts \
    && git commit -m "ci: assert the Supabase target in-process, not in workflow YAML"

UNDO
  cp -r .ci-backup/. .          # restores the 8 guarded files
  rm -rf .github docs/ci
  rm artifacts/api-server/src/lib/ciSupabaseGuard.mjs \
     artifacts/api-server/src/lib/ciSupabaseGuard.d.mts \
     artifacts/api-server/src/scripts/checkDiscoveryCacheKeys.ts

CLEANUP
  rm -rf _ci .ci-backup apply-ci.sh ci-drop.zip
EOF
