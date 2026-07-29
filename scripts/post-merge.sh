#!/bin/bash
# Post-merge setup — keeps the canonical tree healthy and auto-propagates
# every merge to the standalone EAS mirror so the two trees can never drift
# into co-equal editable sources.
#
#   Canonical tree:  artifacts/travel-buddy   (edit here — single source of truth)
#   Mirror tree:     travel-buddy-standalone  (generated EAS build target)
#   Web app output:  served directly from the canonical tree (Expo web) —
#                    no separate sync step needed.
#
# Steps:
#   1. pnpm install                     — monorepo deps for the merged code
#   2. sync-standalone --apply-deps     — patch mirror package.json dep drift
#   3. sync-standalone (full)           — copy source dirs + config files
#   4. pnpm install (mirror)            — re-resolve the mirror lockfile
#   5. drift verification               — check-source / check-deps / check-lockfile
#   6. seed @portava account            — idempotent; ensures the official account exists
#
# Any unexpected divergence (perspective-divergent files, preserved-file or
# babel/metro/tsconfig structural drift, unresolved lockfile drift) makes this
# script exit non-zero so the failure is surfaced loudly instead of silently
# accumulating. STANDALONE_OWNED_FILES entries in scripts/sync-standalone.sh
# are the only sanctioned divergence and are skipped by design.
set -euo pipefail

echo "=== 1/6: monorepo install ==="
pnpm install

echo ""
echo "=== 2/6: propagate dependency changes to the standalone mirror ==="
bash scripts/sync-standalone.sh --apply-deps

echo ""
echo "=== 3/6: propagate source + config to the standalone mirror ==="
bash scripts/sync-standalone.sh

echo ""
echo "=== 4/6: re-resolve standalone lockfile ==="
( cd travel-buddy-standalone && pnpm install )

echo ""
echo "=== 5/6: verify zero unexpected drift ==="
bash scripts/sync-standalone.sh --check-source
bash scripts/sync-standalone.sh --check-deps
bash scripts/sync-standalone.sh --check-lockfile

echo ""
echo "=== 6/6: seed @portava official account (idempotent) ==="
( cd artifacts/api-server && node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts )

echo ""
echo "Post-merge sync complete — canonical tree and standalone mirror are aligned."
