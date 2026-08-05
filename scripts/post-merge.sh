#!/bin/bash
# Post-merge setup — LEGACY, DISABLED BY DEFAULT since 2026-08-05.
#
# The description below documents the pre-2026-08-04 arrangement and only
# applies when the pipeline is explicitly enabled (PORTAVA_ENABLE_LEGACY_SYNC=1).
# Today: travel-buddy-standalone/ is CANONICAL; artifacts/travel-buddy is
# legacy-frozen. See the guard below.
#
#   [legacy] Canonical tree:  artifacts/travel-buddy   (edit here — single source of truth)
#   [legacy] Mirror tree:     travel-buddy-standalone  (generated EAS build target)
#   [legacy] Web app output:  served directly from the canonical tree (Expo web) —
#                             no separate sync step needed.
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

# ─────────────────────────────────────────────────────────────────────────────
# HARD DEFAULT-OFF GUARD (2026-08-05)
#
# History: artifacts/travel-buddy was retired on 2026-08-04 (standalone became
# canonical), then the tree was RESURRECTED on 2026-08-05 in a LEGACY-FROZEN,
# non-canonical state. The old guard here was existence-only ("skip if the
# tree is gone"), so the resurrection silently re-armed this auto-sync: the
# next merge would have overwritten standalone-owned files (app.json, icons,
# splash/branding assets, …) with stale legacy copies.
#
# travel-buddy-standalone/ is THE canonical mobile tree. This legacy sync
# pipeline must never run implicitly — it only runs when explicitly enabled
# via PORTAVA_ENABLE_LEGACY_SYNC=1. Exits 0 so the post-merge hook never
# fails a merge because of this guard.
# ─────────────────────────────────────────────────────────────────────────────
if [ "${PORTAVA_ENABLE_LEGACY_SYNC:-}" != "1" ]; then
  echo "=============================================================================="
  echo "post-merge.sh: LEGACY artifacts -> standalone SYNC IS DISABLED (default-off)."
  echo ""
  echo "  * artifacts/travel-buddy was resurrected on 2026-08-05 but is LEGACY-FROZEN"
  echo "    (do not edit it; it is slated for archival)."
  echo "  * travel-buddy-standalone/ is the CANONICAL mobile tree (since 2026-08-04)."
  echo "  * Running this sync would overwrite standalone-owned branding/config"
  echo "    (app.json, assets/images/icon.png, adaptive-icon/splash/favicon,"
  echo "    assets/share-icon.svg, …) with stale legacy copies."
  echo ""
  echo "  Nothing was synced; nothing was installed. This is the intended default."
  echo "  To run the legacy sync pipeline DELIBERATELY (you almost certainly"
  echo "  should not), re-run with:"
  echo "      PORTAVA_ENABLE_LEGACY_SYNC=1 bash scripts/post-merge.sh"
  echo "=============================================================================="
  exit 0
fi

# Secondary guard (explicit-enable path only): a missing source tree means
# there is nothing to sync from — running the pipeline would strip the
# now-canonical standalone tree. Abort successfully.
if [ ! -d "artifacts/travel-buddy" ]; then
  echo "artifacts/travel-buddy not found — nothing to sync; aborting (standalone is canonical)"
  exit 0
fi

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
# The seeder exits 0 with a warning when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# are absent, so this step never blocks the pipeline in a fresh environment.
( cd artifacts/api-server && node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts )

echo ""
echo "Post-merge sync complete — canonical tree and standalone mirror are aligned."
