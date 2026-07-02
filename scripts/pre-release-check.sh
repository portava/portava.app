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
# git       sync-standalone.sh uses git diff for source-drift checks
# node      pnpm runs on Node; also used directly by build scripts
# pnpm      all package installs and workspace script execution
# eas       EAS build / submit commands (eas-cli, must be installed globally)
# expo      Expo CLI — expo export and doctor steps in CI
#
# Set SKIP_EAS_PREFLIGHT=1 to omit eas/expo from the check list.

declare -A tool_fix=(
  [bash]="install Bash 4+ (macOS: brew install bash; Linux: apt-get install bash)"
  [git]="install Git (https://git-scm.com/downloads or your OS package manager)"
  [node]="use Node Version Manager (nvm) or actions/setup-node in CI"
  [pnpm]="corepack enable && corepack prepare pnpm@latest --activate"
  [eas]="npm install -g eas-cli  (or pnpm add -g eas-cli)"
  [expo]="npm install -g expo-cli  (or pnpm add -g expo-cli)"
)

tools_to_check=(bash git node pnpm)

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

# ── 3. Dependency drift ──────────────────────────────────────────────────────
run_check "dependency-drift" \
  "Dependency drift (artifacts/travel-buddy vs standalone)" \
  bash scripts/sync-standalone.sh --check-deps

# ── 4. Source drift ──────────────────────────────────────────────────────────
run_check "source-drift" \
  "Source drift (synced directories)" \
  bash scripts/sync-standalone.sh --check-source

# ── 5. API server build ───────────────────────────────────────────────────────
run_check "api-server-build" \
  "API server esbuild bundle (artifacts/api-server)" \
  pnpm --filter @workspace/api-server run build

# ── 6. Lockfile drift ────────────────────────────────────────────────────────
run_check "lockfile-drift" \
  "Lockfile drift (resolved versions: monorepo vs standalone)" \
  bash scripts/sync-standalone.sh --check-lockfile

# ── 7. Placeholder bundle ID guard ───────────────────────────────────────────
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

# ── 8. DB protection triggers + schema presence ──────────────────────────────
# Confirms the BEFORE DELETE / BEFORE TRUNCATE triggers that protect the
# collections and collection_items tables (migrations 0071–0074) are present in
# the Supabase production database, and that the profile_emergency_contacts
# table (migration 0076) exists with RLS enabled and the expected policies.
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
  "DB protection triggers + schema presence (migrations 0071–0074, 0076)" \
  bash scripts/check-db-triggers.sh

# ── 9. Version / build-number floor guard ────────────────────────────────────
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
      dependency-drift)
        printf '     fix: bash scripts/sync-standalone.sh --apply-deps && pnpm install\n'
        ;;
      source-drift)
        printf '     fix: bash scripts/sync-standalone.sh --fix-source\n'
        ;;
      api-server-build)
        printf '     fix: pnpm --filter @workspace/api-server run build\n'
        ;;
      lockfile-drift)
        printf '     fix: bash scripts/sync-standalone.sh --fix-lockfile\n'
        ;;
      bundle-id-placeholder)
        printf '     fix: update ios.bundleIdentifier and android.package in travel-buddy-standalone/app.json\n'
        ;;
      version-bump)
        printf '     fix: increment ios.buildNumber and android.versionCode in travel-buddy-standalone/app.json\n'
        ;;
      db-triggers)
        printf '     fix: apply missing migrations via Supabase dashboard or psql:\n'
        printf '            artifacts/api-server/src/migrations/0071_protect_default_collection.sql\n'
        printf '            artifacts/api-server/src/migrations/0072_block_collections_truncate.sql\n'
        printf '            artifacts/api-server/src/migrations/0073_block_collection_items_truncate.sql\n'
        printf '            artifacts/api-server/src/migrations/0074_protect_saved_places.sql\n'
        printf '            artifacts/api-server/migrations/0076_profile_emergency_contacts.sql\n'
        printf '          (0076 creates the profile_emergency_contacts table + RLS policies)\n'
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
