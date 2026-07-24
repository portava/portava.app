# REPLIT AGENT COMMAND — Portava remaining UI (all pending screens)

## Read this first — hard rules

Every feature below has its **backend, API, migrations, and mobile service
already built, tested, and merged**. Your job is the in-app UI in
`artifacts/travel-buddy` ONLY.

- **Do NOT** create or modify anything under `artifacts/api-server`, any
  migration, any `*.sql`, or any file in `src/services/` (the service clients
  are the contract — call them, don't change them). The one exception is the
  new shared UI helper you create in Task 1 (`src/lib/stampRarity.ts`).
- Every service is **fail-soft**: it returns `null` when its feature flag is off
  or unavailable. When a service returns `null`, render **nothing** for that
  section — no error, no empty box. This is how features stay invisible until
  their flag is flipped.
- Add a **jest-expo component test** for every component you create or change.
- No new dependencies (`expo-image` and `react-native-draggable-flatlist` are
  already installed).
- `pnpm --filter travel-buddy exec tsc --noEmit` must stay clean, and the test
  suite must stay green.
- Respect the OS **reduce-motion** setting for any animation (see how
  `StampCard`/`StampEarnedToast` gate via `AccessibilityInfo`).

Do the tasks in order; each is independent and shippable on its own.

---

## Task 1 — Premium stamp rendering (thumbnails + expo-image + one rarity source)

Backend already returns, on every stamp: `activeArtworkUrl` (full ~1024px
composited stamp), `thumbnailUrl` (256px, may be null), and
`definition.rarity` (`common|uncommon|rare|epic|legendary`). The mobile `Stamp`
types already carry `thumbnailUrl`.

**1a. Thumbnail-aware, cached rendering.** In
`src/components/stamps/UniversalStampArtwork.tsx` and the size router
`src/components/StampArtwork.tsx`:
- Swap React Native's `<Image>` for **`expo-image`'s `<Image>`** with
  `cachePolicy="memory-disk"` (see `EventDiscoveryCard.tsx` for the import).
- Pick the source by render size: `size < 120` → prefer `thumbnailUrl`;
  `size >= 120` (detail) → `activeArtworkUrl`. Fallback chain per target:
  chosen URL → the other URL → existing procedural `StampArtwork` fallback.
  Never render blank; a stamp with no composited art still shows procedurally.
- Add an `accessibilityLabel` to the stamp image, e.g.
  `` `${definition.name} — ${rarity} stamp` ``.
- Composited art keeps `contentFit="contain"` (it has its own transparent
  frame; never crop it).

**1b. One rarity source of truth.** Rarity colors/labels are copy-pasted across
~9 files (StampCard ×2, StampDetailModal, StampDetailArtwork, StampEarnedToast,
StampShowcaseRow, PublicStampShowcaseSection, StampShowcaseCurationSheet,
StampShareCard) and they diverge. Create **`src/lib/stampRarity.ts`** exporting:
- `type StampRarity = 'common'|'uncommon'|'rare'|'epic'|'legendary'`
- `RARITY_COLORS: Record<StampRarity, { ring: string; text: string; glow?: string }>`
  (bronze / silver / gold / royal treatments matching the composited frames)
- `RARITY_LABEL: Record<StampRarity, string>`
- `normalizeRarity(v?: string | null): StampRarity` (unknown → 'common')

Replace the local maps in those files with imports from this module. Don't
change the visual result for tiers that already looked right — just unify, and
make sure `epic` is handled everywhere (some maps only have the 4-tier set).

**1c. Rarity on tiles.** On cards/tiles (StampCard, showcase row) show a subtle
rarity ring/corner pip in `RARITY_COLORS[rarity].ring`; reserve a static glow
ring for epic/legendary (no animation under reduce-motion). Keep it subtle —
the composited art already carries most of the signal.

Acceptance: grid/list tiles load the 256px thumbnail (not the 1024 full),
detail loads full; no blank tiles; artwork has an accessibilityLabel; exactly
one rarity module, the ~9 duplicates gone, `epic` handled.

---

## Task 2 — Country essentials "Good to know" card

Service: `src/services/countryEssentials.ts` →
`getTripEssentials(tripId)` returns `TripEssentialsItem[] | null`
(`{ country, essentials }` per destination; `essentials` is null for uncovered
countries), and `getCountryEssentials(code)` for a single country.

On the trip screen (near the readiness section), add a **"Good to know" card**
per destination country:
- `getTripEssentials(tripId)`; `null` → render nothing.
- For each item with `essentials != null`, show: plug type(s) + a one-line
  adapter hint (e.g. "Type G — bring an adapter"), voltage/frequency, drive
  side, and the emergency numbers (`all` / police / ambulance / fire).
- **ALWAYS render `essentials.disclaimer`** beneath the emergency numbers
  (safety-relevant — "confirm on arrival"). Non-negotiable.
- Items where `essentials` is null: skip that country silently (honest unknown).

Acceptance: card appears only when the flag is on and the trip has a covered
destination; disclaimer always visible with emergency numbers.

---

## Task 3 — Budget FX converted display

Service: `src/services/tripIntel.ts` →
`fetchCostEstimateWithFx(tripId, homeCurrency?, tier?)` returns
`{ estimate, converted } | null`, where `converted` is
`{ currency, perDay{low,mid,high}, total{low,mid,high}, rateDate, disclaimer } | null`.

In the existing budget section (`src/components/trip/TripBudgetSection.tsx`):
- Keep the current source-currency display exactly as is (don't regress it).
- When you have the user's home currency (from profile/settings), call
  `fetchCostEstimateWithFx(tripId, homeCurrency)`. If `converted` is present,
  show the home-currency per-day/total **underneath** the source figure, styled
  as secondary, with the `converted.disclaimer` line ("indicative ECB rate")
  and the `rateDate`.
- `converted == null` (flag off, same currency, or no rate) → show only the
  source figure, exactly as today. Never hide the source amount.

Acceptance: converted band shows only when available, always subordinate to the
source figure, always with the disclaimer.

---

## Task 4 — FSQ places surface

Service: `src/services/fsqPlaces.ts` →
`getCityPlaces(cityKey, category?)` returns
`{ places, attribution, datasetDate } | null`. `cityKey` is the ingestion slug
(e.g. `'cebu-ph'`); `category` ∈ accommodation|nightlife|food|culture|shopping.

Where a city is shown (discovery / neighborhood / an accommodation-location
context), add an optional **"Places" strip** grouped by category (lead with
`accommodation` — hotels are the headline value):
- `getCityPlaces(cityKey, category)`; `null` → render nothing.
- List name + `label` + `locality`; tapping a place can open its coordinates in
  the existing map view if one is handy (optional).
- **ALWAYS render the `attribution` string ("Powered by Foursquare")** at the
  foot of any FSQ-sourced list — license requirement, non-negotiable.

Note: this shows nothing until a city has been ingested server-side (a manual
data step) AND the flag is on — that's expected; the fail-soft null handles it.

Acceptance: strip appears only for ingested cities with the flag on;
attribution always shown; hidden cleanly otherwise.

---

## Definition of done (all tasks)

- `pnpm --filter travel-buddy exec tsc --noEmit` clean; jest suite green.
- Every new/changed component has a component test, including the
  flag-off/null → renders-nothing case.
- No file under `api-server/`, no migration, no `src/services/*` touched
  (except creating `src/lib/stampRarity.ts`).
- Safety/legal text always rendered: country-essentials disclaimer, FSQ
  attribution, budget-FX indicative disclaimer.

When done, export the workspace (source-only) so the changes can be audited
against these contracts.
