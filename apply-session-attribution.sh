#!/usr/bin/env bash
#
# apply-session-attribution.sh
#
# Applies the feed-session attribution change. Run from the REPO ROOT
# (~/workspace), after unzipping session-attribution.zip there.
#
# Three of the five files REPLACE existing ones, so this script refuses to run
# unless each target still matches the state the edits were built against
# (5b7c7fa87). If a file has drifted — because another agent edited it, or the
# patch was already applied — it stops and tells you which, rather than
# clobbering someone else's work.
#
# Nothing is overwritten before every check passes, and originals are backed up.

set -uo pipefail

ROOT="$(pwd)"
SB="$ROOT/travel-buddy-standalone"
STAGE="$ROOT/_session-attribution"
BACKUP="$ROOT/.session-attribution-backup"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }

fail() { red "✗ $*"; exit 1; }

echo "──────────────────────────────────────────────"
echo "  session attribution — preflight"
echo "──────────────────────────────────────────────"

# ── 0. Are we in the right place? ────────────────────────────────────────────
[ -d "$SB" ] || fail "No travel-buddy-standalone/ here. Run this from the repo root (~/workspace)."
[ -d "$STAGE/travel-buddy-standalone" ] || fail "No _session-attribution/ here. Unzip session-attribution.zip at the repo root first."

# ── 1. Targets must be at the expected pre-state ─────────────────────────────
# Each entry: file | sentinel that must exist BEFORE applying | sentinel that
# means it is ALREADY applied.
check() {
  local path="$1" pre="$2" post="$3" label="$4"
  if [ ! -f "$path" ]; then fail "missing: $path"; fi
  if grep -qF -- "$post" "$path"; then
    ylw "  • $label — already applied, will skip"
    return 1
  fi
  if ! grep -qF -- "$pre" "$path"; then
    red "  ✗ $label — DRIFTED"
    red "    Expected to find: $pre"
    red "    That line is gone, so this file changed since the patch was built."
    red "    Not overwriting it. Reconcile by hand, or ask for a rebuilt patch."
    return 2
  fi
  grn "  ✓ $label — matches expected pre-state"
  return 0
}

DRIFT=0
SKIP_INDEX=0; SKIP_EXPLORE=0; SKIP_EVENT=0

check "$SB/app/(tabs)/index.tsx" \
  'const { buckets, events, status } = useCityPulse(' \
  'sessionId: cityPulseSessionId' \
  "app/(tabs)/index.tsx"
case $? in 1) SKIP_INDEX=1 ;; 2) DRIFT=1 ;; esac

check "$SB/src/components/ExploreTodaySection.tsx" \
  'function NowChip({ ev }: { ev: CityEvent }) {' \
  'feedAttribution' \
  "src/components/ExploreTodaySection.tsx"
case $? in 1) SKIP_EXPLORE=1 ;; 2) DRIFT=1 ;; esac

check "$SB/app/event/[id].tsx" \
  'const { id, tripId: tripIdParam } = useLocalSearchParams<{ id: string; tripId?: string }>();' \
  'readFeedSession' \
  "app/event/[id].tsx"
case $? in 1) SKIP_EVENT=1 ;; 2) DRIFT=1 ;; esac

if [ "$DRIFT" -ne 0 ]; then
  echo
  fail "One or more targets drifted. Nothing was written."
fi

# ── 2. Back up, then apply ───────────────────────────────────────────────────
echo
echo "── applying ──"
mkdir -p "$BACKUP"

copy() { # src rel-path
  local rel="$1"
  local src="$STAGE/travel-buddy-standalone/$rel"
  local dst="$SB/$rel"
  [ -f "$src" ] || fail "staged file missing: $rel"
  if [ -f "$dst" ]; then
    mkdir -p "$(dirname "$BACKUP/$rel")"
    cp "$dst" "$BACKUP/$rel"
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  grn "  wrote $rel"
}

# new files — always safe
copy "src/lib/feedAttribution.ts"
copy "src/lib/feedAttribution.test.ts"

# replacements — skip any already applied
[ "$SKIP_EXPLORE" -eq 1 ] || copy "src/components/ExploreTodaySection.tsx"
[ "$SKIP_INDEX"   -eq 1 ] || copy "app/(tabs)/index.tsx"
[ "$SKIP_EVENT"   -eq 1 ] || copy "app/event/[id].tsx"

echo "  originals backed up to .session-attribution-backup/"

# ── 3. Verify ────────────────────────────────────────────────────────────────
echo
echo "── verifying ──"
cd "$SB" || fail "cannot cd to $SB"

if ! command -v pnpm >/dev/null 2>&1; then
  ylw "  pnpm not found — SKIPPING verification (files are applied)."
  ylw "  Tooling is missing, which is NOT the same as a failing check."
  ylw "  Run these yourself:"
  ylw "    cd travel-buddy-standalone && node --import tsx/esm --test src/lib/feedAttribution.test.ts"
  ylw "    cd travel-buddy-standalone && pnpm run typecheck"
else
  echo "→ node test (expect 13 pass)"
  if node --import tsx/esm --test src/lib/feedAttribution.test.ts 2>&1 | tail -8; then :; fi

  echo
  echo "→ typecheck"
  if pnpm run typecheck 2>&1 | tail -6; then
    grn "typecheck OK"
  else
    red "typecheck FAILED — restore with:"
    red "  cp -r $BACKUP/. $SB/"
    exit 1
  fi
fi

echo
echo "──────────────────────────────────────────────"
grn "  done"
echo "──────────────────────────────────────────────"
cat <<'EOF'

Stage ONLY these five paths — another agent has admin routes modified:

  cd ~/workspace && git add \
    travel-buddy-standalone/src/lib/feedAttribution.ts \
    travel-buddy-standalone/src/lib/feedAttribution.test.ts \
    travel-buddy-standalone/src/components/ExploreTodaySection.tsx \
    "travel-buddy-standalone/app/(tabs)/index.tsx" \
    "travel-buddy-standalone/app/event/[id].tsx" \
    && git commit -m "feat(ranking): carry the feed session from impression to RSVP"

To undo:
  cp -r .session-attribution-backup/. travel-buddy-standalone/
  rm travel-buddy-standalone/src/lib/feedAttribution.ts \
     travel-buddy-standalone/src/lib/feedAttribution.test.ts

Cleanup once happy:
  rm -rf _session-attribution .session-attribution-backup apply-session-attribution.sh
EOF
