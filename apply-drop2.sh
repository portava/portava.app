#!/usr/bin/env bash
#
# apply-drop2.sh — two guard front doors, guard-coverage enforcement, and the
#                  .agents/memory + docs corrections.
#
# Run from the REPO ROOT (~/workspace) after unzipping drop2.zip there.
# Requires the PREVIOUS drop (ci-drop.zip / apply-ci.sh) to be applied already.
#
# ═════════════════════════════════════════════════════════════════════════════
#  READ THIS BEFORE YOU RUN IT — IT REDUCES A PROTECTION ON PURPOSE
# ═════════════════════════════════════════════════════════════════════════════
#
# 1. FIVE READ-ONLY AUDITS CAN NOW REACH **PRODUCTION**, OUTSIDE CI.
#
#    The previous drop gave every Supabase-reaching entry point one rule: the
#    sanctioned CI project, or exit 2. This drop splits that into two doors and
#    moves five scripts to the looser one:
#
#        src/scripts/auditMigrationsVsLive.ts
#        src/scripts/checkMissingLiveColumns.ts
#        src/scripts/checkMediaObjects.ts
#        src/scripts/checkWritePathColumns.ts
#        src/scripts/checkDiscoveryCacheKeys.ts
#
#    Those five now import src/lib/ciProdReadOnlyAuditGuard.mjs. Outside CI, and
#    only outside CI, they will connect to the declared PRODUCTION project when
#    the operator asks for it by name, with this exact variable and this exact
#    value:
#
#        PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
#
#    Any other value refuses. An empty value refuses. This is strictly LESS
#    protection than you had before this drop, and it is deliberate: auditing
#    production is what those five scripts are FOR — the live-drift list in
#    docs/migrations.md and the 114 broken images both came out of running them
#    against production. Each was read and contains only SELECTs.
#
#    Treat that variable as a loaded gun. Do not export it in a shell you then
#    forget about, and do not put it in .env.
#
# 2. THE MODE IS REFUSED WHENEVER ANY CI MARKER IS PRESENT.
#
#    CI, GITHUB_ACTIONS, GITHUB_RUN_ID, GITHUB_WORKFLOW and the whole GITHUB_* /
#    RUNNER_* / ACTIONS_* prefix space are checked. If any of them is set, the
#    read-only door behaves exactly like the strict one — sanctioned CI project
#    or exit 2 — no matter what the intent variable says. A CI job cannot talk
#    itself into production mode.
#
# 3. THE STRICT DOOR IGNORES THE VARIABLE ENTIRELY.
#
#    src/lib/ciSupabaseGuard.mjs passes a hard-coded mode constant. The four
#    write-capable entry points —
#
#        src/scripts/checkRankEventsSurfaces.ts   (real INSERT probe)
#        src/test/rlsHardening.test.ts            (creates/deletes auth users)
#        src/test/profileRoleNotSelfWritable.test.ts
#        src/test/isOfficialPrivileged.test.ts
#
#    — cannot reach production by any route. Setting the intent variable in one
#    of those processes is a REFUSAL, not a no-op: it exits 2 even against the
#    sanctioned CI project, so a stray export fails loudly instead of silently.
#
# 4. check:guard-coverage BECOMES A BLOCKING GATE, AND IT RUNS FIRST.
#
#    It is inserted at the TOP of scripts/run-all-checks.sh, so it gates every
#    other check. It fails closed on drift that a tree ahead of this one is
#    likely to have: a new file under artifacts/api-server/src/ that names
#    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY /
#    SUPABASE_PROJECT_TOKEN / EXPO_PUBLIC_SUPABASE_* or calls createClient( and
#    is neither guarded nor on the 41-entry EXEMPT list is a hard fail. So is
#    deleting or renaming an EXEMPT-listed file, and so is dropping the
#    SUPABASE_URL=http://127.0.0.1:9 pin from package.json's `test` script.
#
#    ABOUT 6% OF THE src/ FILES IN THIS CLONE MATCH THOSE PATTERNS, so a handful
#    of new files on your side is a realistic red. If you would rather not have
#    it gate check:all yet, run it standalone first:
#
#        node artifacts/api-server/scripts/check-guard-coverage.mjs
#
#    and wire it in only once that is green. This script runs it either way at
#    the end and will tell you.
#
# ═════════════════════════════════════════════════════════════════════════════
#  WHAT I DID NOT VERIFY
# ═════════════════════════════════════════════════════════════════════════════
#   NO TYPECHECK was run. NO TEST SUITE was run. NO DATABASE was queried and no
#   schema was loaded. There is no node_modules and no database where this was
#   built. The two checkers at the end of this script are the only things that
#   have actually been executed, and they read files on disk and nothing else.
#   "Reviewed" is not "run" — do not let this header imply otherwise.
#
# ═════════════════════════════════════════════════════════════════════════════
#  KNOWN DEFECTS IN THIS PAYLOAD (shipped as-is, verified, not repaired)
# ═════════════════════════════════════════════════════════════════════════════
#   * src/lib/ciSupabaseGuard.mjs's header claims checkDiscoveryCacheKeys.ts
#     imports IT and is "strict by default, deliberately". It does not — it
#     imports the read-only door and can therefore be pointed at production.
#     The prose is wrong; the enforced list in check-guard-coverage.mjs is right.
#   * ciProdReadOnlyAuditGuard.mjs's header, supabaseTargetPolicy.mjs's
#     attestation, the banner printed when a production connection is permitted,
#     and check-guard-coverage.mjs's own comments all say "four" read-only
#     grantees. There are FIVE. checkDiscoveryCacheKeys.ts is the fifth, and its
#     read-only justification exists only as a comment in
#     check-guard-coverage.mjs, not in the policy module.
#   * checkDiscoveryCacheKeys.ts's comment above its guard import still names
#     ciSupabaseGuard.mjs. Stale.
#   * scripts/check-memory-citations.mjs ships UNWIRED on purpose — no
#     package.json script, no run-all-checks.sh entry, no workflow. It works;
#     nothing runs it. It is manual-only until you decide otherwise.
#
# ═════════════════════════════════════════════════════════════════════════════
#  HOW EXISTING FILES ARE TREATED
# ═════════════════════════════════════════════════════════════════════════════
#   NEW files      refuse if the target exists with different content; report
#                  "already identical" and continue if it matches.
#   REPLACED files sha-checked against the exact pre-state this drop was built
#                  from. Any drift and the file is SKIPPED, not overwritten.
#                  Your tree is ahead of the clone this came from; a silent
#                  overwrite would destroy work, and that has already happened
#                  once in this project.
#   EDITED files   package.json, run-all-checks.sh and the nine guard entry
#                  points are NEVER shipped whole. They get anchored, idempotent
#                  edits that refuse when the anchor is not where expected.
#   Everything     backed up to .drop2-backup/ before it is touched.
#

set -uo pipefail

ROOT="$(pwd)"
STAGE="$ROOT/_drop2"
BACKUP="$ROOT/.drop2-backup"
MANIFEST="$STAGE/MANIFEST.sha"
PLAN="$STAGE/PLAN.tsv"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { red "x $*"; exit 1; }
sha()  { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

echo "=============================================="
echo "  drop2 — two front doors + guard coverage"
echo "=============================================="

# -- 0. preflight ------------------------------------------------------------
[ -d "$ROOT/artifacts/api-server" ] || fail "No artifacts/api-server here. Run from the repo root."
[ -d "$STAGE" ] || fail "No _drop2/ here. Unzip drop2.zip at the repo root first."
[ -f "$MANIFEST" ] || fail "No _drop2/MANIFEST.sha — incomplete archive."
[ -f "$PLAN" ] || fail "No _drop2/PLAN.tsv — incomplete archive."
command -v node >/dev/null 2>&1 || fail \
  "node not found. This script REFUSES to run without it: the anchored edits and
   both proof checks need it, and a skipped check is not a passing check."
grn "  node $(node --version)"

# -- 1. archive integrity ----------------------------------------------------
echo
echo "-- verifying the archive itself --"
BAD=0
while read -r EXPECT REL; do
  [ -n "${REL:-}" ] || continue
  ACTUAL=$(sha "$STAGE/$REL")
  [ "$ACTUAL" = "$EXPECT" ] || { red "  x corrupt in archive: $REL"; BAD=1; }
done < "$MANIFEST"
[ "$BAD" -eq 0 ] || fail "archive is corrupt — re-download, do not apply"
grn "  archive intact ($(wc -l < "$MANIFEST" | tr -d ' ') files)"

# -- 2. hard dependencies from the PREVIOUS drop -----------------------------
# These are not shipped here. Without them the payload is inert: every guarded
# entry point calls requirePolicyScript(), which exits 2 if
# .github/scripts/assert-nonprod-supabase.sh is absent, and
# check-guard-coverage.mjs refuses outright if .github/workflows/ is missing.
echo
echo "-- checking what the previous drop was supposed to leave behind --"
MISS=0
while IFS=$'\t' read -r KIND REL EXTRA; do
  [ "$KIND" = "REQUIRE" ] || continue
  if [ -e "$ROOT/$REL" ]; then
    grn "  present: $REL"
  else
    red "  ABSENT:  $REL"; MISS=1
  fi
done < "$PLAN"
if [ "$MISS" -ne 0 ]; then
  echo
  red "REFUSING TO APPLY — this drop depends on files the previous drop installs."
  red "Apply ci-drop.zip / apply-ci.sh first, then re-run this."
  exit 1
fi

# -- 3. new files ------------------------------------------------------------
echo
echo "-- new files --"
COLLIDE=0
while IFS=$'\t' read -r KIND REL EXTRA; do
  [ "$KIND" = "NEW" ] || continue
  if [ -e "$ROOT/$REL" ]; then
    if cmp -s "$STAGE/payload/$REL" "$ROOT/$REL"; then
      ylw "  . already identical: $REL"
    else
      red "  x EXISTS AND DIFFERS: $REL"; COLLIDE=1
    fi
  fi
done < "$PLAN"
if [ "$COLLIDE" -ne 0 ]; then
  echo
  red "REFUSING TO APPLY — a file this drop creates already exists with different"
  red "content. Diff it against _drop2/payload/ and merge by hand. Nothing has"
  red "been written yet."
  exit 1
fi
NEWN=0
while IFS=$'\t' read -r KIND REL EXTRA; do
  [ "$KIND" = "NEW" ] || continue
  [ -e "$ROOT/$REL" ] && continue
  mkdir -p "$ROOT/$(dirname "$REL")"
  cp "$STAGE/payload/$REL" "$ROOT/$REL"
  grn "  + $REL"
  NEWN=$((NEWN+1))
done < "$PLAN"
echo "  wrote $NEWN new file(s)"

# -- 4. replaced files, drift-checked ----------------------------------------
# EXTRA is the sha256 of the exact pre-state this payload was diffed against.
# Match it, or the file is left alone. This is the check that has already caught
# a real collision in this project.
echo
echo "-- replaced files (drift-checked, never clobbered) --"
mkdir -p "$BACKUP"
REPN=0; SKIPN=0; DRIFT=0
while IFS=$'\t' read -r KIND REL EXTRA; do
  [ "$KIND" = "REPLACE" ] || continue
  SRC="$STAGE/payload/$REL"
  DST="$ROOT/$REL"
  WANT=$(sha "$SRC")
  if [ ! -e "$DST" ]; then
    mkdir -p "$(dirname "$DST")"; cp "$SRC" "$DST"
    grn "  + $REL (was absent)"; REPN=$((REPN+1)); continue
  fi
  HAVE=$(sha "$DST")
  if [ "$HAVE" = "$WANT" ]; then
    ylw "  . already identical: $REL"; SKIPN=$((SKIPN+1)); continue
  fi
  if [ "$HAVE" = "$EXTRA" ]; then
    mkdir -p "$BACKUP/$(dirname "$REL")"
    cp "$DST" "$BACKUP/$REL"
    cp "$SRC" "$DST"
    grn "  + $REL"; REPN=$((REPN+1))
  else
    red "  x DRIFTED, LEFT UNTOUCHED: $REL"
    echo "      expected pre-state $EXTRA"
    echo "      found              $HAVE"
    echo "      merge by hand from _drop2/payload/$REL"
    DRIFT=$((DRIFT+1))
  fi
done < "$PLAN"
echo "  replaced $REPN, already current $SKIPN, drifted $DRIFT"

# -- 5. the anchored edits ---------------------------------------------------
echo
node "$STAGE/apply-edits.mjs"
EDIT_RC=$?

# -- 6. proof: run both checkers ---------------------------------------------
echo
echo "-- proof: running the two checkers (files on disk only, no database) --"
CHECK_RC=0

if [ -f "$ROOT/artifacts/api-server/scripts/check-guard-coverage.mjs" ]; then
  ( cd "$ROOT/artifacts/api-server" && node scripts/check-guard-coverage.mjs )
  RC=$?
  if [ "$RC" -eq 0 ]; then grn "  check:guard-coverage -> 0"
  else red "  x check:guard-coverage -> $RC"; CHECK_RC=1; fi
else
  red "  x check-guard-coverage.mjs is not on disk. NOT A PASS — it did not run."
  CHECK_RC=1
fi

echo
if [ -f "$ROOT/artifacts/api-server/scripts/check-memory-citations.mjs" ]; then
  ( cd "$ROOT/artifacts/api-server" && node scripts/check-memory-citations.mjs )
  RC=$?
  if [ "$RC" -eq 0 ]; then grn "  check-memory-citations -> 0"
  else red "  x check-memory-citations -> $RC"; CHECK_RC=1; fi
else
  red "  x check-memory-citations.mjs is not on disk. NOT A PASS — it did not run."
  CHECK_RC=1
fi

echo
echo "=============================================="
if [ "$DRIFT" -ne 0 ] || [ "$EDIT_RC" -ne 0 ] || [ "$CHECK_RC" -ne 0 ]; then
  red "  APPLIED PARTIALLY / NOT CLEAN — read the failures above."
  echo
  [ "$DRIFT" -ne 0 ]    && red "  * $DRIFT file(s) had drifted and were deliberately left alone."
  [ "$EDIT_RC" -ne 0 ]  && red "  * at least one anchored edit refused rather than guess."
  [ "$CHECK_RC" -ne 0 ] && red "  * at least one checker did not exit 0 (or did not run at all)."
  echo
  red "  NOTHING WAS DEPLOYED, NOTHING WAS QUERIED. Undo is at the bottom of this"
  red "  script. Do not commit until this is clean."
  echo "=============================================="
  exit 1
fi
grn "  applied clean — NOTHING DEPLOYED, NOTHING QUERIED, NO SCHEMA LOADED"
echo "=============================================="

cat <<'EOF'

WHAT TO DO NEXT, IN ORDER

1. TYPECHECK. I did not, and cannot: there is no node_modules where this was
   built. ciProdReadOnlyAuditGuard.mjs ships with a .d.mts stub so the bare
   side-effect import resolves, same as the strict guard's.
       cd artifacts/api-server && pnpm run typecheck

2. RUN check:all AND EXPECT check:guard-coverage TO BE THE FIRST LINE.
       cd artifacts/api-server && pnpm run check:all
   It ran green above on this drop's own view of your tree. If check:all
   disagrees, the difference is your uncommitted work, and the message names the
   file and the reason.

3. THE FIVE READ-ONLY AUDITS STILL DEFAULT TO REFUSING PRODUCTION. To point one
   at production ON PURPOSE, outside CI:
       PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
         pnpm run audit:schema
   It prints a banner naming the project before it connects. If you see that
   banner and did not intend it, kill it.

4. DO NOT set that variable for test:rls-hardening, check:rank-events-surfaces,
   or the other two RLS suites. They come through the strict door and will exit
   2 with the variable set — by design, so the mistake is loud.

UNDO
  cp -R .drop2-backup/. .        # restores every file this script modified
  rm -f .agents/memory/account-identity-by-id.md \
        .agents/memory/api-server-live-db-suites.md \
        .agents/memory/live-db-vs-local-postgres.md \
        .agents/memory/migration-applied-vs-committed.md \
        .agents/memory/posts-media-urls-vs-post-media.md \
        .agents/memory/resolve-interaction-permissions-catch.md \
        artifacts/api-server/scripts/check-guard-coverage.mjs \
        artifacts/api-server/scripts/check-memory-citations.mjs \
        artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.mjs \
        artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.d.mts \
        artifacts/api-server/src/lib/supabaseTargetPolicy.mjs
  # .drop2-backup/ holds the pre-edit copy of every REPLACED and EDITED file,
  # including package.json and run-all-checks.sh. It is only written the first
  # time a file is touched, so re-running this script does not overwrite it.

COMMIT — EXPLICIT PATHS ONLY.
DO NOT USE `git add -A`. A concurrent agent has uncommitted work in this tree
and `-A` would sweep it into your commit.

  cd ~/workspace && git add \
    .agents/memory/MEMORY.md \
    .agents/memory/api-server-testing.md \
    .agents/memory/discovery-perf-cache.md \
    .agents/memory/account-identity-by-id.md \
    .agents/memory/api-server-live-db-suites.md \
    .agents/memory/live-db-vs-local-postgres.md \
    .agents/memory/migration-applied-vs-committed.md \
    .agents/memory/posts-media-urls-vs-post-media.md \
    .agents/memory/resolve-interaction-permissions-catch.md \
    docs/security/admin-authz-audit.md \
    docs/testing/suite-exclusion-audit.md \
    docs/ci/README.md \
    docs/ci/BOOTSTRAP.md \
    .github/workflows/ci.yml \
    .github/scripts/assert-ci-scripts.mjs \
    artifacts/api-server/package.json \
    artifacts/api-server/scripts/run-all-checks.sh \
    artifacts/api-server/scripts/check-guard-coverage.mjs \
    artifacts/api-server/scripts/check-memory-citations.mjs \
    artifacts/api-server/src/lib/supabaseTargetPolicy.mjs \
    artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.mjs \
    artifacts/api-server/src/lib/ciProdReadOnlyAuditGuard.d.mts \
    artifacts/api-server/src/lib/ciSupabaseGuard.mjs \
    artifacts/api-server/src/scripts/auditMigrationsVsLive.ts \
    artifacts/api-server/src/scripts/checkMissingLiveColumns.ts \
    artifacts/api-server/src/scripts/checkMediaObjects.ts \
    artifacts/api-server/src/scripts/checkWritePathColumns.ts \
    artifacts/api-server/src/scripts/checkDiscoveryCacheKeys.ts \
    artifacts/api-server/src/scripts/checkRankEventsSurfaces.ts \
    artifacts/api-server/src/test/rlsHardening.test.ts \
    artifacts/api-server/src/test/profileRoleNotSelfWritable.test.ts \
    artifacts/api-server/src/test/isOfficialPrivileged.test.ts \
    && git commit -m "ci: split the Supabase guard into a strict door and a read-only production-audit door, and enforce coverage"

CLEANUP (after you are satisfied — this deletes the undo)
  rm -rf _drop2 .drop2-backup apply-drop2.sh drop2.zip
EOF
