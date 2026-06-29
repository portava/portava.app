#!/usr/bin/env bash
# test-sync-standalone.sh — regression harness for sync-standalone.sh
#
# Creates throwaway temp workspaces (fake source/dest dirs) for each test,
# then asserts the expected output and file state.
#
# Usage (from the workspace root):
#   bash scripts/test-sync-standalone.sh
#
# Exit code: 0 all tests passed, 1 one or more tests failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-standalone.sh"

PASS=0
FAIL=0
ERRORS=()

# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------
pass() { PASS=$(( PASS + 1 )); echo "  PASS: $1"; }
fail() { FAIL=$(( FAIL + 1 )); ERRORS+=("$1"); echo "  FAIL: $1"; }

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    pass "$desc (exit=$actual)"
  else
    fail "$desc — expected exit $expected, got $actual"
  fi
}

assert_contains() {
  local desc="$1" pattern="$2" output="$3"
  if printf '%s' "$output" | grep -qF "$pattern"; then
    pass "$desc"
  else
    fail "$desc — pattern not found: '$pattern'"
  fi
}

assert_not_contains() {
  local desc="$1" pattern="$2" output="$3"
  if ! printf '%s' "$output" | grep -qF "$pattern"; then
    pass "$desc"
  else
    fail "$desc — unexpected pattern found: '$pattern'"
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$desc"
  else
    fail "$desc — file not found: $path"
  fi
}

assert_file_missing() {
  local desc="$1" path="$2"
  if [[ ! -f "$path" ]]; then
    pass "$desc"
  else
    fail "$desc — file should not exist: $path"
  fi
}

assert_file_content() {
  local desc="$1" path="$2" expected_content="$3"
  if [[ -f "$path" ]] && grep -qF "$expected_content" "$path"; then
    pass "$desc"
  else
    fail "$desc — '$path' does not contain '$expected_content'"
  fi
}

assert_file_not_content() {
  local desc="$1" path="$2" unexpected_content="$3"
  if [[ ! -f "$path" ]] || ! grep -qF "$unexpected_content" "$path"; then
    pass "$desc"
  else
    fail "$desc — '$path' should not contain '$unexpected_content'"
  fi
}

# ---------------------------------------------------------------------------
# Workspace fixture helpers
# ---------------------------------------------------------------------------

# Create a fresh temp dir that mirrors the monorepo layout:
#   <root>/artifacts/travel-buddy/   — source (monorepo app)
#   <root>/travel-buddy-standalone/  — destination (standalone)
make_workspace() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/artifacts/travel-buddy"
  mkdir -p "$dir/travel-buddy-standalone"
  echo "$dir"
}

# Minimal package.json for source/standalone (deps identical by default)
write_pkg() {
  local path="$1"
  cat > "$path" <<'EOF'
{
  "name": "travel-buddy",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.0.0",
    "react": "18.3.2"
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
EOF
}

write_tsconfig() {
  local path="$1"
  cat > "$path" <<'EOF'
{
  "compilerOptions": {
    "target": "ESNext",
    "strict": true
  }
}
EOF
}

# babel.config.js must be require()-able; returning a plain object is enough.
# The script calls: require(path)(mockApi) — mockApi.cache() is a no-op.
write_babel() {
  local path="$1"
  cat > "$path" <<'EOF'
module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo']
  };
};
EOF
}

# metro.config.js is parsed via regex (not executed) so any text works.
write_metro() {
  local path="$1"
  cat > "$path" <<'EOF'
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver = {};
module.exports = config;
EOF
}

write_env_example() {
  local path="$1"
  echo "EXPO_PUBLIC_API_BASE_URL=" > "$path"
}

write_app_json() {
  local path="$1"
  echo '{"expo":{"name":"TravelBuddy","slug":"travel-buddy"}}' > "$path"
}

# Create a fully wired-up workspace (all config files identical on both sides).
# Individual tests override whatever they need after calling this.
setup_workspace() {
  local dir
  dir="$(make_workspace)"
  local src="$dir/artifacts/travel-buddy"
  local dst="$dir/travel-buddy-standalone"

  write_pkg        "$src/package.json"
  write_pkg        "$dst/package.json"
  write_tsconfig   "$src/tsconfig.json"
  write_tsconfig   "$dst/tsconfig.json"
  write_babel      "$src/babel.config.js"
  write_babel      "$dst/babel.config.js"
  write_metro      "$src/metro.config.js"
  write_metro      "$dst/metro.config.js"
  write_env_example "$src/.env.example"
  write_env_example "$dst/.env.example"
  write_app_json   "$src/app.json"

  echo "$dir"
}

# Run the sync script against a temp workspace. Captured output is printed to
# stdout; the caller captures it if needed. Exit code stored in caller variable.
run_sync() {
  local root="$1"
  shift
  SYNC_STANDALONE_REPO_ROOT="$root" bash "$SYNC_SCRIPT" "$@"
}

# ---------------------------------------------------------------------------
# Test 1: --dry-run reports new/changed/removed without writing any files
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 1: --dry-run reports changes without writing any files ==="

T1="$(setup_workspace)"
src1="$T1/artifacts/travel-buddy"
dst1="$T1/travel-buddy-standalone"

mkdir -p "$src1/app" "$dst1/app"
echo "v1" > "$dst1/app/index.ts"
echo "v2" > "$src1/app/index.ts"      # changed
echo "new" > "$src1/app/new-file.ts"  # new in source
echo "stale" > "$dst1/app/stale.ts"   # only in dst → would be removed

out1="$(run_sync "$T1" --dry-run 2>&1)" || true

assert_contains     "1a: changed file reported in dry-run"  "[dry] ~ app/index.ts (changed)"            "$out1"
assert_contains     "1b: new file reported in dry-run"      "[dry] + app/new-file.ts (new)"             "$out1"
assert_contains     "1c: stale file reported in dry-run"    "[dry] - app/stale.ts (removed from source)" "$out1"
assert_contains     "1d: DRY RUN header shown"              "DRY RUN"                                    "$out1"
assert_file_content "1e: dst index.ts not overwritten"      "$dst1/app/index.ts"  "v1"
assert_file_missing "1f: new-file.ts not created"           "$dst1/app/new-file.ts"
assert_file_exists  "1g: stale.ts not deleted"              "$dst1/app/stale.ts"

rm -rf "$T1"

# ---------------------------------------------------------------------------
# Test 2: apply path syncs correctly — new/updated/removed handled
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 2: apply path copies files and cleans up stale ones ==="

T2="$(setup_workspace)"
src2="$T2/artifacts/travel-buddy"
dst2="$T2/travel-buddy-standalone"

mkdir -p "$src2/app" "$dst2/app"
echo "new-content" > "$src2/app/new-file.ts"
echo "v2"          > "$src2/app/updated.ts"
echo "v1"          > "$dst2/app/updated.ts"
echo "stale"       > "$dst2/app/stale.ts"

run_sync "$T2" 2>&1 >/dev/null || true

assert_file_exists    "2a: new file created"           "$dst2/app/new-file.ts"
assert_file_content   "2b: updated file has new content" "$dst2/app/updated.ts" "v2"
assert_file_missing   "2c: stale file removed"         "$dst2/app/stale.ts"

rm -rf "$T2"

# ---------------------------------------------------------------------------
# Test 3: counts — 1 added, 1 updated, 1 removed reported correctly
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 3: per-directory counts are accurate ==="

T3="$(setup_workspace)"
src3="$T3/artifacts/travel-buddy"
dst3="$T3/travel-buddy-standalone"

mkdir -p "$src3/app" "$dst3/app"
echo "new"   > "$src3/app/new-file.ts"
echo "v2"    > "$src3/app/updated.ts"
echo "v1"    > "$dst3/app/updated.ts"
echo "stale" > "$dst3/app/stale.ts"

out3="$(run_sync "$T3" 2>&1)" || true

assert_contains "3a: 1 added reported"   "1 added"   "$out3"
assert_contains "3b: 1 updated reported" "1 updated" "$out3"
assert_contains "3c: 1 removed reported" "1 removed" "$out3"

rm -rf "$T3"

# ---------------------------------------------------------------------------
# Test 4: total counts (printed by --fix-source) match sum of per-dir counts
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 4: --fix-source Total line equals sum of per-directory counts ==="

T4="$(setup_workspace)"
src4="$T4/artifacts/travel-buddy"
dst4="$T4/travel-buddy-standalone"

# app/: 1 new file
mkdir -p "$src4/app"
echo "new" > "$src4/app/only-in-src.ts"

# src/: 1 new + 1 updated
mkdir -p "$src4/src" "$dst4/src"
echo "new-svc" > "$src4/src/new-svc.ts"
echo "v2"      > "$src4/src/existing.ts"
echo "v1"      > "$dst4/src/existing.ts"

# Use --fix-source which prints "Total: N added, M updated, K removed"
out4="$(SOURCE_DRIFT_DIRS="src app" run_sync "$T4" --fix-source 2>&1)" || true

# app/: 1 added, src/: 1 added + 1 updated → Total: 2 added, 1 updated, 0 removed
assert_contains "4a: Total: 2 added in fix-source summary"   "2 added"   "$out4"
assert_contains "4b: Total: 1 updated in fix-source summary" "1 updated" "$out4"
assert_contains "4c: Total: 0 removed in fix-source summary" "0 removed" "$out4"
assert_contains "4d: fix-source complete shown"              "Fix-source complete" "$out4"

rm -rf "$T4"

# ---------------------------------------------------------------------------
# Test 5: --check-source exits 1 when drift is detected
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 5: --check-source exits non-zero when drift detected ==="

T5="$(setup_workspace)"
src5="$T5/artifacts/travel-buddy"
dst5="$T5/travel-buddy-standalone"

mkdir -p "$src5/src" "$dst5/src"
echo "v2" > "$src5/src/service.ts"
echo "v1" > "$dst5/src/service.ts"

ec5=0
out5="$(SOURCE_DRIFT_DIRS="src" run_sync "$T5" --check-source 2>&1)" || ec5=$?

assert_exit     "5a: exits 1 on drift"          1 "$ec5"
assert_contains "5b: FAIL shown"                "FAIL:" "$out5"
assert_contains "5c: drift count shown"         "Total drifted files:" "$out5"
assert_contains "5d: modified file reported"    "~ src/service.ts" "$out5"

rm -rf "$T5"

# ---------------------------------------------------------------------------
# Test 6: --check-source exits 0 when directories are in sync
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 6: --check-source exits 0 when in sync ==="

T6="$(setup_workspace)"
src6="$T6/artifacts/travel-buddy"
dst6="$T6/travel-buddy-standalone"

mkdir -p "$src6/src" "$dst6/src"
echo "same" > "$src6/src/service.ts"
echo "same" > "$dst6/src/service.ts"

ec6=0
out6="$(SOURCE_DRIFT_DIRS="src" run_sync "$T6" --check-source 2>&1)" || ec6=$?

assert_exit     "6a: exits 0 when in sync"  0 "$ec6"
assert_contains "6b: PASS shown"            "PASS:" "$out6"

rm -rf "$T6"

# ---------------------------------------------------------------------------
# Test 7: --check-source respects SOURCE_DRIFT_THRESHOLD
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 7: --check-source respects SOURCE_DRIFT_THRESHOLD ==="

T7="$(setup_workspace)"
src7="$T7/artifacts/travel-buddy"
dst7="$T7/travel-buddy-standalone"

mkdir -p "$src7/src" "$dst7/src"
echo "v2" > "$src7/src/a.ts"  ; echo "v1" > "$dst7/src/a.ts"  # 1 modified
echo "v2" > "$src7/src/b.ts"                                   # 1 new in src (missing from dst)
# Total drift = 2

ec7a=0
out7a="$(SOURCE_DRIFT_DIRS="src" SOURCE_DRIFT_THRESHOLD=2 run_sync "$T7" --check-source 2>&1)" || ec7a=$?
assert_exit "7a: exits 0 when drift == threshold (2)"  0 "$ec7a"

ec7b=0
out7b="$(SOURCE_DRIFT_DIRS="src" SOURCE_DRIFT_THRESHOLD=1 run_sync "$T7" --check-source 2>&1)" || ec7b=$?
assert_exit "7b: exits 1 when drift > threshold (2 > 1)" 1 "$ec7b"

ec7c=0
out7c="$(SOURCE_DRIFT_DIRS="src" SOURCE_DRIFT_THRESHOLD=0 run_sync "$T7" --check-source 2>&1)" || ec7c=$?
assert_exit "7c: exits 1 with default threshold 0 (any drift fails)" 1 "$ec7c"

rm -rf "$T7"

# ---------------------------------------------------------------------------
# Test 8: --fix-source syncs source dirs and never touches package.json
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 8: --fix-source syncs source dirs, preserves package.json ==="

T8="$(setup_workspace)"
src8="$T8/artifacts/travel-buddy"
dst8="$T8/travel-buddy-standalone"

mkdir -p "$src8/src" "$dst8/src"
echo "v2"            > "$src8/src/service.ts"
echo "v1"            > "$dst8/src/service.ts"

# Give standalone a distinctive package.json that --fix-source must not overwrite
cat > "$dst8/package.json" <<'EOF'
{"name":"standalone-only","version":"99.0.0"}
EOF

ec8=0
out8="$(SOURCE_DRIFT_DIRS="src" run_sync "$T8" --fix-source 2>&1)" || ec8=$?

assert_exit         "8a: exits 0"                       0  "$ec8"
assert_file_content "8b: src/service.ts updated to v2"  "$dst8/src/service.ts" "v2"
assert_file_content "8c: package.json preserved"        "$dst8/package.json"   "standalone-only"
assert_contains     "8d: fix-source complete shown"     "Fix-source complete"   "$out8"

rm -rf "$T8"

# ---------------------------------------------------------------------------
# Test 9: --fix-source --dry-run shows changes without writing
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 9: --fix-source --dry-run shows changes without writing ==="

T9="$(setup_workspace)"
src9="$T9/artifacts/travel-buddy"
dst9="$T9/travel-buddy-standalone"

mkdir -p "$src9/src" "$dst9/src"
echo "v2" > "$src9/src/service.ts"
echo "v1" > "$dst9/src/service.ts"
echo "brand-new" > "$src9/src/new.ts"

ec9=0
out9="$(SOURCE_DRIFT_DIRS="src" run_sync "$T9" --fix-source --dry-run 2>&1)" || ec9=$?

assert_exit         "9a: exits 0"                                0   "$ec9"
assert_contains     "9b: DRY RUN header shown"                   "DRY RUN"                        "$out9"
assert_contains     "9c: changed file reported"                  "[dry] ~ src/service.ts (changed)" "$out9"
assert_contains     "9d: new file reported"                      "[dry] + src/new.ts (new)"         "$out9"
assert_file_content "9e: service.ts not overwritten"             "$dst9/src/service.ts" "v1"
assert_file_missing "9f: new.ts not created"                     "$dst9/src/new.ts"

rm -rf "$T9"

# ---------------------------------------------------------------------------
# Test 10: no-op apply (files identical) reports 0 added/updated/removed
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 10: no-op apply reports 0 counts ==="

T10="$(setup_workspace)"
src10="$T10/artifacts/travel-buddy"
dst10="$T10/travel-buddy-standalone"

mkdir -p "$src10/src" "$dst10/src"
echo "same" > "$src10/src/service.ts"
echo "same" > "$dst10/src/service.ts"

out10="$(run_sync "$T10" 2>&1)" || true

assert_contains "10a: 0 added"   "0 added"   "$out10"
assert_contains "10b: 0 updated" "0 updated" "$out10"
assert_contains "10c: 0 removed" "0 removed" "$out10"

rm -rf "$T10"

# ---------------------------------------------------------------------------
# Test 11: source dir absent from standalone -- check-source counts all files
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 11: --check-source counts all files when standalone dir is missing ==="

T11="$(setup_workspace)"
src11="$T11/artifacts/travel-buddy"

# Destination src/ dir intentionally not created
mkdir -p "$src11/src"
echo "v1" > "$src11/src/a.ts"
echo "v1" > "$src11/src/b.ts"
# 2 files in source, dst/src/ missing entirely → drift = 2

ec11=0
out11="$(SOURCE_DRIFT_DIRS="src" run_sync "$T11" --check-source 2>&1)" || ec11=$?

assert_exit     "11a: exits 1 when dst dir missing"     1 "$ec11"
assert_contains "11b: DRIFT shown for missing dir"      "DRIFT:" "$out11"
assert_contains "11c: file count mentioned"             "2 file(s)" "$out11"

rm -rf "$T11"

# ---------------------------------------------------------------------------
# Test 12: unknown flag causes exit 1 with a helpful message
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 12: unknown flag exits 1 with an error message ==="

T12="$(setup_workspace)"

ec12=0
out12="$(run_sync "$T12" --unknown-flag 2>&1)" || ec12=$?

assert_exit     "12a: exits 1 on unknown flag"     1  "$ec12"
assert_contains "12b: error message shown"         "Unknown flag: --unknown-flag" "$out12"

rm -rf "$T12"

# ---------------------------------------------------------------------------
# Test 13: --check-deps exits 1 when a dep is missing from standalone
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 13: --check-deps exits 1 when a dep is missing from standalone ==="

T13="$(setup_workspace)"
src13="$T13/artifacts/travel-buddy"
dst13="$T13/travel-buddy-standalone"

# Add a new package to source that standalone does not have
cat > "$src13/package.json" <<'EOF'
{
  "name": "travel-buddy",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.0.0",
    "react": "18.3.2",
    "react-native-maps": "1.14.0"
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
EOF

ec13=0
out13="$(run_sync "$T13" --check-deps 2>&1)" || ec13=$?

assert_exit     "13a: exits 1 when dep is missing from standalone"  1  "$ec13"
assert_contains "13b: FAIL shown"                                   "FAIL:" "$out13"
assert_contains "13c: missing package reported"                     "react-native-maps" "$out13"

rm -rf "$T13"

# ---------------------------------------------------------------------------
# Test 14: --check-deps exits 1 when a dep version differs
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 14: --check-deps exits 1 when a dep version differs ==="

T14="$(setup_workspace)"
src14="$T14/artifacts/travel-buddy"
dst14="$T14/travel-buddy-standalone"

# Source has a newer expo; standalone is on an older one
cat > "$src14/package.json" <<'EOF'
{
  "name": "travel-buddy",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.1.0",
    "react": "18.3.2"
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
EOF

# Standalone stays at ~54.0.0 (written by write_pkg via setup_workspace)

ec14=0
out14="$(run_sync "$T14" --check-deps 2>&1)" || ec14=$?

assert_exit     "14a: exits 1 on version mismatch"   1  "$ec14"
assert_contains "14b: FAIL shown"                    "FAIL:" "$out14"
assert_contains "14c: expo version drift reported"   "expo" "$out14"
assert_contains "14d: old version shown"             "~54.0.0" "$out14"
assert_contains "14e: new version shown"             "~54.1.0" "$out14"

rm -rf "$T14"

# ---------------------------------------------------------------------------
# Test 15: --check-deps exits 0 when deps are identical
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 15: --check-deps exits 0 when deps are identical ==="

T15="$(setup_workspace)"
# setup_workspace writes the same package.json to both src and dst via write_pkg

ec15=0
out15="$(run_sync "$T15" --check-deps 2>&1)" || ec15=$?

assert_exit     "15a: exits 0 when deps are in sync"  0  "$ec15"
assert_contains "15b: PASS shown"                     "PASS:" "$out15"

rm -rf "$T15"

# ---------------------------------------------------------------------------
# Test 16: --apply-deps writes new and updated packages into standalone package.json
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 16: --apply-deps writes updated deps into standalone package.json ==="

T16="$(setup_workspace)"
src16="$T16/artifacts/travel-buddy"
dst16="$T16/travel-buddy-standalone"

# Source: bump react version + add a new dep
cat > "$src16/package.json" <<'EOF'
{
  "name": "travel-buddy",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.0.0",
    "react": "18.3.5",
    "react-native-maps": "1.14.0"
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
EOF

# Standalone keeps a package that the source no longer has (standalone-only — must be preserved)
cat > "$dst16/package.json" <<'EOF'
{
  "name": "travel-buddy-standalone",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.0.0",
    "react": "18.3.2",
    "standalone-only-pkg": "1.0.0"
  },
  "devDependencies": {
    "typescript": "~5.9.0"
  }
}
EOF

ec16=0
out16="$(run_sync "$T16" --apply-deps 2>&1)" || ec16=$?

assert_exit             "16a: exits 0 after apply"                        0   "$ec16"
assert_file_content     "16b: new dep written to standalone package.json" "$dst16/package.json" "react-native-maps"
assert_file_content     "16c: bumped version written"                     "$dst16/package.json" "18.3.5"
assert_file_content     "16d: standalone-only pkg preserved"              "$dst16/package.json" "standalone-only-pkg"
assert_file_content     "16e: standalone name preserved"                  "$dst16/package.json" "travel-buddy-standalone"
assert_not_contains     "16f: no FAIL in output"                          "FAIL:" "$out16"

rm -rf "$T16"

# ---------------------------------------------------------------------------
# Test 17: --apply-deps --dry-run shows diff without writing
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 17: --apply-deps --dry-run shows diff without writing ==="

T17="$(setup_workspace)"
src17="$T17/artifacts/travel-buddy"
dst17="$T17/travel-buddy-standalone"

# Source: bump typescript devDep + add a new dep
cat > "$src17/package.json" <<'EOF'
{
  "name": "travel-buddy",
  "version": "1.0.0",
  "dependencies": {
    "expo": "~54.0.0",
    "react": "18.3.2",
    "new-pkg": "2.0.0"
  },
  "devDependencies": {
    "typescript": "~5.9.1"
  }
}
EOF

# Capture the standalone package.json before the run so we can compare after
dst17_before="$(cat "$dst17/package.json")"

ec17=0
out17="$(run_sync "$T17" --apply-deps --dry-run 2>&1)" || ec17=$?

assert_exit         "17a: exits 1 in dry-run mode (action still required)"  1   "$ec17"
assert_contains     "17b: dry-run flag shown in output"           "dry" "$out17"
assert_contains     "17c: new dep reported"                       "new-pkg" "$out17"
assert_contains     "17d: typescript version drift reported"      "typescript" "$out17"

# Verify the file was NOT modified
dst17_after="$(cat "$dst17/package.json")"
if [[ "$dst17_before" == "$dst17_after" ]]; then
  pass "17e: standalone package.json not written in dry-run"
else
  fail "17e: standalone package.json was modified during dry-run"
fi

rm -rf "$T17"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  echo ""
  exit 1
fi

echo ""
exit 0
