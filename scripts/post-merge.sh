#!/bin/bash
set -e
pnpm install

echo ""
echo "=== Syncing standalone EAS build target ==="
SYNC_EXIT=0
bash scripts/sync-standalone.sh || SYNC_EXIT=$?
if [[ $SYNC_EXIT -ne 0 ]]; then
  echo ""
  echo "⚠️  WARNING: standalone dependency drift detected (see diff above)."
  echo "   Mirror the changes into travel-buddy-standalone/package.json before your next EAS build."
fi
