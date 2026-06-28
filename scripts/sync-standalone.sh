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
# 3. Reminders
# ---------------------------------------------------------------------------
echo ""
echo "=== Sync complete ==="
echo ""
echo "Next steps:"
echo "  1. Review any new dependencies added to artifacts/travel-buddy/package.json"
echo "     and mirror them into travel-buddy-standalone/package.json by hand."
echo "     Then run:  cd travel-buddy-standalone && pnpm install"
echo "  2. If tsconfig.json changed in the monorepo app, apply the same change to"
echo "     travel-buddy-standalone/tsconfig.json (keep the 'references' array removed)."
echo "  3. Run typecheck to verify:  cd travel-buddy-standalone && pnpm typecheck"
echo ""
