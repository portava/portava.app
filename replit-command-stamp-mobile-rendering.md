# REPLIT AGENT COMMAND — Premium stamp rendering in the app (mobile)

## Context — read first

The backend now serves the premium composited artwork. Every stamp response
already carries:
- `activeArtworkUrl` — full composited stamp (~1024px, its own frame + rarity)
- `thumbnailUrl` — 256px thumbnail for small render targets (NEW; may be null)
- `definition.rarity` — 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

The mobile `Stamp` types already include `thumbnailUrl` (added in
`services/stamps.ts` + `services/passportStamps.ts`). Do NOT change any backend
code, services, or types — this is `artifacts/travel-buddy` component/lib work
only.

House rules: follow existing component patterns, reduced-motion respected, add
jest-expo component tests for every change, no new dependencies (expo-image is
already installed), `pnpm --filter travel-buddy exec tsc --noEmit` stays clean.

## Task 1 — Thumbnail-aware, cached artwork rendering

`src/components/stamps/UniversalStampArtwork.tsx` and the size router
`src/components/StampArtwork.tsx` currently use React Native's plain `<Image>`
with `activeArtworkUrl` at every size — so a 64px grid tile downloads the full
~1024px asset, and there's no caching.

Change:
- Swap plain `<Image>` for **`expo-image`'s `<Image>`** (already a dependency;
  see how `src/components/EventDiscoveryCard.tsx` uses it) for disk/memory
  caching (`cachePolicy="memory-disk"`).
- **Pick the source by render size**: for `size < 120` prefer `thumbnailUrl`;
  for detail (`size >= 120`) use `activeArtworkUrl`. Fallback chain per target:
  chosen URL → the other URL → existing procedural `StampArtwork` fallback.
  (Never show nothing; a stamp with no composited art still renders procedurally.)
- Add an **`accessibilityLabel`** to the stamp image
  (e.g. `${definition.name} — ${rarity} stamp`). This is currently missing on
  the v2 raster path.
- Keep `contain` behavior for composited art (it has its own transparent frame;
  do not crop it).

## Task 2 — One rarity source of truth

Rarity colors/labels are copy-pasted across ~9 files (StampCard ×2,
StampDetailModal, StampDetailArtwork, StampEarnedToast, StampShowcaseRow,
PublicStampShowcaseSection, StampShowcaseCurationSheet, StampShareCard) and they
diverge. Create **`src/lib/stampRarity.ts`** exporting:
- `type StampRarity = 'common'|'uncommon'|'rare'|'epic'|'legendary'`
- `RARITY_COLORS: Record<StampRarity, { ring: string; text: string; glow?: string }>`
  (bronze / silver / gold / royal treatments matching the composited frames)
- `RARITY_LABEL: Record<StampRarity, string>`
- `normalizeRarity(v?: string | null): StampRarity` (unknown → 'common')

Replace the local maps in those files with imports from this module. Do not
change the visual result for tiers that already looked right — just unify.
Make sure `epic` is handled everywhere (some maps only have the 4-tier set).

## Task 3 — Show rarity on the tile

Where stamps render as cards/tiles (StampCard, showcase row), surface a small
rarity treatment consistent with the composited frame — a thin ring or corner
pip in `RARITY_COLORS[rarity].ring`, and reserve the glow for epic/legendary
(respect reduced-motion: no animation, a static glow ring is fine). Keep it
subtle; the composited art already carries most of the rarity signal.

## Explicitly OUT of scope
Backend, API, services, types; the composition engine; admin app; earning/
generation logic; the OG share image (already rebuilt server-side).

## Acceptance
- Grid/list tiles load the 256px thumbnail (not the 1024 full); detail loads full.
- Stamps with no composited version still render (procedural fallback) — no blank tiles.
- expo-image caching in place; artwork has an accessibilityLabel.
- Exactly one rarity color/label module; the ~9 duplicates are gone; `epic` handled everywhere.
- Component tests: size→source selection (thumb vs full vs procedural fallback),
  accessibilityLabel present, normalizeRarity mapping, a tile renders the rarity ring.
- `pnpm --filter travel-buddy exec tsc --noEmit` clean; suite green.
