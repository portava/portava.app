---
name: Explore page performance fixes
description: What was changed to bring the Discover tab to social-media-grade load speed — decisions and patterns for future consistency.
---

## The Root Causes (audit + fixes)

### 1. 7×Nominatim calls per category-count batch → fixed
**Problem:** `getDiscoveryCategoryCounts` fired 7 parallel `/api/discovery` requests on every city/filter change. Each hit Nominatim independently. 7 concurrent requests for the same city violated 1 req/s fair-use and added 25 s cold-start per geocode.
**Fix:**
- Added `geocodeCached()` on the server (in-memory 24-h cache + promise deduplication). All in-flight requests for the same city share one Nominatim call.
- Added `GET /api/discovery/counts` endpoint — geocodes once, fans out to all 7 categories in parallel using the existing Overpass cache, returns `{ counts: Record<cat,N> }` in one response.
- Client now uses `getDiscoveryCategoryCountsBatch()` (single HTTP request) for the default `ageFilter='any'` case; falls back to 7-parallel for age-filtered requests.

**Why:** Nominatim has a strict 1 req/s fair-use policy. 7 simultaneous requests for "Paris" violated it and was the single biggest cold-start bottleneck.

**How to apply:** Any new server route that does geocoding must call `geocodeCached` not `geocode` directly. Any client-side feature that needs category counts must use `getDiscoveryCategoryCountsBatch` unless per-request auth personalisation requires the per-category endpoint.

---

### 2. 45 network calls on PlaceCard mount (3 per card × 15 cards) → reduced
**Problem:** Every `PlaceCard` mount fired `checkSaved`, `getPlaceReviews`, `getSavedListIds` simultaneously.
**Fix:**
- **Removed `getPlaceReviews` from PlaceCard entirely.** The card now shows `place.rating` (OSM rating) directly. Reviews are shown in the detail sheet (PlaceDetailSheet already fetches them on open).
- **Deferred `getSavedListIds` by 800 ms** using `setTimeout` + `useRef` for cleanup. The "Saved to N trips" badge is secondary info; deferring it avoids competing with the initial list paint.
- `checkSaved` is kept immediate (drives bookmark icon UX — must be accurate).

**Why:** `getPlaceReviews` fired for every visible card and was the largest N+1 on mount. OSM `place.rating` is sufficient for discovery-card context.

**How to apply:** Do not add `useEffect` network calls to PlaceCard without explicit review. Secondary badges (savedCount, review avg) must be deferred or batched.

---

### 3. No client-side cache → stale-while-revalidate added
**Problem:** Every Explore tab focus or destination change discarded all previously fetched data and started from zero.
**Fix:**
- Module-level `_CLIENT_CACHE` Map in `services/discovery.ts` (4-min TTL, keyed `dest:cat:radiusKm:page`).
- `getDiscoveryPlaces` populates cache on every successful response.
- `getCachedDiscoveryPlaces(dest, cat, radiusKm, page)` — synchronous read for instant paint.
- `isDiscoveryCacheFresh(...)` — boolean freshness check.

**Why:** Users switching tabs and returning to Explore expect instant content. The server has a 2-h cache; the client now has a 4-min local echo of it.

**How to apply:** Any component that calls `getDiscoveryPlaces` can optionally pre-seed its state from `getCachedDiscoveryPlaces` before the async fetch settles.

---

### 4. Count state reset to `{}` on filter change → removed (stale-while-revalidate for counts)
**Problem:** `setCategoryCounts({})` on every counts refetch caused all tab badges to clear and flash dim while loading.
**Fix:** Removed the reset. Old counts stay visible while fresh ones load. `countsLoading` still controls the dimming indicator per tab.

**Why:** Stale counts are far better UX than blank counts. The counts change rarely (only on city or radiusKm change) so stale data is almost always correct.

---

### 5. `ForYouTab` ScrollView → FlatList (virtualisation)
**Problem:** `ScrollView` rendered all items simultaneously — all 15 OSM cards mounted at once, each firing API calls.
**Fix:** Converted to `FlatList` with:
- `ListHeaderComponent` = source label + `CompassTravelerRow` (memoized with `useMemo`)
- `ListFooterComponent` = community sections (memoized)
- `ListEmptyComponent` = empty state (only shown when `source === 'none'`)
- `renderItem` wrapped in `useCallback`
- `initialNumToRender=5`, `maxToRenderPerBatch=5`, `windowSize=7`, `removeClippedSubviews`

**Why:** Virtualisation means only ~5 cards mount on initial render instead of all 15, cutting initial mount side-effects by 67%.

---

### 6. `useCommunityDiscovery` module-level stale-while-revalidate cache
**Problem:** Community places refetched on every city change, no caching.
**Fix:** Module-level `_communityCache` Map (5-min TTL, keyed `city:sortBy`). Mount initialises state from cache synchronously (instant paint), then fires network refresh only if cache is stale.

**Why:** Community data (hidden gems, traveler picks) changes slowly. 5 min stale window is safe.

---

## What was NOT changed
- Server 2-h Overpass/OSM cache — kept as-is (already fast for warm cities)
- Server discovery warmup — kept as-is
- Compass feed AsyncStorage stale-while-revalidate — already present (good)
- `DiscoveryCategoryTab` — already uses FlatList (good)
- `checkSaved` per PlaceCard — kept immediate (bookmark icon must be accurate)
