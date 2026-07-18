---
name: Unified location context pattern
description: How the 3-tier location cascade, session override, and resolvedLocation work in LocationContext
---

# Unified location context pattern

## The rule
All location-aware screens must read from `resolvedLocation` (from `useLocationContext()`), never directly from `locationState.place.city` or `locationState.coords`. Session-scoped temporary city searches use `setSessionLocation` / `clearSessionLocation` — never `setManualCity`.

**Why:** Before this unification, GPS-denied users saw no city because only GPS was checked. `setManualCity` permanently wrote temporary search choices to the backend. Tab switches carried stale searched cities across screens.

## How to apply
- `resolvedLocation.place.city` — city for display and API queries (all 4 tiers)
- `resolvedLocation.coords` — coords for camera/map fallback (null for home tier)
- `resolvedLocation.source` — `'gps_fresh' | 'gps_cached' | 'last_known' | 'home' | 'manual_city' | 'none'`
- Show a freshness indicator when `source === 'last_known' || source === 'home'`; hide for all others
- Call `clearSessionLocation()` inside `useFocusEffect` on Discovery and Pulse so temporary searches reset on every tab entry

## Component test mocks
Any mock of `useLocationContext` must include the full shape:
```ts
useLocationContext: () => ({
  locationState: { permissionStatus: 'granted', coords: null, place: { city: null } },
  requireLocation: jest.fn(),
  resolvedLocation: { place: { city: null }, coords: null, source: 'none', freshness: 'live' },
  setSessionLocation: jest.fn(),
  clearSessionLocation: jest.fn(),
})
```
Omitting `resolvedLocation` causes a TypeError in FullScreenMapScreen (accesses `.coords?.lat`).

## Duplicate export trap
`ResolvedLocation` is declared as `export interface ResolvedLocation` in `LocationContext.tsx`. Do NOT also list it in the bottom `export type { ... }` re-export line — TypeScript rejects duplicate exports.

## Tier-4 (home) coords
Home city is fetched from `/api/me/profile` (field `homeCity`). No client-side geocoding is done — `coords` is `null` for the home tier. City name alone is sufficient for content queries; only the map camera needs coords, and the map already falls back to an empty state when `fallbackLat/Lng` are null.
