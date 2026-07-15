# Travel Buddy — Native Map Provider Plan

> **Planning document only. No packages installed, no native config changed, no
> builds run.** This is the implementation roadmap for the real native social map,
> to be executed once the dev-build path exists and the feasibility gate clears.

## Decision summary

- **Primary:** MapLibre native + MapTiler tiles.
- **Fallback:** Mapbox (`@rnmapbox/maps`) — only if MapLibre's RN package does not
  safely support the project's New Architecture at the installed version.
- **Why MapLibre:** Travel Buddy's backend is the source of truth for pins, privacy,
  events, people, saved places. The provider only supplies the basemap, vector style,
  clustering, and marker rendering — so MapLibre's open, lower-lock-in stack fits, and
  costs less than Mapbox for a "renderer only" role.

## Confirmed project context (verified from source)
- Expo SDK 54, React Native 0.81.5, New Architecture ON.
- `react-native-maps` is currently installed and used by the native
  `DiscoveryMapView.tsx` (plain markers, venue/place pins only).
- `DiscoveryMapView.web.tsx` is a web-safe fallback (no native import) — now updated
  to show an honest "available on mobile" message.
- `PlaceDetailSheet.tsx` exists and is the bottom sheet to reuse for selected pins.
- `map.ts` exists with private-by-default location, `listNearbyUsers`,
  `listVisibleCircleLocations`. **It has no bounded/viewport query and no rich unified
  pin shape** — both are net-new backend work.

## The hard gate: New Architecture compatibility

**Before installing anything**, verify the exact `@maplibre/maplibre-react-native`
version supports RN New Architecture (newArchEnabled: true) on RN 0.81. If support is
incomplete/unstable:
- Stop. Switch to Mapbox `@rnmapbox/maps` (solid New-Arch support).
- The prepared `DiscoveryMapLibreView.tsx` component is structured so the swap is
  ~1:1 (one import line + the map/marker component names).

## Manual owner steps (cannot be automated)
- Create / log into an Expo account; `eas login`, `eas init`.
- Obtain a **MapTiler API key**; set `EXPO_PUBLIC_MAPTILER_KEY` in env.
- Run `eas build --profile development` for android (and ios — ios needs a paid Apple
  Developer account + device registration).
- Install the dev client on a physical device and smoke-test the map there.
- Verify provider attribution renders (MapTiler/OSM attribution is required by license).

## Backend gaps (net-new — do NOT assume these exist)

### Gap A — bounded viewport pin query
`map.ts` pulls visible rows with no spatial filter. Needed:
- Minimum: lat/lng range filter by north/south/east/west + a sane limit/pagination.
- Preferred: PostGIS geometry column + `ST_Within`/bbox + spatial index (migration).
- Server-side privacy filtering must run inside this query, not on the client.

### Gap B — unified rich pin shape
Current `MapPin` ≈ `{ id, ownerId, tripId, title, category, lat, lng, city, isPrivate }`.
Target adds: `pinType, linkedEntityType, linkedEntityId, imageUrl, avatarUrl, trustLabel,
verified, neighborhood, privacyPrecision, distanceMeters, actionType, source`. This means
a migration **and** a normalization adapter that maps events / hidden gems / saved places
/ postcards / people / buddy-availability into one shape. Several of these sources are
fixture-only without coordinates today — those types defer until they have real coords.

### Gap C — image sources
Photo pins need each entity's real primary image; avatar pins need profile images.
**Never fabricate image URLs.** Pin types lacking a real image use the category-icon
fallback (already implemented in the prepared `DiscoveryMapLibreView.tsx`).

## Implementation phases (post-gate)

1. **Feasibility report + provider lock** — New-Arch check → MapLibre or Mapbox.
2. **EAS dev build path** — eas.json, dev-client, identifiers, permission strings.
   (Covered by the separate EAS setup task.)
3. **Install provider + MapTiler key** — packages + env. Owner runs builds.
4. **Swap renderer** — replace `react-native-maps` inside `DiscoveryMapView.tsx` with
   the prepared `DiscoveryMapLibreView.tsx` (or Mapbox variant). Keep the
   `places`/`onSelectPlace` contract so discovery.tsx is untouched.
5. **Backend Gap A** — bounded pin query + migration + server-side privacy filter.
6. **Backend Gap B** — rich pin schema + normalization adapter (only real-coord sources).
7. **People/avatar pins** — wire `listNearbyUsers` (approximate-by-default) onto the map.
8. **Bottom sheet** — extend `PlaceDetailSheet.tsx` with type-specific actions for the
   pin types actually present.
9. **Web** — either MapLibre GL JS for a real web map, or keep the honest fallback.
10. **Clustering + "search this area"** on the bounded query.
11. **Compass map-context adapter** — safe bounds/filters context only.
12. **Tests + device verification.**

## Prepared assets (ready to apply after the gate)
- `DiscoveryMapLibreView.tsx` — native MapLibre component (photo pins, category-icon
  fallback, honest empty/unconfigured states). **Will not typecheck/run until the
  provider package is installed.**
- `DiscoveryMapView.web.tsx` (updated) — honest web fallback, no native import.

## Honest status
The map is **not beta-blocking** (see `BETA_READINESS_CHECKLIST.md`). It is the highest
effort, lowest-urgency item: a functional beta needs sign-up, navigation, trips,
messaging, and non-crashing native features first. Build the map for v1.1 once real
users are in and the dev-build loop is established.
