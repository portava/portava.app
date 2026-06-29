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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/artifacts/travel-buddy"
DST="$REPO_ROOT/travel-buddy-standalone"

DRY_RUN=false
APPLY_DEPS=false
CHECK_SOURCE=false
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
    --dry-run)       DRY_RUN=true ;;
    --apply-deps)    APPLY_DEPS=true ;;
    --check-source)  CHECK_SOURCE=true ;;
    --fix-source)    FIX_SOURCE=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper: sync a directory using cp -a + remove stale files
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
        src_file="$from/$rel"
        if [[ ! -f "$src_file" ]]; then
          echo "    [dry] - $name/$rel (removed from source)"
        fi
      done < <(find "$to" -type f -not -path "*/node_modules/*" -print0)
    fi
  else
    # Count what will change before syncing so we can print a meaningful summary
    local added=0 updated=0 removed=0

    while IFS= read -r -d '' f; do
      rel="${f#$from/}"
      dst_file="$to/$rel"
      if [[ ! -f "$dst_file" ]]; then
        added=$(( added + 1 ))
      elif ! diff -q "$f" "$dst_file" &>/dev/null; then
        updated=$(( updated + 1 ))
      fi
    done < <(find "$from" -type f -not -path "*/node_modules/*" -print0)

    if [[ -d "$to" ]]; then
      while IFS= read -r -d '' f; do
        rel="${f#$to/}"
        src_file="$from/$rel"
        if [[ ! -f "$src_file" ]]; then
          removed=$(( removed + 1 ))
        fi
      done < <(find "$to" -type f -not -path "*/node_modules/*" -print0)
    fi

    # Remove the destination dir and replace it cleanly (preserves no stale files)
    rm -rf "$to"
    cp -a "$from" "$to"
    echo "    ${added} added, ${updated} updated, ${removed} removed"

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
      if [[ ! -f "$dst_file" ]]; then
        echo "    + $dir/$rel (new in source — missing from standalone)"
        dir_drift=$(( dir_drift + 1 ))
      elif ! diff -q "$f" "$dst_file" &>/dev/null; then
        echo "    ~ $dir/$rel (modified — standalone is out of date)"
        dir_drift=$(( dir_drift + 1 ))
      fi
    done < <(find "$from" -type f -not -path "*/node_modules/*" -print0 | sort -z)

    # Files in standalone that no longer exist in source
    while IFS= read -r -d '' f; do
      rel="${f#$to/}"
      src_file="$from/$rel"
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
  echo "  Threshold:           $SOURCE_DRIFT_THRESHOLD"
  echo ""

  if [[ $SOURCE_DRIFT_COUNT -gt $SOURCE_DRIFT_THRESHOLD ]]; then
    echo "FAIL: Source drift ($SOURCE_DRIFT_COUNT file(s)) exceeds threshold ($SOURCE_DRIFT_THRESHOLD)."
    echo ""
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
