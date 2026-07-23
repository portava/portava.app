# APPLY — Stamp Premium Wave 1 (composition engine foundation)

Built against your 2026-07-23 16:49 export. Everything is flag-gated: after
applying, **nothing changes in the app** until `stamp_premium_rendering_enabled`
is turned on. Safe to ship immediately.

## What this wave does

1. **Composition engine** (`src/lib/stamps/composition/`) — the pivot from the
   stamp spec: AI paints hero art ONLY; the server composites perforated edge,
   rarity frame (bronze/silver/gold/royal + glow + foil sheen), identity band,
   arc/straight typography, authenticity + edition micro-text. Five template
   families: seal, portrait, landscape, square, pennant (auto-picked by stamp
   type). Deterministic palettes via `destination_identities` (5 launch cities
   seeded) with curated fallbacks — colors are never invented per-generation.
2. **Prompt v2** (`artDirection.ts`) — `buildHeroArtPrompt`: palette-injected,
   scene-only, hard NO-TEXT rules. Legacy prompt untouched (used while flag off).
3. **Worker integration** (`generationWorker.ts`) — premium path: hero QC →
   compose → rasterize (sharp) → composed QC → uploads hero + full 1024 PNG +
   256 thumbnail; records width/height/qc/composition manifest on the version row.
4. **BUG FIX (active even with flag off):** gpt-image-1 returns base64 `data:`
   URLs; the worker previously misclassified them as dev placeholders — real
   art was never uploaded to storage (megabytes of base64 went into
   `public_url` instead). Now decoded and uploaded properly.
5. **Fonts** — Poppins (OFL) bundled at `assets/fonts/` so server-side
   typography renders identically anywhere (auto-activated only if the host
   lacks Poppins).

## Steps (in Replit workspace root)

1. Drop `portava-stamp-wave1.patch` into the workspace root, then:

       git apply -p1 portava-stamp-wave1.patch

   If it complains (tree drifted), instead unzip the files package and copy
   `portava-stamp-wave1-files/*` over the workspace root (same paths).

2. **Fonts are NOT in the patch** (binary). Either way, copy from the zip:

       artifacts/api-server/assets/fonts/  →  same path in your workspace
       (4 files: 3 Poppins TTFs + fonts.conf)

3. Run migration **0177** in the Supabase SQL editor (`0177_stamp_premium_foundation.sql`,
   included at the top level of this package and at
   `artifacts/api-server/src/migrations/`).

4. Verify:

       cd artifacts/api-server && pnpm test 2>&1 | tail -6

   Expect all green, including the new `stampComposition.test.ts`
   (19 tests: identity resolution, all 25 family×rarity combos, prompt v2
   no-text guarantees, b64 classification fix, sharp raster + QC).

5. Typecheck: `npx tsc --noEmit` in artifacts/api-server → clean.

## Turning it on (when you're ready — suggest after visual spot-check)

    UPDATE feature_flags SET enabled = TRUE WHERE flag = 'stamp_premium_rendering_enabled';

New generation jobs then produce composed premium stamps. Existing artwork is
untouched until you deliberately bump `STYLE_VERSION` in `artDirection.ts` —
that triggers the stale sweep to re-enqueue the whole catalog (dev and prod
share the queue, so do that as a coordinated step, not casually).

## Not in this wave (next)

Per-definition rarity variants + recomposition endpoint, showcase/admire,
criteria engine, mobile thumbnail-aware rendering + expo-image, OG share
rebuild on the same layers. Say "next stamp wave" when ready.
