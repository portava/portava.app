---
name: Discovery DB merge + Pulse place cards
description: How discovery_places DB integrates with OSM results, and how Pulse Wall gets place recommendation cards when posts are thin.
---

## Discovery route DB merge

- `mapDbCategory(raw)` maps free-text DB `category`/`place_type` to the 8 canonical Discovery tab categories.
  - **Regex pitfall:** use `/hik/` not `/hike/` — "hiking" contains "hik" but not the full stem "hike".
- `queryDbPlaces(destination, category, lat, lng)` queries `discovery_places` with `city.ilike.${cityBase}%`, filters client-side by category, converts rows to `DiscoveryPlace`.
- `mergeAndDedup(osmPlaces, dbPlaces)` interleaves one DB place per 4 OSM results; deduplicates by `name.toLowerCase().trim()`. OSM takes precedence.
- Cache stores OSM-only (`osmPlaces`), but DB is always re-queried fresh (submitted places change faster than OSM).
- All response paths add `sourceSummary: { seededDbCount, osmCount, userCreatedCount }`.

**Why:** discovery_places table has traveler-submitted and curated places that Overpass/OSM never returns; merging ensures they surface in the Discovery tab without blowing up the OSM cache.

## Pulse place recommendation cards

- `pulseQuerySchema` accepts `city`, `lat`, `lng` optional params.
- After `orderedPosts` is assembled: if `posts.length < PLACE_CARD_THRESHOLD (5)` and `city` param provided, query `discovery_places` (`city.ilike.%{cityBase}%`, `status=active`, order by `saved_count`) and return as `placeCards[]` in the response.
- Non-fatal: wrapped in try/catch, degrades to empty array on error.

## Frontend wiring

- `services/pulse.ts`: `getPulseData({ city, lat, lng, limit })` — calls `/api/pulse?city=...`, returns `{ posts, placeCards }`. `placeCardToFeedItem()` converts to `PulseFeedItem`.
- `PulseItemType` now includes `'place_card'`; `PulseFeedItem` has `placeId?: string | null`.
- `PulseFeedCard` renders `PlaceRecommendationCard` for `type='place_card'` items (green badge, name, location chip, blurb, "Explore on Discovery →" CTA).
- `app/(tabs)/index.tsx`: removed static `pulseFeed` mock entirely; `backendPlaceCards` state fetches from backend on mount and on city change; injected into `forYouFeed` only when `active.includes('All') && realItems.length < 5`.
- `useCityPulse.ts`: real fetch from `/api/events?city=...&state=open&limit=20` via `freshToken()`; falls back to `mockEvents` gracefully if API unavailable or not signed in.
