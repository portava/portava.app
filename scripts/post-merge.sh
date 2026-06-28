#!/bin/bash
set -e
pnpm install

echo ""
echo "=== Syncing standalone EAS build target ==="
bash scripts/sync-standalone.sh
