#!/usr/bin/env bash
# sync-standalone.sh — copy source changes from the monorepo Expo app to the standalone EAS build target.
#
# Usage (from the workspace root):
#   bash scripts/sync-standalone.sh [--dry-run] [--apply-deps]
#
# Flags:
#   --dry-run      Show what would change without writing any files.
#   --apply-deps   Auto-patch travel-buddy-standalone/package.json with dependency
#                  changes from the monorepo app (added packages + version updates).
#                  Standalone-only packages are never removed. Prints a summary then
#                  reminds you to run `pnpm install` inside the standalone.
#                  --dry-run takes precedence: if both flags are set, nothing is written.
#
# What it syncs:
#   Directories: app/ src/ assets/ components/ constants/ hooks/ docs/ migrations/ scripts/ server/
#   Config files: babel.config.js  metro.config.js  app.json  eas.json  expo-env.d.ts
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

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --apply-deps) APPLY_DEPS=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

if $DRY_RUN; then
  echo "=== DRY RUN — no files will be written ==="
fi

echo ""
echo "Source : $SRC"
echo "Target : $DST"
echo ""

# ---------------------------------------------------------------------------
# Helper: sync a directory using cp -a + remove stale files
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
    # Remove the destination dir and replace it cleanly (preserves no stale files)
    rm -rf "$to"
    cp -a "$from" "$to"
    echo "    synced"
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
CONFIG_FILES=(babel.config.js metro.config.js app.json eas.json expo-env.d.ts)

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
echo "  2. If tsconfig.json changed in the monorepo app, apply the same change to"
echo "     travel-buddy-standalone/tsconfig.json (keep the 'references' array removed)."
echo "  3. Run typecheck to verify:  cd travel-buddy-standalone && pnpm typecheck"
echo ""

# Exit non-zero if config-file drift, preserved-file drift, or dep drift was detected.
FINAL_EXIT=$(( DIFF_EXIT | CONFIG_DRIFT_EXIT | PRESERVED_DIFF_EXIT ))
exit $FINAL_EXIT
