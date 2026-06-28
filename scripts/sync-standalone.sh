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
const verb = shouldApply ? 'Applied' : (isDryRun ? '[dry] would apply' : 'Found');
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
echo "  2. If tsconfig.json changed in the monorepo app, apply the same change to"
echo "     travel-buddy-standalone/tsconfig.json (keep the 'references' array removed)."
echo "  3. Run typecheck to verify:  cd travel-buddy-standalone && pnpm typecheck"
echo ""

# Print the GitHub Actions CI job snippet for wiring into CI.
cat <<'GHAEOF'
--- GitHub Actions: standalone typecheck gate ---
  typecheck-standalone:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '10' }
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: 'pnpm', cache-dependency-path: 'travel-buddy-standalone/pnpm-lock.yaml' }
      - run: cd travel-buddy-standalone && pnpm install --frozen-lockfile
      - run: cd travel-buddy-standalone && pnpm typecheck
GHAEOF
echo ""

# Exit with the dependency diff code so CI can detect drift.
exit $DIFF_EXIT
