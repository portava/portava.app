# DISCOVERY_PASS_2_REPORT.md

Discovery Wall Pass 2 — the deeper Explore sections, built on v3 with shared primitives.
Pass 1 (header, Compass Pick/For You, category chips, Featured Experiences) was already
done and is unchanged. This pass appends the lower half of the wall.

## Sections finished (appended below Featured Experiences)
1. Hidden Gems (By Travelers) — horizontal cards: image, name, neighborhood, why-special,
   "By <traveler>", Save, Add to Plan. Empty state included.
2. Neighborhoods / Areas by Vibe — image tiles (Best for Nightlife/Food/Beach/Culture/
   Relaxation) with vibe + area overlay; "Often associated with — provisional" note.
3. Traveler Picks — user avatar, place, rating, short note, tag, Save + Add to Plan.
4. Saved Ideas — list rows (name, type · neighborhood) with Add to Trip + saved icon.
   Empty state routes to Explore. (Saved lives here + Trip context, NOT a Passport tab.)
5. Ask Compass — dark contextual card with prompts ("Build a night from these", "Find
   more like this", "Turn saved ideas into a plan", "What matches my vibe?") → /(tabs)/ai.

## Components added
- src/components/DiscoveryWall2.tsx
  HiddenGemCard, HiddenGemsSection, NeighborhoodCard, NeighborhoodsSection,
  TravelerPickCard, TravelerPicksSection, SavedIdeasSection, AskCompassCard.
  Uses shared primitives (TravelSectionHeader, TravelEmptyState) + tokens.

## Data contracts added (src/data/discovery.ts)
- hiddenGems: DiscoveryItem[]            (source seed, provisional, verified false)
- neighborhoods: NeighborhoodVibe[]      (new interface: vibe/area/tags/blurb + source/status/verified)
- travelerPicks: TravelerPick[]          (new interface: user/place/note/rating/tag/timeAgo + source/status/verified)
- savedIdeas: SavedDiscoveryItem[]       (new interface: name/type/neighborhood)
All seeded items carry source/status/verified. Traveler picks are source:'traveler'
but still status:'provisional', verified:false — not presented as verified truth.

## Routes touched
- app/(tabs)/discovery.tsx — appended 5 sections + imports. Header/Compass/chips/Featured unchanged.
- No new routes. Add to Plan → /create or /(tabs)/trips (existing). Add to Trip → /(tabs)/trips.
  Ask Compass → /(tabs)/ai (existing). Saved → /saved (existing). These are safe existing targets;
  full trip/plan selectors are Pass-2-of-those-surfaces work.

## Provisional data used
Hidden gems, neighborhoods, traveler picks — all hand-seeded. UI shows soft labels
("Starter city note — provisional", "Often associated with"). No safety-critical claims.
No fake popularity/ranking; "Saved by N travelers" only where a count exists in seed.

## Remaining gaps
- Add to Trip / Add to Plan should open real selectors once Trip Pass 2 + plan flow land.
- Filter button + Saved shortcut still route to placeholders (full filter sheet = later).
- Replace all seed with real place data + attribution (OSM/Wikidata/GeoNames) later.
- Floating Compass button: implemented as an "Ask Compass" card this pass (per spec option).

## Commands run (this environment — static only)
- Escaped-backtick scan: CLEAN
- Import/identifier audit: 0 missing
- Brace/paren/bracket balance: balanced (0,0,0) on all touched files
- Removed unused imports (Trash2, icon token)

## On-device checks (run on your Mac)
    npx tsc --noEmit
    npx expo start --clear     # press w
Mark results here after running.

## Files changed
- src/components/DiscoveryWall2.tsx   (NEW)
- src/data/discovery.ts               (appended Pass 2 seed + 3 interfaces)
- app/(tabs)/discovery.tsx            (appended 5 sections + imports)
- DISCOVERY_PASS_2_REPORT.md          (this file)

## Summary
The Explore screen now scrolls from header → Compass Pick → chips → Featured → Hidden
Gems → Neighborhoods by Vibe → Traveler Picks → Saved Ideas → Ask Compass. It reads as
a full city discovery board, not just a top header. Everything seeded stays labeled
provisional; Saved lives in Discovery (not Passport); all cards have Save / Add-to-Plan
actions; built with shared primitives so it matches the rest of the app.
