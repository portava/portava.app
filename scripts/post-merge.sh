#!/bin/bash
# Post-merge setup.
#
# travel-buddy-standalone/ is the single canonical mobile tree (the old
# artifacts/travel-buddy mirror + its sync/drift-check pipeline were retired
# and removed on 2026-08-14 — see replit.md's SOURCE OF TRUTH banner).
# There is nothing left to sync between trees; this script just makes sure
# the merged code's dependencies are resolved for both the monorepo root
# and the standalone app.
set -euo pipefail

echo "=== 1/2: monorepo install ==="
pnpm install

echo ""
echo "=== 2/2: standalone app install ==="
( cd travel-buddy-standalone && pnpm install )

echo ""
echo "Post-merge setup complete."
