#!/usr/bin/env bash
# sync-standalone.sh — copy source changes from the monorepo Expo app to the standalone EAS build target.
#
# Usage (from the workspace root):
#   bash scripts/sync-standalone.sh [--dry-run]
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
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
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
    elif ! diff -q "$from" "$to" &>/dev/null; then
      echo "    [dry] ~ $name (changed)"
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
# 3. Dependency diff — compare package.json dep sections between source and target
# ---------------------------------------------------------------------------
diff_package_json_deps() {
  node - "$SRC/package.json" "$DST/package.json" <<'EOF'
const fs = require('fs');

const [,, srcPath, dstPath] = process.argv;

let srcPkg, dstPkg;
try { srcPkg = JSON.parse(fs.readFileSync(srcPath, 'utf8')); }
catch (e) { console.error('Cannot read source package.json:', e.message); process.exit(1); }
try { dstPkg = JSON.parse(fs.readFileSync(dstPath, 'utf8')); }
catch (e) { console.error('Cannot read standalone package.json:', e.message); process.exit(1); }

const sections = ['dependencies', 'devDependencies'];
let totalDiffs = 0;

for (const section of sections) {
  const src = srcPkg[section] || {};
  const dst = dstPkg[section] || {};
  const allKeys = new Set([...Object.keys(src), ...Object.keys(dst)]);

  const added   = [];   // in monorepo, missing from standalone
  const removed = [];   // in standalone, missing from monorepo
  const changed = [];   // version differs

  for (const pkg of [...allKeys].sort()) {
    if (src[pkg] !== undefined && dst[pkg] === undefined) {
      added.push(`  + ${pkg}: ${src[pkg]}`);
    } else if (src[pkg] === undefined && dst[pkg] !== undefined) {
      removed.push(`  - ${pkg}: ${dst[pkg]}`);
    } else if (src[pkg] !== dst[pkg]) {
      changed.push(`  ~ ${pkg}: ${dst[pkg]} → ${src[pkg]}`);
    }
  }

  const sectionDiffs = added.length + removed.length + changed.length;
  totalDiffs += sectionDiffs;

  if (sectionDiffs > 0) {
    console.log(`\n[${section}]`);
    if (added.length)   { console.log(' MISSING from standalone (add these):');   added.forEach(l => console.log(l)); }
    if (removed.length) { console.log(' EXTRA in standalone (not in monorepo):'); removed.forEach(l => console.log(l)); }
    if (changed.length) { console.log(' VERSION MISMATCH:');                       changed.forEach(l => console.log(l)); }
  }
}

if (totalDiffs === 0) {
  console.log('  (no dependency differences — standalone is in sync)');
} else {
  console.log(`\n  ACTION REQUIRED: mirror the changes above into travel-buddy-standalone/package.json`);
  console.log(`  then run: cd travel-buddy-standalone && pnpm install`);
  process.exitCode = 1;
}
EOF
}

echo ""
echo "=== Dependency diff: artifacts/travel-buddy vs travel-buddy-standalone ==="
DIFF_EXIT=0
diff_package_json_deps || DIFF_EXIT=$?
echo ""
echo "=== Sync complete ==="
echo ""
echo "Next steps:"
echo "  1. If there are dependency differences above, mirror them into"
echo "     travel-buddy-standalone/package.json, then run:"
echo "     cd travel-buddy-standalone && pnpm install"
echo "  2. If tsconfig.json changed in the monorepo app, apply the same change to"
echo "     travel-buddy-standalone/tsconfig.json (keep the 'references' array removed)."
echo "  3. Run typecheck to verify:  cd travel-buddy-standalone && pnpm typecheck"
echo ""

# Exit with the dependency diff code so CI can detect drift without
# aborting the rest of this script prematurely (the || above captures it).
exit $DIFF_EXIT
