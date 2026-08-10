---
name: Discovery perf two-level cache and SWR
description: L1/L2 cache architecture for /api/discovery, baseline numbers, and client-side optimizations
---

# Discovery Performance: Two-Level Cache + Stale-While-Revalidate

## Architecture

**Server-side (discovery.ts):**

L1 (in-process Map, `cache`) → L2 (Postgres `discovery_cache`, via `discoveryPersistentCache.ts`) → cold Nominatim+Overpass fetch.

Hit path:
1. L1 in-memory: ~0 ms (no I/O)
2. L2 Postgres fresh: ~15–100 ms (DB query for places + community places)
3. L2 Postgres stale: same response time as L2 fresh; background goroutine refreshes Overpass async
4. Cold miss: 5–20 s (Nominatim 0–153 ms + Overpass 5–20 s)

Geocode cache follows the same L1/L2 pattern via `discovery_geocode_cache` table. Geocode L2 is strict-TTL (no SWR) since Nominatim coords are stable.

**Instrumentation** (Step 1): every response includes `meta: { cacheLevel, timings: { geocodeMs, osmMs, totalMs } }` and a pino structured log.

**DB tables created (0154_discovery_cache.sql):**
- `discovery_cache` (PK: `cache_key`, columns: destination, category, radius_km, places jsonb, geocode_lat/lng/display, cached_at, expires_at)
- `discovery_geocode_cache` (PK: `location_key`, columns: lat, lng, display_name, cached_at, expires_at)

Both tables have RLS enabled with service_role full-access policies.

**Cache warmer (discoveryWarmup.ts):**
- `warmUpDiscoveryCache(port)` — one HTTP req per city+category, 1.2 s apart, 15 s timeout
- `startDiscoveryCacheWarmer(port)` — calls warmUp once on startup then every hour via setInterval (unref'd)
- 20 cities × 4 categories = 80 total requests per cycle

## Client-Side (Steps 4 + 5)

**Step 4 — AsyncStorage counts cache-first (`discoveryLocalCache.ts`):**
- Key: `discovery:counts:v1:<city_lower>`, TTL 1 hour
- `loadCachedCounts(city)` called once on mount; populates `categoryCounts` state immediately → tab badges paint without waiting for network
- `saveCachedCounts(city, counts)` called after network counts resolve
- Second open: tab badges appear in < 100 ms from AsyncStorage; console logs `[Discovery] cache-first paint: Xms`

**Step 5 — Defer non-critical work (`InteractionManager`):**
- MapTiler geocode effect wrapped in `InteractionManager.runAfterInteractions` — coords not needed for place card render
- Buddy strip `getAvailableNow` wrapped in `InteractionManager.runAfterInteractions` — strip is below fold

## Baseline Numbers (logged from Step 1 on 2026-07-18)

Cold miss (no L1/L2 cache):
- Geocode: 0 ms (cached) or 143–153 ms (Nominatim miss)
- Overpass: 5,438–19,635 ms (Overpass latency is the dominant bottleneck)
- Total cold miss: 5,661–19,865 ms

## TypeScript Gotcha

`destination` is `string | undefined` inside inner async functions (`serveCachedPlaces`, background revalidation IIFEs) even though the handler guards it. Must use `destination!` in those closures.

**Why:** TypeScript cannot narrow `const` closure variables through inner function declarations (only through the immediate block scope after the check). The narrowing applies in the handler's linear flow but not inside named async functions defined inside the handler.

`writePlacesToDb` accepts `geocode: { lat, lng, display?: string } | null` (display is optional) because `clientCoords` doesn't carry a display name — only `geocodeCached()` results do.

## Mobile import path for Supabase

`import { supabase } from '../lib/supabase.ts'` (NOT `../services/supabase`).
