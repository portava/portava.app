#!/usr/bin/env bash
# pre-release-check.sh — run all five CI validation steps before cutting an EAS build.
#
# Usage (from the workspace root):
#   bash scripts/pre-release-check.sh
#
# Environment variables:
#   SKIP_EAS_PREFLIGHT=1   Skip the eas/expo tool checks (useful in CI jobs that
#                          do not trigger an EAS build and don't have those CLIs
#                          installed).
#
# Exits 0 only when every check passes. Any failure prints a summary and exits 1.

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# ── Self-test mode ────────────────────────────────────────────────────────────
# Usage: bash scripts/pre-release-check.sh --self-test
#
# Runs each DB-check script against a known-bad fixture (empty DB response) and
# asserts the script exits 1.  If a verifier bug causes it to exit 0 on empty
# data, the self-test fails — preventing the broken verifier from silently
# passing the real pre-release gate.
#
# Covers:
#   engagement-indexes  (check-engagement-indexes.sh + verify-db-engagement-indexes.mjs)
#   db-triggers         (check-db-triggers.sh + verify-db-triggers.mjs)
#
# Exit 0 → every verifier correctly rejects bad data (verifiers are healthy).
# Exit 1 → at least one verifier exited 0 on bad data (verifier is broken).

if [[ "${1:-}" == "--self-test" ]]; then

  sep() { printf '%s\n' "$(printf '─%.0s' {1..60})"; }

  printf '\n'
  sep
  printf '  PRE-RELEASE SELF-TEST\n'
  printf '  Verifies each check script correctly exits 1 on bad data.\n'
  sep
  printf '\n'

  # ── Build a minimal temp workspace ─────────────────────────────────────────
  # Each check script reads SUPABASE_URL from artifacts/api-server/.env.
  # We supply a plausible URL so the project-ref extraction succeeds, then
  # intercept the outbound curl call with a fake binary that always returns
  # an empty result array ([]) + HTTP 200.  The verifier Node.js scripts
  # should detect the empty response and exit 1.

  SELF_TEST_TMP="$(mktemp -d)"
  # Clean up on exit (normal, error, or signal) so no temp dirs accumulate.
  trap 'rm -rf "$SELF_TEST_TMP"' EXIT

  mkdir -p "${SELF_TEST_TMP}/artifacts/api-server" "${SELF_TEST_TMP}/bin"

  printf 'SUPABASE_URL=https://testproject.supabase.co\n' \
    > "${SELF_TEST_TMP}/artifacts/api-server/.env"

  # Fake curl: always emit [] as the response body followed by 200 on the last
  # line — the exact format the check scripts parse with head/tail:
  #   HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)   → []
  #   HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)    → 200
  # Using printf so the two values land on separate lines without a trailing
  # newline (head -n -1 needs at least two lines to work correctly).
  cat > "${SELF_TEST_TMP}/bin/curl" << 'FAKE_CURL'
#!/usr/bin/env bash
printf '[]\n200'
FAKE_CURL
  chmod +x "${SELF_TEST_TMP}/bin/curl"

  # ── Self-test runner ────────────────────────────────────────────────────────
  # run_self_check <label> <env-var=value>... bash <script>
  #
  # Runs the script with the bad-fixture environment injected.
  # Records PASS if the script exits non-zero (correctly rejects bad data).
  # Records FAIL if the script exits 0 (verifier is broken — should never pass
  # an empty-result fixture).

  self_results=()
  self_overall=0   # 0 = all verifiers healthy; 1 = at least one broken

  run_self_check() {
    local name="$1"
    shift
    # Remaining args: optional extra VAR=value pairs, then bash <script>
    printf '▶  self-test: %s\n' "$name"
    local check_exit=0
    env \
      PATH="${SELF_TEST_TMP}/bin:${PATH}" \
      SUPABASE_ACCESS_TOKEN="self-test-fixture-token" \
      "$@" >/dev/null 2>&1 || check_exit=$?
    if [[ "$check_exit" -ne 0 ]]; then
      printf '  ✔  %s correctly exited %d on bad fixture\n\n' "$name" "$check_exit"
      self_results+=("PASS|${name}")
    else
      printf '  ✘  %s exited 0 on bad fixture — verifier is BROKEN\n\n' "$name"
      self_results+=("FAIL|${name}")
      self_overall=1
    fi
  }

  # ── engagement-indexes self-test ────────────────────────────────────────────
  # check-engagement-indexes.sh uses CHECK_ENGAGEMENT_WORKSPACE_ROOT to find
  # the .env; fake curl returns [] so verify-db-engagement-indexes.mjs should
  # detect all five indexes as missing and exit 1.
  run_self_check "engagement-indexes" \
    CHECK_ENGAGEMENT_WORKSPACE_ROOT="${SELF_TEST_TMP}" \
    bash scripts/check-engagement-indexes.sh

  # ── db-triggers self-test ───────────────────────────────────────────────────
  # check-db-triggers.sh uses CHECK_TRIGGERS_WORKSPACE_ROOT to find the .env;
  # fake curl returns [] so verify-db-triggers.mjs should detect all triggers
  # as missing and exit 1 (set -e in the check script propagates the exit).
  run_self_check "db-triggers" \
    CHECK_TRIGGERS_WORKSPACE_ROOT="${SELF_TEST_TMP}" \
    bash scripts/check-db-triggers.sh

  # run_self_skip_check <label> <env-var=value>... bash <script>
  #
  # Mirror of run_self_check for soft-skip paths: records PASS if the script
  # exits 0 (the skip stays a skip), FAIL if it exits non-zero (a soft-skip
  # path started hard-failing, which would block developers on unrelated work).
  run_self_skip_check() {
    local name="$1"
    shift
    printf '▶  self-test: %s\n' "$name"
    local check_exit=0
    env \
      PATH="${SELF_TEST_TMP}/bin:${PATH}" \
      SUPABASE_ACCESS_TOKEN="self-test-fixture-token" \
      "$@" >/dev/null 2>&1 || check_exit=$?
    if [[ "$check_exit" -eq 0 ]]; then
      printf '  ✔  %s correctly exited 0 (soft skip preserved)\n\n' "$name"
      self_results+=("PASS|${name}")
    else
      printf '  ✘  %s exited %d — soft-skip path is hard-failing\n\n' "$name" "$check_exit"
      self_results+=("FAILSKIP|${name}")
      self_overall=1
    fi
  }

  # ── beta-flags verifier self-test ───────────────────────────────────────────
  # Exercises verify-db-beta-flags.mjs directly with an empty fixture so that
  # any future regression that makes the verifier fail-open on missing rows is
  # caught before it reaches the real pre-release gate.
  # We invoke node directly (not via check-db-triggers.sh) so this test
  # specifically targets the 0117 verifier, independent of the trigger check.
  run_self_check "beta-flags-verifier" \
    BETA_FLAGS_RESPONSE='[]' \
    node scripts/src/verify-db-beta-flags.mjs

  # ── schema-audit self-test ──────────────────────────────────────────────────
  # check-schema-audit.sh runs `pnpm run audit:schema` inside
  # <workspace>/artifacts/api-server.  We build a temp workspace whose
  # api-server package runs the REAL auditMigrationsVsLive.ts (copied so its
  # __dirname-relative migration dirs resolve inside the fixture) against:
  #   • src/migrations/0001_self_test_drift.sql — claims a table that can
  #     never exist live, and
  #   • a fetch mock (--import, controlled by SELF_TEST_AUDIT_HTTP_STATUS)
  #     that fakes the Management API: 200 → empty schema ([]), else an
  #     HTTP error.
  # Bad-data case: empty live schema → audit must exit 1 → check exits 1.
  # Soft-skip cases: no token → exit 0; API 401 → audit exits 2 → check exit 0.
  SCHEMA_AUDIT_TMP="${SELF_TEST_TMP}/schema-audit/artifacts/api-server"
  mkdir -p "${SCHEMA_AUDIT_TMP}/src/scripts" "${SCHEMA_AUDIT_TMP}/src/migrations"

  printf 'SUPABASE_URL=https://testproject.supabase.co\n' \
    > "${SCHEMA_AUDIT_TMP}/.env"

  cp artifacts/api-server/src/scripts/auditMigrationsVsLive.ts \
    "${SCHEMA_AUDIT_TMP}/src/scripts/auditMigrationsVsLive.ts"

  # Reuse the real node_modules so tsx resolves inside the fixture.
  ln -s "${WORKSPACE_ROOT}/artifacts/api-server/node_modules" \
    "${SCHEMA_AUDIT_TMP}/node_modules"

  cat > "${SCHEMA_AUDIT_TMP}/src/migrations/0001_self_test_drift.sql" << 'BAD_MIGRATION'
-- Self-test fixture: claims an object the (mocked, empty) live schema
-- cannot contain.  The audit must flag it and exit 1.
CREATE TABLE self_test_nonexistent_table (
  id uuid PRIMARY KEY
);
BAD_MIGRATION

  cat > "${SCHEMA_AUDIT_TMP}/fetch-mock.mjs" << 'FETCH_MOCK'
// Fake Supabase Management API: 200 → empty result set; any other
// SELF_TEST_AUDIT_HTTP_STATUS → HTTP error (audit treats it as exit 2).
const status = Number(process.env.SELF_TEST_AUDIT_HTTP_STATUS ?? "200");
globalThis.fetch = async () =>
  new Response(status === 200 ? "[]" : '{"message":"self-test unauthorized"}', {
    status,
    headers: { "content-type": "application/json" },
  });
FETCH_MOCK

  cat > "${SCHEMA_AUDIT_TMP}/package.json" << 'PKG_JSON'
{
  "name": "self-test-api-server",
  "private": true,
  "type": "module",
  "scripts": {
    "audit:schema": "node --env-file-if-exists=.env --import ./fetch-mock.mjs --import tsx/esm src/scripts/auditMigrationsVsLive.ts"
  }
}
PKG_JSON

  # Bad data: empty live schema must fail the audit (exit 1).
  run_self_check "schema-audit" \
    CHECK_SCHEMA_AUDIT_WORKSPACE_ROOT="${SELF_TEST_TMP}/schema-audit" \
    bash scripts/check-schema-audit.sh

  # Soft skip: no SUPABASE_ACCESS_TOKEN → the check must exit 0 (skip).
  run_self_skip_check "schema-audit-skip-no-token" \
    CHECK_SCHEMA_AUDIT_WORKSPACE_ROOT="${SELF_TEST_TMP}/schema-audit" \
    SUPABASE_ACCESS_TOKEN="" \
    bash scripts/check-schema-audit.sh

  # Soft skip: Management API 401 → audit exits 2 → the check must exit 0.
  run_self_skip_check "schema-audit-skip-api-401" \
    CHECK_SCHEMA_AUDIT_WORKSPACE_ROOT="${SELF_TEST_TMP}/schema-audit" \
    SELF_TEST_AUDIT_HTTP_STATUS="401" \
    bash scripts/check-schema-audit.sh

  # ── Summary ─────────────────────────────────────────────────────────────────
  printf '\n'
  sep
  printf '  SELF-TEST SUMMARY\n'
  sep
  for entry in "${self_results[@]}"; do
    status="${entry%%|*}"
    name="${entry#*|}"
    if [[ "$status" == "PASS" ]]; then
      printf '  ✔  %-35s behaves correctly on fixture\n' "$name"
    elif [[ "$status" == "FAILSKIP" ]]; then
      printf '  ✘  %-35s hard-fails on a soft-skip path — BROKEN CHECK\n' "$name"
    else
      printf '  ✘  %-35s exits 0 on bad data — BROKEN VERIFIER\n' "$name"
    fi
  done
  sep
  printf '\n'

  if [[ "$self_overall" -eq 0 ]]; then
    printf 'Self-test PASSED — all verifier scripts correctly detect failures.\n'
    printf 'The pre-release gate will not silently pass when a migration is missing.\n\n'
    exit 0
  else
    printf 'Self-test FAILED — one or more verifier scripts returned exit 0 on bad data.\n'
    printf 'A broken verifier could let the real pre-release gate pass silently.\n'
    printf 'Fix the broken verifier and re-run:\n'
    printf '  bash scripts/pre-release-check.sh --self-test\n\n'
    exit 1
  fi
fi

# ── Required-tool preflight ──────────────────────────────────────────────────
# Shell-level prerequisites for this script and the sync helpers it calls.
# tsc is resolved through pnpm package scripts (node_modules/.bin) and does
# not need to be on PATH.  eas and expo are only required when you intend to
# trigger an EAS build — they are checked here so a missing CLI fails fast
# rather than partway through a build.
#
# Tool      Why needed
# -------   -----------------------------------------------------------------
# bash      explicit sub-shell calls in run_check (bash -c / bash scripts/…)
# (git was required only by sync-standalone.sh's source-drift diff; that script
#  retired with artifacts/travel-buddy, and no remaining check shells out to git,
#  so it is no longer preflighted here.)
# node      pnpm runs on Node; also used directly by build scripts
# pnpm      all package installs and workspace script execution
# eas       EAS build / submit commands (eas-cli, must be installed globally)
# expo      Expo CLI — expo export and doctor steps in CI
#
# Set SKIP_EAS_PREFLIGHT=1 to omit eas/expo from the check list.

declare -A tool_fix=(
  [bash]="install Bash 4+ (macOS: brew install bash; Linux: apt-get install bash)"
  [node]="use Node Version Manager (nvm) or actions/setup-node in CI"
  [pnpm]="corepack enable && corepack prepare pnpm@latest --activate"
  [eas]="npm install -g eas-cli  (or pnpm add -g eas-cli)"
  [expo]="npm install -g expo-cli  (or pnpm add -g expo-cli)"
)

tools_to_check=(bash node pnpm)

if [[ "${SKIP_EAS_PREFLIGHT:-0}" == "1" ]]; then
  printf '\n⚠️   SKIP_EAS_PREFLIGHT=1 — skipping eas/expo tool checks.\n'
  printf '    EAS build / expo export steps will not be available in this run.\n\n'
else
  tools_to_check+=(eas expo)
fi

missing_tools=()
for tool in "${tools_to_check[@]}"; do
  if ! command -v "$tool" &>/dev/null; then
    missing_tools+=("$tool")
  fi
done
if [[ ${#missing_tools[@]} -gt 0 ]]; then
  printf '\n❌  pre-release-check: required tool(s) not found on PATH:\n'
  for t in "${missing_tools[@]}"; do
    printf '      • %-8s  fix: %s\n' "$t" "${tool_fix[$t]}"
  done
  printf '\nInstall the missing tool(s) and re-run.\n'
  printf 'See docs/eas-runbook.md → "Required tools" for full install instructions.\n\n'
  exit 1
fi

PASS=0
FAIL=1

results=()        # "PASS|<name>" or "FAIL|<name>|<detail>"
overall=$PASS

sep() { printf '%s\n' "$(printf '─%.0s' {1..60})"; }

run_check() {
  local name="$1"
  local label="$2"
  shift 2
  printf '\n'
  sep
  printf '▶  %s\n' "$label"
  sep
  if "$@"; then
    results+=("PASS|${name}")
    printf '✔  %s passed\n' "$name"
  else
    results+=("FAIL|${name}|exit code $?")
    overall=$FAIL
    printf '✘  %s FAILED\n' "$name"
  fi
}

# ── 1. Monorepo typecheck ────────────────────────────────────────────────────
run_check "typecheck" \
  "TypeScript — monorepo (all workspace packages)" \
  pnpm run typecheck

# ── 2. Standalone typecheck ──────────────────────────────────────────────────
run_check "typecheck-standalone" \
  "TypeScript — travel-buddy-standalone" \
  bash -c 'cd travel-buddy-standalone && pnpm typecheck'

# ── 3. API server build ───────────────────────────────────────────────────────
run_check "api-server-build" \
  "API server esbuild bundle (artifacts/api-server)" \
  pnpm --filter @workspace/api-server run build

# The dependency-drift, source-drift and lockfile-drift checks that used to sit
# here were the three read-only modes of scripts/sync-standalone.sh. All three
# compared travel-buddy-standalone against artifacts/travel-buddy, which is
# archived — there is no second tree left to drift from, and the script is gone.
# Nothing replaces them: a one-tree repo cannot fall out of sync with itself.

# ── 4. Placeholder bundle ID guard ───────────────────────────────────────────
# Fails if travel-buddy-standalone/app.json still contains the placeholder
# bundle identifier com.travelbuddy.app. A release build submitted with this
# value will be rejected by Apple (and Google) review.
run_check "bundle-id-placeholder" \
  "Placeholder bundle ID guard (app.json must not use com.travelbuddy.app)" \
  bash -c '
    BUNDLE_ID=$(node -e "
      const fs = require(\"fs\");
      const app = JSON.parse(fs.readFileSync(\"travel-buddy-standalone/app.json\", \"utf8\"));
      process.stdout.write(app.expo.ios.bundleIdentifier);
    ")
    ANDROID_PKG=$(node -e "
      const fs = require(\"fs\");
      const app = JSON.parse(fs.readFileSync(\"travel-buddy-standalone/app.json\", \"utf8\"));
      process.stdout.write(app.expo.android.package);
    ")
    PLACEHOLDER="com.travelbuddy.app"
    ok=0
    if [ "$BUNDLE_ID" = "$PLACEHOLDER" ]; then
      printf "  ✘  ios.bundleIdentifier is still the placeholder: %s\n" "$BUNDLE_ID"
      printf "     Replace it with your registered Apple App Store bundle ID before submitting.\n"
      ok=1
    fi
    if [ "$ANDROID_PKG" = "$PLACEHOLDER" ]; then
      printf "  ✘  android.package is still the placeholder: %s\n" "$ANDROID_PKG"
      printf "     Replace it with your registered Google Play package name before submitting.\n"
      ok=1
    fi
    if [ $ok -eq 0 ]; then
      printf "  ✔  Bundle ID / package: %s\n" "$BUNDLE_ID"
    fi
    exit $ok
  '

# ── 5. DB protection triggers + schema presence ──────────────────────────────
# Confirms the BEFORE DELETE / BEFORE TRUNCATE triggers that protect the
# collections and collection_items tables (migrations 0071–0074) are present in
# the Supabase production database, and that the profile_emergency_contacts
# table (migration 0076), safe_return_sessions (migration 0040), and
# notification_devices (migration 0041, push token storage) exist with RLS
# enabled and their expected policies.
#
# Requires:
#   SUPABASE_ACCESS_TOKEN  — Supabase personal access token (Management API)
#                            https://supabase.com/dashboard/account/tokens
#
# The project ref is extracted automatically from SUPABASE_URL in
# artifacts/api-server/.env so no extra config is needed.
#
# If SUPABASE_ACCESS_TOKEN is not set the check exits non-zero so that a
# release never ships without confirming the guards are live.
run_check "db-triggers" \
  "DB protection triggers + schema presence (migrations 0040, 0041, 0071–0074, 0076, 0090, 0109–0111, 0117)" \
  bash scripts/check-db-triggers.sh

# ── 6. Engagement index presence check ───────────────────────────────────────
# Confirms the five engagement indexes added by migration 0106 are present in
# pg_indexes.  Missing indexes cause the GET /api/engagement/likes endpoint to
# degrade to sequential scans on posts_likes, post_reactions, comment_likes,
# highlight_likes, and memory_likes tables under cursor-based pagination.
#
# Skipped gracefully (warning only, not failure) when neither
# SUPABASE_PROJECT_TOKEN nor SUPABASE_ACCESS_TOKEN is set, so developers
# without Supabase credentials configured locally are not blocked.
run_check "engagement-indexes" \
  "Engagement index presence (migration 0106 — five pg_indexes)" \
  bash scripts/check-engagement-indexes.sh

# ── 7. Migrations-vs-live schema audit ──────────────────────────────────────
# Diffs every migration file's claimed objects (tables, columns, functions,
# indexes, policies, enums, triggers, views) against the LIVE Supabase schema
# via the Management API, catching never-applied migrations before a release.
#
# Soft-skips (warning only, exit 0) when no token (SUPABASE_PROJECT_TOKEN or
# SUPABASE_ACCESS_TOKEN) / SUPABASE_URL
# are unavailable or the Management API is unreachable, so a network blip or
# a developer without credentials is not blocked on unrelated work.
# Fails hard only on real drift (audit exit 1).
run_check "schema-audit" \
  "Migrations-vs-live schema audit (auditMigrationsVsLive.ts)" \
  bash scripts/check-schema-audit.sh

# ── 8. Version / build-number floor guard ────────────────────────────────────
# Fails if ios.buildNumber or android.versionCode still equal 1, which is the
# first-submission default that Apple and Google have already seen.  Both
# stores reject a binary whose build number is not strictly greater than the
# last accepted submission.
#
# Override the floor with VERSION_BUMP_FLOOR (default: 1) if your project's
# baseline is higher.
run_check "version-bump" \
  "Version / build-number floor guard (buildNumber and versionCode must be > ${VERSION_BUMP_FLOOR:-1})" \
  bash -c '
    FLOOR="${VERSION_BUMP_FLOOR:-1}"
    BUILD_NUMBER=$(node -e "
      const fs = require(\"fs\");
      const app = JSON.parse(fs.readFileSync(\"travel-buddy-standalone/app.json\", \"utf8\"));
      process.stdout.write(String(app.expo.ios.buildNumber));
    ")
    VERSION_CODE=$(node -e "
      const fs = require(\"fs\");
      const app = JSON.parse(fs.readFileSync(\"travel-buddy-standalone/app.json\", \"utf8\"));
      process.stdout.write(String(app.expo.android.versionCode));
    ")
    ok=0
    if [ "$BUILD_NUMBER" = "$FLOOR" ]; then
      printf "  ✘  ios.buildNumber is still the baseline floor: %s\n" "$BUILD_NUMBER"
      printf "     Increment ios.buildNumber in travel-buddy-standalone/app.json before building.\n"
      printf "     Apple rejects a binary whose build number has already been submitted.\n"
      ok=1
    fi
    if [ "$VERSION_CODE" = "$FLOOR" ]; then
      printf "  ✘  android.versionCode is still the baseline floor: %s\n" "$VERSION_CODE"
      printf "     Increment android.versionCode in travel-buddy-standalone/app.json before building.\n"
      printf "     Google Play rejects a binary whose version code has already been submitted.\n"
      ok=1
    fi
    if [ $ok -eq 0 ]; then
      printf "  ✔  ios.buildNumber=%s  android.versionCode=%s  (both above floor %s)\n" \
        "$BUILD_NUMBER" "$VERSION_CODE" "$FLOOR"
    fi
    exit $ok
  '

# ── 9. Migration prefix-collision guard ─────────────────────────────────────
# Fails when two files in artifacts/api-server/src/migrations share the same
# numeric prefix — migration runners apply files in lexicographic order, so a
# shared prefix produces an ambiguous apply sequence. Needs no DB credentials.
# KNOWN PRE-EXISTING COLLISION: the 2059 pair
# (2059_content_distribution_stats.sql / 2059_stamp_artwork_generation_
# source_placeholder.sql) predates this guard and its production apply state
# is unknown — do NOT blindly renumber it; resolve its apply state first.
run_check "migration-prefixes" \
  "Migration prefix uniqueness (artifacts/api-server/src/migrations)" \
  pnpm --dir artifacts/api-server run check:migration-prefixes

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n'
sep
printf '  PRE-RELEASE CHECK SUMMARY\n'
sep
for entry in "${results[@]}"; do
  status="${entry%%|*}"
  rest="${entry#*|}"
  name="${rest%%|*}"
  if [[ "$status" == "PASS" ]]; then
    printf '  ✔  %-30s PASS\n' "$name"
  else
    detail="${rest#*|}"
    printf '  ✘  %-30s FAIL  (%s)\n' "$name" "$detail"
    case "$name" in
      typecheck)
        printf '     fix: pnpm run typecheck\n'
        ;;
      typecheck-standalone)
        printf '     fix: cd travel-buddy-standalone && pnpm typecheck\n'
        ;;
      api-server-build)
        printf '     fix: pnpm --filter @workspace/api-server run build\n'
        ;;
      bundle-id-placeholder)
        printf '     fix: update ios.bundleIdentifier and android.package in travel-buddy-standalone/app.json\n'
        ;;
      version-bump)
        printf '     fix: increment ios.buildNumber and android.versionCode in travel-buddy-standalone/app.json\n'
        ;;
      migration-prefixes)
        printf '     fix: two or more files in artifacts/api-server/src/migrations share a numeric\n'
        printf '          prefix (see the checker output above). Migration runners apply files in\n'
        printf '          lexicographic order — a shared prefix makes the apply sequence ambiguous.\n'
        printf '          Renumber the NEWEST, NOT-YET-APPLIED colliding file(s) to unique prefixes.\n'
        printf '          If a colliding file was already applied to production, rename it anyway and\n'
        printf '          add an "ALREADY APPLIED under the old name — do not re-apply" header note\n'
        printf '          (see 2075_stamp_progress_atomic.sql / 2076_user_stamps_unique.sql).\n'
        printf '          KNOWN ISSUE: the pre-existing 2059 pair (2059_content_distribution_stats.sql /\n'
        printf '          2059_stamp_artwork_generation_source_placeholder.sql) has an UNKNOWN production\n'
        printf '          apply state — do NOT blindly renumber it; resolve its apply state first.\n'
        ;;
      engagement-indexes)
        printf '     fix: apply the engagement index migration via the Supabase SQL editor or psql:\n'
        printf '            artifacts/api-server/src/migrations/0106_engagement_indexes.sql\n'
        printf '          (0106 creates five pg_indexes for cursor-based pagination on like tables;\n'
        printf '           without them GET /api/engagement/likes degrades to sequential scans)\n'
        printf '          To enable the check locally:\n'
        printf '            export SUPABASE_ACCESS_TOKEN=sbp_...\n'
        printf '            Generate at: https://supabase.com/dashboard/account/tokens\n'
        ;;
      schema-audit)
        printf '     fix: review the missing objects printed above, apply the never-applied\n'
        printf '          migrations via the Supabase Management API, then re-run:\n'
        printf '            cd artifacts/api-server && pnpm run audit:schema\n'
        printf '          Known-drifted files/columns belong in the SKIP_FILES / ALLOWLIST\n'
        printf '          sets in artifacts/api-server/src/scripts/auditMigrationsVsLive.ts\n'
        printf '          (document the drift in docs/migrations.md).\n'
        printf '          Token required to query the Supabase Management API:\n'
        printf '            CI (preferred):  export SUPABASE_PROJECT_TOKEN=<project-scoped token>\n'
        printf '            Local dev:       export SUPABASE_ACCESS_TOKEN=sbp_...\n'
        printf '                             Generate at: https://supabase.com/dashboard/account/tokens\n'
        ;;
      db-triggers)
        printf '     fix: apply missing migrations via Supabase dashboard or psql:\n'
        printf '            artifacts/api-server/migrations/0040_safe_return.sql\n'
        printf '          (0040 creates safe_return_sessions + RLS policy srs_own)\n'
        printf '            artifacts/api-server/migrations/0041_notifications.sql\n'
        printf '          (0041 creates notification_devices for push token storage + RLS policy nd_own)\n'
        printf '            artifacts/api-server/src/migrations/0071_protect_default_collection.sql\n'
        printf '            artifacts/api-server/src/migrations/0072_block_collections_truncate.sql\n'
        printf '            artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql\n'
        printf '            artifacts/api-server/src/migrations/0074_protect_saved_places.sql\n'
        printf '            artifacts/api-server/migrations/0076_profile_emergency_contacts.sql\n'
        printf '          (0076 creates the profile_emergency_contacts table + RLS policies)\n'
        printf '            artifacts/api-server/src/migrations/0090_rent_buddy_rollout_tables.sql\n'
        printf '          (0090 creates rent_buddy_global_controls + rent_buddy_city_rollouts tables;\n'
        printf '           without them every checkRentBuddyAccess call returns city_not_available)\n'
        printf '            artifacts/api-server/src/migrations/0092_seed_rent_buddy_launch_cities.sql\n'
        printf '          (0092 seeds Cebu, Manila, Davao City at public_mvp status;\n'
        printf '           without live cities the feature is deployed but invisible to all users)\n'
        printf '            artifacts/api-server/src/migrations/0109_claim_invite_link_slot.sql\n'
        printf '          (0109 creates claim_invite_link_slot + release_invite_link_slot;\n'
        printf '           without these the invite-link accept endpoint returns a DB error on every join)\n'
        printf '            artifacts/api-server/src/migrations/0110_invite_link_idempotency.sql\n'
        printf '          (0110 creates trip_invite_link_attempts table + claim_invite_link_slot_for_user;\n'
        printf '           without these the idempotent retry path is unavailable and users can be locked out)\n'
        printf '            artifacts/api-server/src/migrations/0111_reconcile_invite_slots.sql\n'
        printf '          (0111 creates reconcile_invite_link_slots;\n'
        printf '           without this POST /api/admin/trips/reconcile-invite-slots returns 500)\n'
        printf '            artifacts/api-server/src/migrations/0117_beta_feature_flags.sql\n'
        printf '          (0117 seeds kill-switch rows: disable_posting, disable_messaging,\n'
        printf '           disable_signups, invite_only_beta,\n'
        printf '           disable_rent_buddy_booking, compass_ai_enabled;\n'
        printf '           without these rows the kill switches always fail-open)\n'
        printf '          Verify 0117 with:\n'
        printf '            SELECT flag, enabled FROM feature_flags\n'
        printf '              WHERE flag IN ('"'"'disable_posting'"'"','"'"'disable_messaging'"'"',\n'
        printf '                             '"'"'disable_signups'"'"','"'"'invite_only_beta'"'"',\n'
        printf '                             '"'"'compass_ai_enabled'"'"',\n'
        printf '                             '"'"'disable_rent_buddy_booking'"'"');\n'
        printf '          Token required to query the Supabase Management API:\n'
        printf '            CI (preferred):  export SUPABASE_PROJECT_TOKEN=<project-scoped token>\n'
        printf '                             See docs/eas-runbook.md → "DB triggers check in CI"\n'
        printf '            Local dev:       export SUPABASE_ACCESS_TOKEN=sbp_...\n'
        printf '                             Generate at: https://supabase.com/dashboard/account/tokens\n'
        ;;
    esac
  fi
done
sep

if [[ "$overall" -eq $PASS ]]; then
  printf '\nAll checks passed — safe to trigger an EAS build.\n\n'
  exit 0
else
  printf '\nOne or more checks failed. Fix the issues above before building a release.\n'
  printf 'See replit.md → "Release checklist" for remediation steps.\n\n'
  exit 1
fi
