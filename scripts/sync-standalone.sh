#!/usr/bin/env bash
# sync-standalone.sh — copy source changes from the monorepo Expo app to the standalone EAS build target.
#
# Usage (from the workspace root):
#   bash scripts/sync-standalone.sh [--dry-run] [--apply-deps] [--check-source] [--fix-source]
#
# Flags:
#   --dry-run       Show what would change without writing any files.
#   --apply-deps    Auto-patch travel-buddy-standalone/package.json with dependency
#                   changes from the monorepo app (added packages + version updates).
#                   Standalone-only packages are never removed. Prints a summary then
#                   reminds you to run `pnpm install` inside the standalone.
#                   --dry-run takes precedence: if both flags are set, nothing is written.
#   --check-source  Diff source directories between the main app and standalone.
#                   Exits non-zero when the number of differing files exceeds
#                   SOURCE_DRIFT_THRESHOLD (default: 0, i.e. any drift fails).
#                   Directories checked are controlled by SOURCE_DRIFT_DIRS (see below).
#                   This flag is read-only — no files are written. It runs independently
#                   of --dry-run and --apply-deps; when used alone only the source diff
#                   is executed.
#   --check-deps    Compare package.json dependencies between artifacts/travel-buddy
#                   and travel-buddy-standalone. Exits non-zero when any dependency
#                   is added or has a version mismatch. Standalone-only packages are
#                   reported but never cause a failure (they may be intentional).
#                   This flag is read-only — no files are written. Runs independently
#                   of --dry-run, --apply-deps, and --check-source.
#   --check-lockfile
#                   Compare resolved versions in pnpm-lock.yaml files between the
#                   monorepo app (root pnpm-lock.yaml, importer "artifacts/travel-buddy")
#                   and the standalone (travel-buddy-standalone/pnpm-lock.yaml,
#                   importer "."). Exits non-zero when any shared direct dependency
#                   resolves to a different version string — this is the root cause of
#                   transitive-dep build failures on EAS. Standalone-only packages are
#                   informational and never cause a failure. This flag is read-only.
#                   Runs independently of all other flags.
#   --fix-lockfile  Automatically eliminate lockfile drift in three steps:
#                     1. --apply-deps: sync package.json specifiers
#                     2. pnpm install inside travel-buddy-standalone (re-resolve lockfile)
#                     3. --check-lockfile: verify drift is resolved
#                   Exits 0 only when all drift is cleared. If drift remains after
#                   reinstall (same semver range resolves different versions), prints
#                   guidance for manual alignment with pnpm update. This flag is not
#                   compatible with --dry-run; it always writes files and runs installs.
#   --fix-source    Re-sync only the source directories reported by --check-source
#                   (controlled by SOURCE_DRIFT_DIRS). Package.json, tsconfig.json,
#                   babel.config.js, metro.config.js, and other preserved files are
#                   never touched. Combine with --dry-run to preview changes before
#                   applying them.
#
# Environment variables:
#   SOURCE_DRIFT_THRESHOLD  Maximum number of differing source files before --check-source
#                           fails. Default: 0 (any drift fails). Set to a positive integer
#                           to allow a grace margin during a large-batch sync.
#   SOURCE_DRIFT_DIRS       Space-separated list of directories to compare when
#                           --check-source is used. Defaults to all directories that
#                           this script syncs: "src app assets components constants hooks
#                           docs migrations scripts server".
#                           Override to restrict or expand the checked set, e.g.:
#                             SOURCE_DRIFT_DIRS="src app" bash scripts/sync-standalone.sh --check-source
#
# What it syncs:
#   Directories: app/ src/ assets/ components/ constants/ hooks/ docs/ migrations/ scripts/ server/
#   Config files: app.json  eas.json  expo-env.d.ts
#   (babel.config.js and metro.config.js are NOT overwritten — structural drift checks run instead)
#
# Perspective guard:
#   Files whose content contains tree-specific relative paths (monorepo-
#   perspective '../../../../travel-buddy-standalone/...' / '../../../../pnpm-lock.yaml'
#   or standalone-perspective '../../../artifacts/travel-buddy/...' /
#   '../../pnpm-lock.yaml') are REFUSED instead of copied — a blind copy would
#   land paths that resolve outside the workspace in the destination tree.
#   Mirrors findPerspectiveViolations in scripts/src/cross-tree-paths.test.ts.
#   Port such changes manually using the destination tree's perspective.
#
# What it preserves (standalone-only — never overwritten):
#   package.json        — different name + scripts (no monorepo dev script)
#   tsconfig.json       — references removed (no ../../lib/api-client-react)
#   pnpm-lock.yaml      — standalone lockfile; regenerate with `pnpm install` after syncing deps
#   pnpm-workspace.yaml — empty packages list that isolates this folder from the monorepo root
#   .npmrc              — node-linker=hoisted (required for React Native native modules)
#   README.md           — standalone-specific documentation
#   .env / .env.example — environment variables
#   .gitignore          — standalone ignores
#   .replit-artifact/   — Replit artifact metadata

set -euo pipefail

# SYNC_STANDALONE_REPO_ROOT overrides the auto-detected root so tests can point
# the script at a throwaway temp workspace instead of the real monorepo.
REPO_ROOT="${SYNC_STANDALONE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC="$REPO_ROOT/artifacts/travel-buddy"
DST="$REPO_ROOT/travel-buddy-standalone"

DRY_RUN=false
APPLY_DEPS=false
CHECK_SOURCE=false
CHECK_DEPS=false
CHECK_LOCKFILE=false
FIX_LOCKFILE=false
FIX_SOURCE=false
TOTAL_ADDED=0
TOTAL_UPDATED=0
TOTAL_REMOVED=0
SOURCE_DRIFT_THRESHOLD="${SOURCE_DRIFT_THRESHOLD:-0}"
# Default: all directories that the sync step copies (docs/migrations/scripts/server are
# lower-churn; include them anyway so no directory silently escapes the check).
SOURCE_DRIFT_DIRS="${SOURCE_DRIFT_DIRS:-src app assets components constants hooks docs migrations scripts server}"

for arg in "$@"; do
  case "$arg" in
    --dry-run)          DRY_RUN=true ;;
    --apply-deps)       APPLY_DEPS=true ;;
    --check-source)     CHECK_SOURCE=true ;;
    --check-deps)       CHECK_DEPS=true ;;
    --check-lockfile)   CHECK_LOCKFILE=true ;;
    --fix-lockfile)     FIX_LOCKFILE=true ;;
    --fix-source)       FIX_SOURCE=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Files that are edited directly in travel-buddy-standalone and must NEVER be
# overwritten by --fix-source or the full sync.
# Paths are relative to the standalone root (same shape as paths inside $DST),
# e.g. "app/(tabs)/discovery.tsx".
# Add any file here that you intend to maintain exclusively in standalone.
# ---------------------------------------------------------------------------
STANDALONE_OWNED_FILES=(
  # Tests for standalone-owned screens — the canonical refactors of these
  # suites target the monorepo's screen architecture and fail against the
  # standalone-owned components below; standalone keeps its own versions.
  "app/(tabs)/__tests__/discovery.contextModeChips.component.test.tsx"
  "app/(tabs)/__tests__/Discovery.navBarScrollHandler.component.test.tsx"
  "app/(tabs)/__tests__/Discovery.scrollArchitecture.component.test.tsx"
  "app/(tabs)/__tests__/Pulse.navBarScrollHandler.component.test.tsx"
  "app/(tabs)/__tests__/Pulse.sessionIdToTapOutcome.component.test.tsx"
  "app/__tests__/search.homeCityCoords.component.test.tsx"
  "app/__tests__/search.lastKnownCoords.component.test.tsx"
  "app/__tests__/search.sessionLocationCoords.component.test.tsx"
  "app/__tests__/search.sourceSwitchCoords.component.test.tsx"
  "src/components/discovery/__tests__/DiscoveryScreen.component.test.tsx"
  "src/components/__tests__/PassportContent.focusTTL.component.test.tsx"
  # Canonical-only suites: they test the monorepo discovery screen's city
  # picker / map shortcut wiring, which the standalone-owned discovery.tsx
  # does not share. Deliberately absent from the standalone tree.
  "app/(tabs)/__tests__/discovery.dimmedChipOpensCityPicker.component.test.tsx"
  "app/(tabs)/__tests__/discovery.enabledChips.component.test.tsx"
  "app/(tabs)/__tests__/discovery.mapShortcut.component.test.tsx"
  "app/(tabs)/__tests__/discovery.mapShortcutGeocode.component.test.tsx"
  "app/(tabs)/discovery.tsx"
  "app/(tabs)/index.tsx"
  "src/components/discovery/DiscoveryMapView.tsx"
  "src/components/discovery/DiscoveryCategoryTab.tsx"
  "src/components/discovery/ForYouTab.tsx"
  "src/hooks/__tests__/useTripSavedPlaces.component.test.tsx"
  "src/hooks/__tests__/TripSavedPlacesSection.component.test.tsx"
  "src/hooks/__tests__/useGemCheckin.component.test.ts"
  "src/__mocks__/lucide-react-native.tsx"
  "src/services/__tests__/stampArtwork.test.ts"
  "src/services/__tests__/location.gps.component.test.ts"
  "src/components/__tests__/ReviewComposer.prefill.component.test.tsx"
  "src/components/__tests__/ReviewsSection.place.component.test.tsx"
  "src/components/__tests__/ReviewsSection.delete.component.test.tsx"
  "src/components/discovery/__tests__/FilterStrip.nearest.test.ts"
  "src/components/discovery/__tests__/FilterStrip.sort.test.ts"
  "src/components/discovery/__tests__/DiscoveryCategoryTab.nearest.test.ts"
  "src/components/discovery/filterStripNearest.ts"
  "src/components/discovery/filterStripSort.ts"
  "src/components/PulseCreate.machine.ts"
  "src/components/__tests__/PulseCreate.backdrop.test.ts"
  "src/components/__tests__/PulseCreate.submit.test.ts"
  "src/components/__tests__/PulseCreate.categoryGate.test.ts"
  "src/components/PulseFilterSheet.machine.ts"
  "src/components/__tests__/PulseFilterSheet.backdrop.test.ts"
  "src/services/__tests__/locationPrefs.load.test.ts"
  "src/services/locationPrefsLogic.ts"
  "src/components/__tests__/PulseCreate.filter.test.ts"
  "src/services/__tests__/media.upload.test.ts"
  "app/gems/submit.machine.ts"
  "src/services/__tests__/gems.submit.wizard.component.test.ts"
  "src/components/location/MapLocationPicker.machine.ts"
  "src/services/__tests__/mapLocationPicker.component.test.ts"
  "app/settings/settings.machine.ts"
  "app/settings/index.tsx"
  "src/test/accountActivation.test.ts"
  "src/test/discoverySearch.test.ts"
  "src/test/DiscoveryBlockedUsers.test.ts"
  "src/test/DiscoveryCityRefresh.test.ts"
  "src/test/onboardingPassportFlow.test.ts"
  "src/test/authEnsureProfile.test.ts"
  "src/services/fillHomeFromGps.machine.ts"
  "src/services/__tests__/fillHomeFromGps.test.ts"
  "src/components/__tests__/CreateMemory.doubletap.test.ts"
  "src/components/__tests__/TripEditor.doubletap.test.ts"
  "src/components/__tests__/ProfileEdit.doubletap.test.ts"
  "src/components/__tests__/ChangePassword.doubletap.test.ts"
  "src/components/__tests__/SettingsScreens.doubletap.test.ts"
  "src/components/__tests__/SafeReturn.doubletap.test.ts"
  "src/components/__tests__/SafeReturnActiveCard.doubletap.test.ts"
  "src/components/safeReturn/SafeReturnSetupSheet.openEffect.ts"
  "src/components/__tests__/SafeReturnSetupSheet.openEffect.test.ts"
  "src/components/__tests__/SafeReturnSetupSheet.contactLoad.test.ts"
  "src/components/__tests__/SafeReturnSetupSheet.integration.test.ts"
  "app/profile/change-password.tsx"
  "src/lib/compassIntent.ts"
  "src/lib/__tests__/compassIntent.test.ts"
  "src/lib/__tests__/invitePreviewMapper.test.ts"
  "src/components/compass/CompassPicksSection.tsx"
  "src/components/discovery/__tests__/CompassPicksSection.test.ts"
  "src/services/livePulse.ts"
  "src/hooks/useLivePulse.ts"
  "src/components/LivePulseCard.tsx"
  "src/components/LivePulseRail.tsx"
  "src/components/LivePulseRail.machine.ts"
  "src/components/__tests__/LivePulseRail.test.ts"
  "src/components/compass/CompassBuddyRow.tsx"
  "src/components/compass/CompassTravelerRow.tsx"
  "src/components/compass/__tests__/CompassBuddyRow.hide.test.ts"
  "src/components/compass/__tests__/CompassTravelerRow.followState.test.ts"
  "app/search.tsx"
  # Compass Feedback Loop — Phase 5
  "src/components/compass/CompassFeedbackMenu.tsx"
  "src/components/compass/CompassOnboardingCard.tsx"
  "src/hooks/compass/useCompassSettings.ts"
  "app/compass-settings.tsx"
  # Trip gone error path tests
  "src/test/tripGoneError.test.ts"
  "src/lib/__tests__/inviteCardGoneHandler.test.ts"
  "src/lib/inviteCardGoneHandler.ts"
  # Pulse feed save/pagination tests
  "src/components/__tests__/PulseFeed.save.pagination.test.ts"
  # Trips & Events audit tests (Task 1864)
  "src/lib/__tests__/inviteRetryGuard.test.ts"
  "src/lib/__tests__/waitlistState.test.ts"
  "src/lib/__tests__/eventRoleActions.test.ts"
  # Feature Flags screen machine-layer tests (machine file syncs from artifact; test is standalone-only)
  "src/screens/admin/__tests__/featureFlags.machine.test.ts"
  # FlagHistorySheet machine-layer tests — test is standalone-only
  "src/screens/admin/__tests__/flagHistory.machine.test.ts"
  # Screen-suite tests tailored to the standalone fork's owned screens
  # (discovery.tsx / index.tsx are STANDALONE_OWNED; search.tsx reads
  # useActiveLocation, not the monorepo resolvedLocation cascade — the
  # monorepo versions of these suites assert architecture the fork lacks).
  "app/(tabs)/__tests__/Discovery.navBarScrollHandler.component.test.tsx"
  "app/(tabs)/__tests__/Discovery.scrollArchitecture.component.test.tsx"
  "app/(tabs)/__tests__/discovery.contextModeChips.component.test.tsx"
  "app/(tabs)/__tests__/discovery.dimmedChipOpensCityPicker.component.test.tsx"
  "app/(tabs)/__tests__/discovery.enabledChips.component.test.tsx"
  "app/(tabs)/__tests__/discovery.mapShortcut.component.test.tsx"
  "app/(tabs)/__tests__/discovery.mapShortcutGeocode.component.test.tsx"
  "app/(tabs)/__tests__/Pulse.navBarScrollHandler.component.test.tsx"
  "app/(tabs)/__tests__/Pulse.sessionIdToTapOutcome.component.test.tsx"
  "app/__tests__/search.homeCityCoords.component.test.tsx"
  "app/__tests__/search.lastKnownCoords.component.test.tsx"
  "app/__tests__/search.sessionLocationCoords.component.test.tsx"
  "app/__tests__/search.sourceSwitchCoords.component.test.tsx"
  "src/components/discovery/__tests__/DiscoveryScreen.component.test.tsx"
  # Standalone copy keeps the DestinationsTab maplibre mock (ESM import crash)
  "src/components/__tests__/PassportContent.focusTTL.component.test.tsx"
)

# Returns 0 (success/true) if the given standalone-relative path is protected.
is_standalone_owned() {
  local rel_path="$1"
  if [[ ${#STANDALONE_OWNED_FILES[@]} -eq 0 ]]; then return 1; fi
  for owned in "${STANDALONE_OWNED_FILES[@]}"; do
    [[ "$rel_path" == "$owned" ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Perspective guard — mirrors findPerspectiveViolations in
# scripts/src/cross-tree-paths.test.ts.
#
# Some files (e.g. src/services/sdk54-downgrade-compat.test.ts) exist in BOTH
# trees but use tree-specific relative paths. Blindly copying the monorepo
# copy into travel-buddy-standalone/ makes those paths resolve OUTSIDE the
# workspace and fail with ENOENT at test run time. The sync must refuse such
# copies instead of letting the cross-tree-paths guard catch the breakage
# later.
#
# The regexes anchor on the opening quote/backtick so '../../pnpm-lock.yaml'
# does not match inside '../../../../pnpm-lock.yaml' (same trick as the guard).
#
# PARITY: the marker strings these regexes encode are defined in
# scripts/src/perspective-markers.ts (the single source of truth for the guard
# test). A parity test in scripts/src/cross-tree-paths.test.ts parses these two
# variables and fails when they drift from that list — update both together.
# ---------------------------------------------------------------------------
MONO_PERSPECTIVE_RE="['\"\`]\.\./\.\./\.\./\.\./(travel-buddy-standalone/|pnpm-lock\.yaml)"
SA_PERSPECTIVE_RE="['\"\`](\.\./\.\./\.\./artifacts/travel-buddy/|\.\./\.\./pnpm-lock\.yaml|\.\./\.\./\.\./pnpm-lock\.yaml)"

TOTAL_PERSPECTIVE_BLOCKED=0

# Prints "monorepo" or "standalone" when the file's content contains
# tree-specific relative paths; prints nothing when the file is neutral.
detect_path_perspective() {
  local file="$1"
  if grep -Eq "$MONO_PERSPECTIVE_RE" "$file" 2>/dev/null; then
    echo "monorepo"
  elif grep -Eq "$SA_PERSPECTIVE_RE" "$file" 2>/dev/null; then
    echo "standalone"
  fi
  return 0
}

# Prints the refusal message for a perspective-divergent file.
# $1 = mode ("dry" | "apply"), $2 = tree-relative path, $3 = detected perspective
report_perspective_refusal() {
  local mode="$1" rel="$2" persp="$3"
  local prefix=""
  [[ "$mode" == "dry" ]] && prefix="[dry] "
  echo "    ${prefix}[perspective-divergent] $rel — REFUSED (not overwritten)"
  if [[ "$persp" == "monorepo" ]]; then
    echo "        Source copy contains monorepo-perspective relative paths (e.g. '../../../../travel-buddy-standalone/' or '../../../../pnpm-lock.yaml')."
    echo "        Copying it into travel-buddy-standalone/ would make those paths resolve OUTSIDE the workspace and fail with ENOENT at test run time."
  else
    echo "        Source copy contains standalone-perspective relative paths (e.g. '../../../artifacts/travel-buddy/' or '../../pnpm-lock.yaml')."
    echo "        The monorepo copy looks like it was itself overwritten by a bad reverse sync — fix the artifacts/travel-buddy/ copy first."
  fi
  echo "        Port the change manually using the destination tree's perspective (guard: scripts/src/cross-tree-paths.test.ts)."
}

# ---------------------------------------------------------------------------
# Helper: sync a directory — file-by-file, respecting STANDALONE_OWNED_FILES.
# Defined early so both --fix-source and the main sync path can call it.
# ---------------------------------------------------------------------------
sync_dir() {
  local name="$1"
  local from="$SRC/$name"
  local to="$DST/$name"

  if [[ ! -d "$from" ]]; then
    echo "    (skipping $name/ — not present in source)"
    return
  fi

  echo ">>> $name/"

  if $DRY_RUN; then
    # Show what would change: new/modified files in source vs destination
    while IFS= read -r -d '' f; do
      rel="${f#$from/}"
      dst_file="$to/$rel"
      if is_standalone_owned "$name/$rel"; then
        echo "    [dry] [protected] $name/$rel (standalone-owned — would skip)"
        continue
      fi
      # Only files that would actually be written need the perspective check.
      if [[ ! -f "$dst_file" ]] || ! diff -q "$f" "$dst_file" &>/dev/null; then
        persp="$(detect_path_perspective "$f")"
        if [[ -n "$persp" ]]; then
          report_perspective_refusal "dry" "$name/$rel" "$persp"
          TOTAL_PERSPECTIVE_BLOCKED=$(( TOTAL_PERSPECTIVE_BLOCKED + 1 ))
          continue
        fi
      fi
      if [[ ! -f "$dst_file" ]]; then
        echo "    [dry] + $name/$rel (new)"
      elif ! diff -q "$f" "$dst_file" &>/dev/null; then
        echo "    [dry] ~ $name/$rel (changed)"
      fi
    done < <(find "$from" -type f -not -path "*/node_modules/*" -print0)

    # Files in destination that no longer exist in source
    if [[ -d "$to" ]]; then
      while IFS= read -r -d '' f; do
        rel="${f#$to/}"
        if [[ ! -f "$from/$rel" ]]; then
          if is_standalone_owned "$name/$rel"; then
            echo "    [dry] [protected] $name/$rel (standalone-owned — would keep)"
          else
            echo "    [dry] - $name/$rel (removed from source)"
          fi
        fi
      done < <(find "$to" -type f -not -path "*/node_modules/*" -print0)
    fi
  else
    local added=0 updated=0 removed=0 protected=0 blocked=0

    # ── Copy source → destination, file-by-file, skipping protected files ────
    mkdir -p "$to"
    while IFS= read -r -d '' f; do
      local rel="${f#$from/}"
      local dst_file="$to/$rel"

      if is_standalone_owned "$name/$rel"; then
        echo "    [protected] $name/$rel (standalone-owned — not overwritten)"
        protected=$(( protected + 1 ))
        continue
      fi

      # Refuse to write perspective-divergent files into the standalone tree.
      if [[ ! -f "$dst_file" ]] || ! diff -q "$f" "$dst_file" &>/dev/null; then
        local persp
        persp="$(detect_path_perspective "$f")"
        if [[ -n "$persp" ]]; then
          report_perspective_refusal "apply" "$name/$rel" "$persp"
          blocked=$(( blocked + 1 ))
          TOTAL_PERSPECTIVE_BLOCKED=$(( TOTAL_PERSPECTIVE_BLOCKED + 1 ))
          continue
        fi
      fi

      if [[ ! -f "$dst_file" ]]; then
        mkdir -p "$(dirname "$dst_file")"
        cp -p "$f" "$dst_file"
        added=$(( added + 1 ))
      elif ! diff -q "$f" "$dst_file" &>/dev/null; then
        cp -p "$f" "$dst_file"
        updated=$(( updated + 1 ))
      fi
    done < <(find "$from" -type f -not -path "*/node_modules/*" -print0)

    # ── Remove stale files (in destination but gone from source) ─────────────
    if [[ -d "$to" ]]; then
      while IFS= read -r -d '' f; do
        local rel="${f#$to/}"
        if [[ ! -f "$from/$rel" ]]; then
          if is_standalone_owned "$name/$rel"; then
            echo "    [protected] $name/$rel (standalone-owned — kept despite removal from source)"
          else
            rm -f "$f"
            removed=$(( removed + 1 ))
          fi
        fi
      done < <(find "$to" -type f -not -path "*/node_modules/*" -print0)
    fi

    local suffix=""
    if [[ $protected -gt 0 ]]; then
      suffix=" (${protected} standalone-owned file(s) protected)"
    fi
    if [[ $blocked -gt 0 ]]; then
      suffix="${suffix} (${blocked} perspective-divergent file(s) REFUSED — port manually)"
    fi
    echo "    ${added} added, ${updated} updated, ${removed} removed${suffix}"

    TOTAL_ADDED=$(( TOTAL_ADDED + added ))
    TOTAL_UPDATED=$(( TOTAL_UPDATED + updated ))
    TOTAL_REMOVED=$(( TOTAL_REMOVED + removed ))
  fi
}

# Tracks whether any synced config file has drifted in dry-run mode.
# Set to 1 by sync_file when a difference is detected so CI can fail.
CONFIG_DRIFT_EXIT=0

# ---------------------------------------------------------------------------
# Helper: sync a single file
# ---------------------------------------------------------------------------
sync_file() {
  local name="$1"
  local from="$SRC/$name"
  local to="$DST/$name"

  if [[ ! -f "$from" ]]; then
    echo "    (skipping $name — not present in source)"
    return
  fi

  if $DRY_RUN; then
    if [[ ! -f "$to" ]]; then
      echo "    [dry] + $name (new)"
      CONFIG_DRIFT_EXIT=1
    elif ! diff -q "$from" "$to" &>/dev/null; then
      echo "    [dry] ~ $name (changed)"
      CONFIG_DRIFT_EXIT=1
    else
      echo "    [dry] = $name (unchanged)"
    fi
  else
    cp "$from" "$to"
    echo "    copied $name"
  fi
}

# ---------------------------------------------------------------------------
# --check-source mode: diff src/ and app/ then exit.
# Runs independently of --dry-run and --apply-deps.
# ---------------------------------------------------------------------------
if $CHECK_SOURCE; then
  # Build the array from the (possibly overridden) SOURCE_DRIFT_DIRS env var.
  read -r -a SOURCE_CHECK_DIRS <<< "$SOURCE_DRIFT_DIRS"

  echo "=== Source drift check: artifacts/travel-buddy vs travel-buddy-standalone ==="
  echo "    Directories: ${SOURCE_CHECK_DIRS[*]}"
  echo "    Threshold:   ${SOURCE_DRIFT_THRESHOLD} file(s)"
  echo ""

  SOURCE_DRIFT_COUNT=0
  PERSPECTIVE_DRIFT_COUNT=0

  for dir in "${SOURCE_CHECK_DIRS[@]}"; do
    from="$SRC/$dir"
    to="$DST/$dir"

    if [[ ! -d "$from" ]]; then
      echo "  (skipping $dir/ — not present in source)"
      continue
    fi

    if [[ ! -d "$to" ]]; then
      echo "  DRIFT: $dir/ exists in source but is missing in travel-buddy-standalone/"
      missing_count=$(find "$from" -type f -not -path "*/node_modules/*" | wc -l | tr -d ' ')
      echo "         ($missing_count file(s) in source have no standalone counterpart)"
      SOURCE_DRIFT_COUNT=$(( SOURCE_DRIFT_COUNT + missing_count ))
      continue
    fi

    echo "  >>> $dir/"
    dir_drift=0

    # Files added or modified in the source
    while IFS= read -r -d '' f; do
      rel="${f#$from/}"
      dst_file="$to/$rel"
      # Skip files that standalone owns — they are intentionally different
      if is_standalone_owned "$dir/$rel"; then
        echo "    [protected] $dir/$rel (standalone-owned — skipped)"
        continue
      fi
      if [[ ! -f "$dst_file" ]]; then
        persp="$(detect_path_perspective "$f")"
        if [[ -n "$persp" ]]; then
          echo "    ! $dir/$rel [perspective-divergent] (new in source — --fix-source will REFUSE this file; port manually)"
          if [[ "$persp" == "monorepo" ]]; then
            echo "        Source copy contains monorepo-perspective relative paths — copying it would break the standalone tree."
          else
            echo "        Source copy contains standalone-perspective relative paths — fix the artifacts/travel-buddy/ copy first."
          fi
          echo "        Port the change manually using the destination tree's perspective (guard: scripts/src/cross-tree-paths.test.ts)."
          dir_drift=$(( dir_drift + 1 ))
          PERSPECTIVE_DRIFT_COUNT=$(( PERSPECTIVE_DRIFT_COUNT + 1 ))
        else
          echo "    + $dir/$rel (new in source — missing from standalone)"
          dir_drift=$(( dir_drift + 1 ))
        fi
      elif ! diff -q "$f" "$dst_file" &>/dev/null; then
        persp="$(detect_path_perspective "$f")"
        if [[ -n "$persp" ]]; then
          echo "    ! $dir/$rel [perspective-divergent] (differs — --fix-source will REFUSE this file; port manually)"
          if [[ "$persp" == "monorepo" ]]; then
            echo "        Source copy contains monorepo-perspective relative paths — copying it would break the standalone tree."
          else
            echo "        Source copy contains standalone-perspective relative paths — fix the artifacts/travel-buddy/ copy first."
          fi
          echo "        Port the change manually using the destination tree's perspective (guard: scripts/src/cross-tree-paths.test.ts)."
          dir_drift=$(( dir_drift + 1 ))
          PERSPECTIVE_DRIFT_COUNT=$(( PERSPECTIVE_DRIFT_COUNT + 1 ))
        else
          echo "    ~ $dir/$rel (modified — standalone is out of date)"
          dir_drift=$(( dir_drift + 1 ))
        fi
      fi
    done < <(find "$from" -type f -not -path "*/node_modules/*" -print0 | sort -z)

    # Files in standalone that no longer exist in source
    while IFS= read -r -d '' f; do
      rel="${f#$to/}"
      src_file="$from/$rel"
      # Skip files that standalone owns — they may legitimately not exist in source
      if is_standalone_owned "$dir/$rel"; then
        continue
      fi
      if [[ ! -f "$src_file" ]]; then
        echo "    - $dir/$rel (removed from source — stale in standalone)"
        dir_drift=$(( dir_drift + 1 ))
      fi
    done < <(find "$to" -type f -not -path "*/node_modules/*" -print0 | sort -z)

    if [[ $dir_drift -eq 0 ]]; then
      echo "    (in sync)"
    else
      echo "    ($dir_drift file(s) differ)"
    fi

    SOURCE_DRIFT_COUNT=$(( SOURCE_DRIFT_COUNT + dir_drift ))
  done

  echo ""
  echo "  Total drifted files: $SOURCE_DRIFT_COUNT"
  if [[ $PERSPECTIVE_DRIFT_COUNT -gt 0 ]]; then
    echo "  Perspective-divergent: $PERSPECTIVE_DRIFT_COUNT file(s) — --fix-source will REFUSE these; port them manually."
  fi
  echo "  Threshold:           $SOURCE_DRIFT_THRESHOLD"
  echo ""

  if [[ $SOURCE_DRIFT_COUNT -gt $SOURCE_DRIFT_THRESHOLD ]]; then
    echo "FAIL: Source drift ($SOURCE_DRIFT_COUNT file(s)) exceeds threshold ($SOURCE_DRIFT_THRESHOLD)."
    echo ""
    if [[ $PERSPECTIVE_DRIFT_COUNT -gt 0 ]]; then
      echo "NOTE: $PERSPECTIVE_DRIFT_COUNT of these are perspective-divergent — --fix-source will NOT fix them."
      echo "      Port those changes manually using the destination tree's perspective."
      echo ""
    fi
    echo "To re-sync only the drifted source directories, run:"
    echo "  bash scripts/sync-standalone.sh --fix-source"
    echo ""
    echo "To preview what --fix-source would change without writing files:"
    echo "  bash scripts/sync-standalone.sh --dry-run --fix-source"
    echo ""
    echo "To do a full sync (source dirs + config files), run:"
    echo "  bash scripts/sync-standalone.sh"
    exit 1
  else
    echo "PASS: Source drift is within the acceptable threshold."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# --check-deps mode: compare package.json deps, then exit.
# Read-only — never writes files. Runs independently of all other flags.
# ---------------------------------------------------------------------------
if $CHECK_DEPS; then
  echo "=== Dependency drift check: artifacts/travel-buddy vs travel-buddy-standalone ==="
  echo ""

  node - "$SRC/package.json" "$DST/package.json" <<'NODEEOF'
const fs = require('fs');
const [,, srcPath, dstPath] = process.argv;

let srcPkg, dstPkg;
try { srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf8')); }
catch (e) { console.error('Cannot read source package.json:', e.message); process.exit(1); }
try { dstPkg = JSON.parse(fs.readFileSync(dstPath, 'utf8')); }
catch (e) { console.error('Cannot read standalone package.json:', e.message); process.exit(1); }

const sections = ['dependencies', 'devDependencies'];
const changes = { dependencies: [], devDependencies: [] };
let totalChanges = 0;

for (const section of sections) {
  const src = srcPkg[section] || {};
  const dst = dstPkg[section] || {};

  for (const pkg of Object.keys(src).sort()) {
    if (dst[pkg] === undefined) {
      changes[section].push({ type: 'add', pkg, version: src[pkg] });
      totalChanges++;
    } else if (dst[pkg] !== src[pkg]) {
      changes[section].push({ type: 'update', pkg, from: dst[pkg], version: src[pkg] });
      totalChanges++;
    }
  }

  // Standalone-only packages: reported but do not count toward failure — intentional divergence.
  for (const pkg of Object.keys(dst).sort()) {
    if (src[pkg] === undefined) {
      console.log(`  [standalone-only] ${section}/${pkg}: ${dst[pkg]} (preserved — no action required)`);
    }
  }
}

if (totalChanges === 0) {
  console.log('');
  console.log('PASS: No dependency drift — standalone is in sync with the monorepo app.');
  process.exit(0);
}

// Print drift summary
for (const section of sections) {
  if (changes[section].length === 0) continue;
  console.log(`\n[${section}]`);
  for (const c of changes[section]) {
    if (c.type === 'add')
      console.log(`  + ${c.pkg}: ${c.version}  (present in monorepo app — missing from standalone)`);
    else
      console.log(`  ~ ${c.pkg}: ${c.from} → ${c.version}  (version mismatch)`);
  }
}

console.log('');
console.log(`FAIL: ${totalChanges} dependency difference(s) found.`);
console.log('');
console.log('To apply these changes automatically, run:');
console.log('  bash scripts/sync-standalone.sh --apply-deps');
console.log('Then reinstall standalone deps:');
console.log('  cd travel-buddy-standalone && pnpm install');
console.log('');
console.log('To preview what --apply-deps would change without writing files:');
console.log('  bash scripts/sync-standalone.sh --dry-run --apply-deps');
process.exit(1);
NODEEOF

  exit $?
fi

# ---------------------------------------------------------------------------
# --check-lockfile mode: compare resolved versions in pnpm-lock.yaml files.
#
# Reads:
#   $REPO_ROOT/pnpm-lock.yaml            (importer key: "artifacts/travel-buddy")
#   $DST/pnpm-lock.yaml                  (importer key: ".")
#
# For every direct dependency (dependencies + devDependencies) that appears in
# both importers, compares the resolved "version:" string.  A mismatch means
# the two lock files resolved the package differently, which can cause native
# module build failures on EAS that are hard to trace.
#
# Standalone-only packages are reported as informational and never cause a
# failure.  Packages in the monorepo app but missing from the standalone
# lockfile DO cause a failure (run --check-deps / --apply-deps first).
# ---------------------------------------------------------------------------
if $CHECK_LOCKFILE; then
  echo "=== Lockfile drift check: root pnpm-lock.yaml (artifacts/travel-buddy) vs travel-buddy-standalone/pnpm-lock.yaml ==="
  echo ""

  node - "$REPO_ROOT/pnpm-lock.yaml" "$DST/pnpm-lock.yaml" <<'NODEEOF'
const fs = require('fs');
const [,, rootLockPath, standaloneLockPath] = process.argv;

// ---------------------------------------------------------------------------
// Minimal pnpm-lock.yaml v9 parser.
//
// Extracts the direct-dependency map for a named importer key.
// Returns: Map<pkgName, resolvedVersion>
//
// The lockfile format uses consistent 2-space indentation:
//   importers:
//     <importerKey>:            <- 2-space indent
//       dependencies:           <- 4-space indent
//         <pkg>:                <- 6-space indent
//           specifier: ...      <- 8-space indent
//           version: <resolved> <- 8-space indent (this is what we compare)
// ---------------------------------------------------------------------------
function parseImporterDeps(content, importerKey) {
  const lines = content.split('\n');
  const deps = new Map();

  // Normalise the key: keys in the lockfile may be bare (e.g. `.`) or quoted.
  // We match both `  importerKey:` and `  'importerKey':`.
  const keyPattern = new RegExp(`^  (?:'${importerKey}'|${importerKey.replace(/[/\\]/g, '\\$&')}):$`);

  let inTargetImporter = false;
  let inDepsSection = false;
  let currentPkg = null;

  for (const rawLine of lines) {
    const stripped = rawLine.trimEnd();

    // Detect the start of a new top-level section (0 indent), e.g. "packages:"
    if (stripped.length > 0 && stripped[0] !== ' ' && stripped !== 'importers:') {
      if (inTargetImporter) break; // left the importers block
      continue;
    }

    // Detect the target importer key (2-space indent).
    if (keyPattern.test(stripped)) {
      inTargetImporter = true;
      inDepsSection = false;
      currentPkg = null;
      continue;
    }

    if (!inTargetImporter) continue;

    // Another importer at the same level (2-space indent) — we're done.
    if (/^  \S/.test(stripped) && !keyPattern.test(stripped)) {
      break;
    }

    // Enter a dep section (4-space indent): "    dependencies:" or "    devDependencies:"
    if (/^    (dependencies|devDependencies):$/.test(stripped)) {
      inDepsSection = true;
      currentPkg = null;
      continue;
    }

    // Leave dep sections when we hit another 4-space-indented key that is not deps.
    if (/^    \S/.test(stripped)) {
      inDepsSection = false;
      currentPkg = null;
      continue;
    }

    if (!inDepsSection) continue;

    // Package name entry (6-space indent): "      pkg-name:"
    const pkgMatch = stripped.match(/^      ([^: ]+):$/);
    if (pkgMatch) {
      currentPkg = pkgMatch[1];
      continue;
    }

    // Resolved version line (8-space indent): "        version: <resolved>"
    if (currentPkg) {
      const versionMatch = stripped.match(/^        version: (.+)$/);
      if (versionMatch) {
        deps.set(currentPkg, versionMatch[1].trim());
        continue;
      }
    }
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Load both lockfiles.
// ---------------------------------------------------------------------------
let rootContent, standaloneContent;
try { rootContent = fs.readFileSync(rootLockPath, 'utf8'); }
catch (e) { console.error(`Cannot read root lockfile (${rootLockPath}): ${e.message}`); process.exit(1); }
try { standaloneContent = fs.readFileSync(standaloneLockPath, 'utf8'); }
catch (e) { console.error(`Cannot read standalone lockfile (${standaloneLockPath}): ${e.message}`); process.exit(1); }

const monorepoKey  = 'artifacts/travel-buddy';
const standaloneKey = '.';

const monorepoDeps   = parseImporterDeps(rootContent, monorepoKey);
const standaloneDeps = parseImporterDeps(standaloneContent, standaloneKey);

if (monorepoDeps.size === 0) {
  console.error(`No deps found for importer "${monorepoKey}" in ${rootLockPath}.`);
  console.error('Check that the lockfile is pnpm v9 format and the importer key is correct.');
  process.exit(1);
}
if (standaloneDeps.size === 0) {
  console.error(`No deps found for importer "${standaloneKey}" in ${standaloneLockPath}.`);
  console.error('Check that the standalone lockfile is pnpm v9 format.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Compare resolved versions for shared direct dependencies.
// ---------------------------------------------------------------------------
const mismatches = [];
const standaloneOnly = [];

for (const [pkg, standaloneVer] of standaloneDeps) {
  if (!monorepoDeps.has(pkg)) {
    standaloneOnly.push({ pkg, standaloneVer });
  }
}

// pnpm appends a peer-context suffix to resolved versions, e.g.
// "2.20.1(@types/dom-mediacapture-record@1.0.22)" or a digest like
// "6.0.24(2b9a2435f5dce2ef9407ffdd4d322efd)". A workspace-hoisted install and
// a standalone install legitimately resolve different peer CONTEXTS for the
// same package version, and `pnpm install` can never converge them. Only the
// bare version matters for EAS native-build reproducibility, so compare that;
// peer-suffix-only differences are surfaced as informational notes below.
const bareVersion = (v) => v.split('(')[0];
// pnpm patches surface as a "(patch_hash=...)" suffix — unlike peer-context
// suffixes, a patch difference DOES change the installed package contents,
// so it must fail the check even when the bare version matches.
const hasPatch = (v) => v.includes('patch_hash=');
const peerOnlyDiffs = [];
for (const [pkg, monoVer] of monorepoDeps) {
  if (!standaloneDeps.has(pkg)) {
    mismatches.push({ type: 'missing', pkg, monoVer });
    continue;
  }
  const saVer = standaloneDeps.get(pkg);
  const bareDiffers = bareVersion(saVer) !== bareVersion(monoVer);
  const patchDiffers = saVer !== monoVer && (hasPatch(saVer) || hasPatch(monoVer));
  if (bareDiffers || patchDiffers) {
    mismatches.push({ type: 'mismatch', pkg, monoVer, standaloneVer: saVer });
  } else if (saVer !== monoVer) {
    peerOnlyDiffs.push({ pkg });
  }
}

// Standalone-only: informational only, never a failure.
for (const { pkg, standaloneVer } of standaloneOnly) {
  console.log(`  [standalone-only] ${pkg}: ${standaloneVer} (no action required)`);
}

// Same bare version, different pnpm peer-context suffix: informational only.
for (const { pkg } of peerOnlyDiffs) {
  console.log(`  [peer-context] ${pkg}: same version, different pnpm peer suffix (no action required)`);
}

if (mismatches.length === 0) {
  console.log('');
  console.log('PASS: No lockfile drift — resolved versions match for all shared direct dependencies.');
  process.exit(0);
}

console.log('');
for (const m of mismatches) {
  if (m.type === 'missing') {
    console.log(`  MISSING  ${m.pkg}`);
    console.log(`           monorepo resolved: ${m.monoVer}`);
    console.log(`           standalone: not found in lockfile`);
    console.log(`           → Run: bash scripts/sync-standalone.sh --apply-deps && cd travel-buddy-standalone && pnpm install`);
  } else {
    console.log(`  MISMATCH ${m.pkg}`);
    console.log(`           monorepo resolved:   ${m.monoVer}`);
    console.log(`           standalone resolved: ${m.standaloneVer}`);
    console.log(`           → Run: cd travel-buddy-standalone && pnpm install to re-resolve`);
  }
  console.log('');
}

console.log(`FAIL: ${mismatches.length} lockfile drift(s) found.`);
console.log('');
console.log('Direct dependency resolved versions differ between the monorepo app and standalone.');
console.log('This can cause native-module build failures on EAS that are hard to trace.');
console.log('');
console.log('To fix:');
console.log('  1. bash scripts/sync-standalone.sh --apply-deps   # sync package.json versions');
console.log('  2. cd travel-buddy-standalone && pnpm install      # re-resolve the lockfile');
console.log('  3. bash scripts/sync-standalone.sh --check-lockfile  # verify');
process.exit(1);
NODEEOF

  exit $?
fi

# ---------------------------------------------------------------------------
# --fix-lockfile mode: apply deps + reinstall standalone to eliminate drift.
#
# Three steps:
#   1. --apply-deps  — sync package.json specifiers (self-call)
#   2. pnpm install  — re-resolve the standalone lockfile
#   3. --check-lockfile — verify drift is cleared (self-call)
#
# If drift persists after reinstall (same semver range, different resolution),
# prints guidance for manual alignment via pnpm update in the monorepo.
# Not compatible with --dry-run — always writes files.
# ---------------------------------------------------------------------------
if $FIX_LOCKFILE; then
  echo "=== Fix lockfile: syncing standalone resolved versions with monorepo ==="
  echo "    Source : $SRC"
  echo "    Target : $DST"
  echo ""

  echo "--- Step 1: sync package.json dependency specifiers ---"
  SYNC_STANDALONE_REPO_ROOT="$REPO_ROOT" bash "${BASH_SOURCE[0]}" --apply-deps
  echo ""

  echo "--- Step 2: reinstall standalone to re-resolve lockfile ---"
  if ! command -v pnpm &>/dev/null; then
    echo "ERROR: pnpm not found in PATH. Install pnpm and re-run."
    exit 1
  fi
  ( cd "$DST" && pnpm install )
  echo ""

  echo "--- Step 3: verify lockfile drift is resolved ---"
  if SYNC_STANDALONE_REPO_ROOT="$REPO_ROOT" bash "${BASH_SOURCE[0]}" --check-lockfile; then
    echo ""
    echo "=== Fix-lockfile complete — no drift remaining ==="
    echo ""
    echo "Next: run typecheck to verify the standalone is healthy:"
    echo "  cd travel-buddy-standalone && pnpm typecheck"
  else
    echo ""
    echo "=== Fix-lockfile: drift remains after reinstall ==="
    echo ""
    echo "Both lockfiles are internally valid for their semver ranges but resolved"
    echo "to different patch versions. Force the monorepo to the newer resolution:"
    echo ""
    echo "  pnpm --filter @workspace/travel-buddy update <package-name>"
    echo "  bash scripts/sync-standalone.sh --fix-lockfile"
    echo ""
    echo "If the monorepo uses 'catalog:' for the package, also update the catalog"
    echo "entry in pnpm-workspace.yaml and revert package.json to a concrete version."
    exit 1
  fi
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# --fix-source mode: re-sync only the SOURCE_DRIFT_DIRS directories, then exit.
# Respects --dry-run. Does not touch package.json, tsconfig.json, babel.config.js,
# metro.config.js, or any other preserved file.
# ---------------------------------------------------------------------------
if $FIX_SOURCE; then
  read -r -a FIX_SOURCE_DIRS <<< "$SOURCE_DRIFT_DIRS"

  if $DRY_RUN; then
    echo "=== DRY RUN — no files will be written ==="
  fi
  echo ""
  echo "=== Fix source: re-syncing drifted directories ==="
  echo "    Source : $SRC"
  echo "    Target : $DST"
  echo "    Directories: ${FIX_SOURCE_DIRS[*]}"
  echo ""

  for dir in "${FIX_SOURCE_DIRS[@]}"; do
    sync_dir "$dir"
  done

  echo ""
  if $DRY_RUN; then
    echo "=== Dry run complete — no files were written ==="
    echo ""
    echo "To apply these changes, run:"
    echo "  bash scripts/sync-standalone.sh --fix-source"
  else
    echo "=== Fix-source complete ==="
    echo "    Total: ${TOTAL_ADDED} added, ${TOTAL_UPDATED} updated, ${TOTAL_REMOVED} removed"
    if [[ $TOTAL_PERSPECTIVE_BLOCKED -gt 0 ]]; then
      echo "    REFUSED: ${TOTAL_PERSPECTIVE_BLOCKED} perspective-divergent file(s) were NOT overwritten (see messages above)."
      echo "    Port those changes manually using the destination tree's perspective."
    fi
    echo ""
    echo "Next: run typecheck to verify the standalone is healthy:"
    echo "  cd travel-buddy-standalone && pnpm typecheck"
    echo ""
    echo "To check for any remaining drift:"
    echo "  bash scripts/sync-standalone.sh --check-source"
  fi
  echo ""
  exit 0
fi

if $DRY_RUN; then
  echo "=== DRY RUN — no files will be written ==="
fi

echo ""
echo "Source : $SRC"
echo "Target : $DST"
echo ""

# ---------------------------------------------------------------------------
# 1. Sync directories
# ---------------------------------------------------------------------------
DIRS=(app src assets components constants hooks docs migrations scripts server)

for dir in "${DIRS[@]}"; do
  sync_dir "$dir"
done

# ---------------------------------------------------------------------------
# 2. Sync individual config files
# ---------------------------------------------------------------------------
echo ""
echo ">>> config files"
CONFIG_FILES=(app.json eas.json expo-env.d.ts)

for f in "${CONFIG_FILES[@]}"; do
  sync_file "$f"
done

# ---------------------------------------------------------------------------
# 3. Dependency diff + optional auto-apply
#
# In diff-only mode (no --apply-deps): reports drift and exits with code 1
#   when differences are found.
# In apply mode (--apply-deps, not --dry-run): patches the standalone
#   package.json in-place and exits with code 0.
# In dry-run + apply mode: shows what would be applied but writes nothing.
# ---------------------------------------------------------------------------
manage_package_json_deps() {
  local do_apply="$1"   # "true" | "false"
  local dry_run="$2"    # "true" | "false"

  node - "$SRC/package.json" "$DST/package.json" "$do_apply" "$dry_run" <<'NODEEOF'
const fs = require('fs');
const [,, srcPath, dstPath, doApply, dryRun] = process.argv;
const shouldApply = doApply === 'true' && dryRun !== 'true';
const isDryRun    = dryRun === 'true';

let srcPkg, dstPkg;
try { srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf8')); }
catch (e) { console.error('Cannot read source package.json:', e.message); process.exit(1); }
try { dstPkg = JSON.parse(fs.readFileSync(dstPath, 'utf8')); }
catch (e) { console.error('Cannot read standalone package.json:', e.message); process.exit(1); }

const sections = ['dependencies', 'devDependencies'];
// changes[section] = array of { type:'add'|'update', pkg, version, from? }
const changes = { dependencies: [], devDependencies: [] };
let totalChanges = 0;

for (const section of sections) {
  const src = srcPkg[section] || {};
  const dst = dstPkg[section] || {};

  for (const pkg of Object.keys(src).sort()) {
    if (dst[pkg] === undefined) {
      changes[section].push({ type: 'add', pkg, version: src[pkg] });
      totalChanges++;
    } else if (dst[pkg] !== src[pkg]) {
      changes[section].push({ type: 'update', pkg, from: dst[pkg], version: src[pkg] });
      totalChanges++;
    }
  }
  // Packages only in standalone are intentionally NOT removed — they may be
  // standalone-specific. They are reported separately so the developer is aware.
  for (const pkg of Object.keys(dst).sort()) {
    if (src[pkg] === undefined) {
      console.log(`  [standalone-only] ${section}/${pkg}: ${dst[pkg]} (preserved)`);
    }
  }
}

if (totalChanges === 0) {
  console.log('  (no dependency differences — standalone is in sync)');
  process.exit(0);
}

// Print summary of what will change / was changed
for (const section of sections) {
  if (changes[section].length === 0) continue;
  console.log(`\n[${section}]`);
  for (const c of changes[section]) {
    if (c.type === 'add')    console.log(`  + ${c.pkg}: ${c.version} (new)`);
    else                     console.log(`  ~ ${c.pkg}: ${c.from} → ${c.version}`);
  }
}

if (!shouldApply) {
  if (isDryRun) {
    console.log(`\n  [dry] would apply ${totalChanges} change(s) to travel-buddy-standalone/package.json`);
    console.log('  (no files written — dry run)');
    console.log('');
    console.log('  ACTION REQUIRED: dependencies are out of sync.');
    console.log('  To apply:  bash scripts/sync-standalone.sh --apply-deps');
    console.log('  Then:      cd travel-buddy-standalone && pnpm install');
  } else {
    console.log('\n  ACTION REQUIRED: dependencies are out of sync.');
    console.log('  Run:  bash scripts/sync-standalone.sh --apply-deps');
    console.log('  Then: cd travel-buddy-standalone && pnpm install');
  }
  process.exit(1);
}

// Apply: mutate dstPkg dep sections
for (const section of sections) {
  if (!dstPkg[section]) dstPkg[section] = {};
  for (const c of changes[section]) {
    dstPkg[section][c.pkg] = c.version;
  }
  // Re-sort the section keys alphabetically for a stable diff
  dstPkg[section] = Object.fromEntries(
    Object.entries(dstPkg[section]).sort(([a], [b]) => a.localeCompare(b))
  );
}

// Write back with 2-space indent + trailing newline (matches existing format)
fs.writeFileSync(dstPath, JSON.stringify(dstPkg, null, 2) + '\n');
console.log(`\n  Applied ${totalChanges} change(s) to travel-buddy-standalone/package.json`);
console.log('  Next: cd travel-buddy-standalone && pnpm install');
NODEEOF
}

# ---------------------------------------------------------------------------
# 3a. Diff-only check for preserved files that must stay in sync
#
# These files are never overwritten by this script (they have standalone-
# specific content), but they should still be kept in sync manually.
# CI exits non-zero when they diverge so the drift is caught early.
# ---------------------------------------------------------------------------
echo ""
echo "=== Preserved-file diff: artifacts/travel-buddy vs travel-buddy-standalone ==="

PRESERVED_DIFF_EXIT=0
PRESERVED_FILES=(.env.example)

for f in "${PRESERVED_FILES[@]}"; do
  src_file="$SRC/$f"
  dst_file="$DST/$f"

  if [[ ! -f "$src_file" ]]; then
    echo "  (skipping $f — not present in source)"
    continue
  fi
  if [[ ! -f "$dst_file" ]]; then
    echo "  DRIFT: $f exists in source but is missing in travel-buddy-standalone/"
    PRESERVED_DIFF_EXIT=1
    continue
  fi

  if diff -q "$src_file" "$dst_file" &>/dev/null; then
    echo "  = $f (in sync)"
  else
    echo "  ~ $f (DIFFERS — update travel-buddy-standalone/$f to match artifacts/travel-buddy/$f)"
    diff --unified=3 "$dst_file" "$src_file" || true
    PRESERVED_DIFF_EXIT=1
  fi
done

echo ""
echo "=== tsconfig.json compiler options diff: artifacts/travel-buddy vs travel-buddy-standalone ==="

TSCONFIG_DRIFT_EXIT=0

node - "$SRC/tsconfig.json" "$DST/tsconfig.json" <<'NODEEOF'
const fs = require('fs');
const [,, srcPath, dstPath] = process.argv;

let srcCfg, dstCfg;
try { srcCfg = JSON.parse(fs.readFileSync(srcPath, 'utf8')); }
catch (e) { console.error('Cannot read source tsconfig.json:', e.message); process.exit(1); }
try { dstCfg = JSON.parse(fs.readFileSync(dstPath, 'utf8')); }
catch (e) { console.error('Cannot read standalone tsconfig.json:', e.message); process.exit(1); }

// Drop 'references' — standalone intentionally omits the monorepo lib reference.
delete srcCfg.references;
delete dstCfg.references;

// The @db-types path alias is intentionally different between source and standalone:
// source uses ../../lib/database.types.ts (from artifacts/travel-buddy/) and
// standalone uses ../lib/database.types.ts (from travel-buddy-standalone/) —
// both resolve to workspace/lib/database.types.ts but use different relative strings.
// Normalise both to the same sentinel so this known difference is not flagged as drift.
if (srcCfg.compilerOptions && srcCfg.compilerOptions.paths && srcCfg.compilerOptions.paths['@db-types']) {
  srcCfg.compilerOptions.paths['@db-types'] = ['<workspace-lib-db-types>'];
}
if (dstCfg.compilerOptions && dstCfg.compilerOptions.paths && dstCfg.compilerOptions.paths['@db-types']) {
  dstCfg.compilerOptions.paths['@db-types'] = ['<workspace-lib-db-types>'];
}

// Stable serialiser: sort object keys recursively so key order doesn't cause false diffs.
function stableStringify(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return JSON.stringify(val);
  }
  const sorted = Object.fromEntries(
    Object.entries(val).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(stableStringify(v))])
  );
  return JSON.stringify(sorted, null, 2);
}

const topKeys = new Set([...Object.keys(srcCfg), ...Object.keys(dstCfg)]);
let drifted = false;

for (const key of [...topKeys].sort()) {
  const srcVal = stableStringify(srcCfg[key] ?? null);
  const dstVal = stableStringify(dstCfg[key] ?? null);
  if (srcVal === dstVal) {
    console.log(`  = ${key} (in sync)`);
  } else if (!(key in srcCfg)) {
    console.log(`  ~ ${key}: standalone has value not present in source (DRIFT)`);
    console.log(`      standalone: ${dstVal}`);
    drifted = true;
  } else if (!(key in dstCfg)) {
    console.log(`  ~ ${key}: source has value not present in standalone (DRIFT)`);
    console.log(`      source:     ${srcVal}`);
    drifted = true;
  } else {
    console.log(`  ~ ${key}: VALUES DIFFER (DRIFT)`);
    console.log(`      source:     ${srcVal}`);
    console.log(`      standalone: ${dstVal}`);
    drifted = true;
  }
}

if (drifted) {
  console.log('');
  console.log('  ACTION REQUIRED: tsconfig.json compiler options are out of sync.');
  console.log('  Manually apply the same change to travel-buddy-standalone/tsconfig.json');
  console.log('  (keep the "references" array removed — it is intentionally absent).');
  process.exit(1);
} else {
  console.log('');
  console.log('  (tsconfig.json compiler options are in sync)');
}
NODEEOF
TSCONFIG_DRIFT_EXIT=$?

echo ""
echo "=== babel.config.js structural diff: artifacts/travel-buddy vs travel-buddy-standalone ==="

BABEL_DRIFT_EXIT=0

node - "$SRC/babel.config.js" "$DST/babel.config.js" <<'NODEEOF'
const [,, srcPath, dstPath] = process.argv;

// Minimal babel api mock — only cache() is needed for typical configs.
const mockApi = { cache: () => {}, env: () => false, caller: () => false };

let srcCfg, dstCfg;
try { srcCfg = require(srcPath)(mockApi); }
catch (e) { console.error('  Cannot load source babel.config.js:', e.message); process.exit(1); }
try { dstCfg = require(dstPath)(mockApi); }
catch (e) { console.error('  Cannot load standalone babel.config.js:', e.message); process.exit(1); }

// Normalise a plugin/preset entry → [name, serialisedOptions | null]
// Preserves the exact entry for order-aware comparison.
function normalise(item) {
  if (typeof item === 'string') return [item, null];
  if (Array.isArray(item)) return [String(item[0]), item.length > 1 ? JSON.stringify(item[1]) : null];
  return [String(item), null];
}

let drifted = false;

// ── Array sections (plugins, presets) ──────────────────────────────────────
// Babel plugin/preset order matters for transform execution. Rules:
//   • Entry in source but absent from standalone → DRIFT (fail)
//   • Entry options differ → DRIFT (fail)
//   • Relative order of shared entries differs → DRIFT (fail)
//   • Entry only in standalone → [standalone-only] (noted, no fail — intentional divergence)
//   • Duplicate names in either list → warning (options for extras may not be fully compared)
const ARRAY_SECTIONS = ['presets', 'plugins'];

for (const section of ARRAY_SECTIONS) {
  const srcNorm = (srcCfg[section] || []).map(normalise);
  const dstNorm = (dstCfg[section] || []).map(normalise);

  if (srcNorm.length === 0 && dstNorm.length === 0) {
    console.log(`  = ${section}: [] (in sync)`);
    continue;
  }

  console.log(`  ${section}:`);
  let sectionDrifted = false;

  const srcNames = srcNorm.map(([n]) => n);
  const dstNames = dstNorm.map(([n]) => n);
  const srcSet   = new Set(srcNames);
  const dstSet   = new Set(dstNames);

  // Warn about duplicate names within either list (first occurrence wins for options).
  const srcDups = srcNames.filter((n, i) => srcNames.indexOf(n) !== i);
  const dstDups = dstNames.filter((n, i) => dstNames.indexOf(n) !== i);
  if (srcDups.length > 0)
    console.log(`    ! source has duplicate entries: ${[...new Set(srcDups)].join(', ')} — options for duplicates may not be fully compared`);
  if (dstDups.length > 0)
    console.log(`    ! standalone has duplicate entries: ${[...new Set(dstDups)].join(', ')} — options for duplicates may not be fully compared`);

  // First-occurrence options map for shared entries.
  const srcOptsMap = new Map(srcNorm.map(([n, o]) => [n, o]));
  const dstOptsMap = new Map(dstNorm.map(([n, o]) => [n, o]));

  // ① Source-only entries (DRIFT — missing from standalone).
  for (const [name] of srcNorm) {
    if (!dstSet.has(name)) {
      console.log(`    ~ ${name}: present in source but missing from standalone (DRIFT)`);
      sectionDrifted = true;
    }
  }

  // ② Shared entries — options comparison (in source order).
  for (const [name] of srcNorm) {
    if (!dstSet.has(name)) continue; // already reported above
    const srcOpts = srcOptsMap.get(name);
    const dstOpts = dstOptsMap.get(name);
    if (srcOpts === dstOpts) {
      console.log(`    = ${name} (in sync)`);
    } else {
      console.log(`    ~ ${name}: options differ (DRIFT)`);
      console.log(`        source:     ${srcOpts}`);
      console.log(`        standalone: ${dstOpts}`);
      sectionDrifted = true;
    }
  }

  // ③ Standalone-only entries (noted, no fail).
  for (const [name] of dstNorm) {
    if (!srcSet.has(name)) {
      console.log(`    ~ ${name}: [standalone-only] (preserved — intentional divergence)`);
    }
  }

  // ④ Relative-order check — shared entries must appear in the same order in both lists.
  //    Babel applies presets/plugins in declaration order; reordering can change behaviour.
  const sharedInSrcOrder = srcNames.filter(n => dstSet.has(n));
  const sharedInDstOrder = dstNames.filter(n => srcSet.has(n));
  if (sharedInSrcOrder.join('\0') !== sharedInDstOrder.join('\0')) {
    console.log(`    ! RELATIVE ORDER DIFFERS (DRIFT)`);
    console.log(`        source order:     [${sharedInSrcOrder.join(', ')}]`);
    console.log(`        standalone order: [${sharedInDstOrder.join(', ')}]`);
    sectionDrifted = true;
  }

  if (sectionDrifted) drifted = true;
}

// ── Other top-level keys (env, overrides, etc.) ────────────────────────────
// Any key present in source but absent/different in standalone → DRIFT.
// Keys only in standalone are noted but do not fail.
const handledKeys = new Set(ARRAY_SECTIONS);
const allKeys = new Set([...Object.keys(srcCfg), ...Object.keys(dstCfg)]);
for (const k of handledKeys) allKeys.delete(k);

for (const key of [...allKeys].sort()) {
  const sv = JSON.stringify(srcCfg[key] ?? null, null, 2);
  const dv = JSON.stringify(dstCfg[key] ?? null, null, 2);
  if (sv === dv) {
    console.log(`  = ${key} (in sync)`);
  } else if (!(key in srcCfg)) {
    console.log(`  ~ ${key}: [standalone-only] (preserved — intentional divergence)`);
  } else if (!(key in dstCfg)) {
    console.log(`  ~ ${key}: present in source but missing from standalone (DRIFT)`);
    console.log(`      source: ${sv}`);
    drifted = true;
  } else {
    console.log(`  ~ ${key}: VALUES DIFFER (DRIFT)`);
    console.log(`      source:     ${sv}`);
    console.log(`      standalone: ${dv}`);
    drifted = true;
  }
}

if (drifted) {
  console.log('');
  console.log('  ACTION REQUIRED: babel.config.js plugin/preset configuration has drifted.');
  console.log('  Apply the same change to travel-buddy-standalone/babel.config.js.');
  console.log('  (standalone-only plugins/presets are intentional — do not remove them)');
  process.exit(1);
} else {
  console.log('');
  console.log('  (babel.config.js is in sync)');
}
NODEEOF
BABEL_DRIFT_EXIT=$?

echo ""
echo "=== metro.config.js structural diff: artifacts/travel-buddy vs travel-buddy-standalone ==="

METRO_DRIFT_EXIT=0

node - "$SRC/metro.config.js" "$DST/metro.config.js" <<'NODEEOF'
const fs = require('fs');
const [,, srcPath, dstPath] = process.argv;

let srcText, dstText;
try { srcText = fs.readFileSync(srcPath, 'utf8'); }
catch (e) { console.error('  Cannot read source metro.config.js:', e.message); process.exit(1); }
try { dstText = fs.readFileSync(dstPath, 'utf8'); }
catch (e) { console.error('  Cannot read standalone metro.config.js:', e.message); process.exit(1); }

// Extract top-level config property names referenced in the file.
// Metro configs are written imperatively (config.resolver = ..., config.serializer.X = ...)
// so we extract the first segment of every `config.<key>` reference without evaluating
// the file — which avoids the need for all Expo dependencies to be present.
function extractTopLevelKeys(text) {
  const keys = new Set();
  // Match config.<identifier> — captures only the first segment (top-level key).
  const re = /\bconfig\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

const srcKeys = extractTopLevelKeys(srcText);
const dstKeys = extractTopLevelKeys(dstText);
const allKeys = new Set([...srcKeys, ...dstKeys]);

let drifted = false;

for (const key of [...allKeys].sort()) {
  const inSrc = srcKeys.has(key);
  const inDst = dstKeys.has(key);
  if (inSrc && inDst) {
    console.log(`  = config.${key} (in sync)`);
  } else if (inSrc) {
    console.log(`  ~ config.${key}: present in source but missing from standalone (DRIFT)`);
    drifted = true;
  } else {
    console.log(`  ~ config.${key}: [standalone-only] (noted — intentional divergence)`);
  }
}

if (drifted) {
  console.log('');
  console.log('  ACTION REQUIRED: metro.config.js config sections have drifted.');
  console.log('  Manually apply the missing config section(s) to travel-buddy-standalone/metro.config.js.');
  console.log('  (standalone-only sections are intentional — do not remove them)');
  process.exit(1);
}

// All source keys are present — check whether content is identical.
// Divergence here may be intentional (different __dirname-relative paths, extra
// standalone shims, etc.) so it does not fail CI, but surfaces a diff hint.
if (srcText === dstText) {
  console.log('');
  console.log('  (metro.config.js is identical — fully in sync)');
} else {
  console.log('');
  console.log('  NOTE: metro.config.js top-level keys match but file content differs.');
  console.log('  This may be intentional (standalone-specific shims, paths, etc.).');
  console.log('  Review manually:');
  console.log('    diff artifacts/travel-buddy/metro.config.js travel-buddy-standalone/metro.config.js');
}
NODEEOF
METRO_DRIFT_EXIT=$?

echo ""
echo "=== Dependency diff: artifacts/travel-buddy vs travel-buddy-standalone ==="

DIFF_EXIT=0
manage_package_json_deps "$APPLY_DEPS" "$DRY_RUN" || DIFF_EXIT=$?

echo ""
echo "=== Sync complete ==="
if [[ $TOTAL_PERSPECTIVE_BLOCKED -gt 0 ]]; then
  echo ""
  echo "REFUSED: ${TOTAL_PERSPECTIVE_BLOCKED} perspective-divergent file(s) were NOT overwritten (see messages above)."
  echo "Port those changes manually using the destination tree's perspective"
  echo "(guard: scripts/src/cross-tree-paths.test.ts)."
fi
echo ""
echo "Next steps:"
if [[ $DIFF_EXIT -ne 0 ]]; then
  echo "  1. Dependencies are out of sync. Apply automatically:"
  echo "     bash scripts/sync-standalone.sh --apply-deps"
  echo "     cd travel-buddy-standalone && pnpm install"
else
  echo "  1. Dependencies are in sync — no pnpm install needed."
fi
if [[ $CONFIG_DRIFT_EXIT -ne 0 ]]; then
  echo "  *. Config files are out of sync (app.json or similar — see [dry] output above)."
  echo "     Run without --dry-run to apply: bash scripts/sync-standalone.sh"
fi
if [[ $PRESERVED_DIFF_EXIT -ne 0 ]]; then
  echo "  *. Preserved files are out of sync (see diff above)."
  echo "     Manually update travel-buddy-standalone/ to match artifacts/travel-buddy/."
fi
if [[ $TSCONFIG_DRIFT_EXIT -ne 0 ]]; then
  echo "  *. tsconfig.json compiler options are out of sync (see diff above)."
  echo "     Manually update travel-buddy-standalone/tsconfig.json to match."
  echo "     Keep the 'references' array removed — it is intentionally absent."
fi
if [[ $BABEL_DRIFT_EXIT -ne 0 ]]; then
  echo "  *. babel.config.js plugins/presets are out of sync (see diff above)."
  echo "     Manually update travel-buddy-standalone/babel.config.js to match."
  echo "     (standalone-only plugins/presets are intentional — do not remove them)"
fi
if [[ $METRO_DRIFT_EXIT -ne 0 ]]; then
  echo "  *. metro.config.js config sections are out of sync (see diff above)."
  echo "     Manually apply the missing section(s) to travel-buddy-standalone/metro.config.js."
  echo "     (standalone-only sections are intentional — do not remove them)"
fi
echo "  2. Run typecheck to verify:  cd travel-buddy-standalone && pnpm typecheck"
echo ""

# Exit non-zero if config-file drift, preserved-file drift, tsconfig drift,
# babel drift, metro drift, or dep drift.
FINAL_EXIT=$(( DIFF_EXIT | CONFIG_DRIFT_EXIT | PRESERVED_DIFF_EXIT | TSCONFIG_DRIFT_EXIT | BABEL_DRIFT_EXIT | METRO_DRIFT_EXIT ))
exit $FINAL_EXIT
