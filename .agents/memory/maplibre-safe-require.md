---
name: MapLibre safe-require pattern
description: All direct @maplibre/maplibre-react-native value imports must use a try-catch require instead of static import, or route registration crashes on any dev build where MLRNCameraModule isn't registered.
---

## The rule

Every `.tsx` file (non-.web.tsx) that directly imports VALUE exports from `@maplibre/maplibre-react-native` must use the safe-require pattern below, NOT a static `import`.

Static `import` triggers TurboModuleRegistry.getEnforcing('MLRNCameraModule') at module evaluation time. If the dev build doesn't have the module registered (older dev client, build predates native-module registration), the throw propagates up the entire module chain — any route that transitively depends on that file shows "missing default export" in the Expo Router, and the whole tab disappears from the navigation.

`import type { ... }` (type-only) is safe — no runtime effect, keep it.

## Safe pattern

```typescript
// Remove: import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
// Keep:  import type { ... } from '@maplibre/maplibre-react-native';  ← type imports are safe

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
```

For aliased imports (`Map as MapView`):
```typescript
const { Map: MapView, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
```

For inline `type` modifier in import (`{ Map, Camera, type CameraRef }`):
- Separate into `import type { CameraRef }` + safe-require for the values.

**Why:** If require fails, `_ml` is `{}` so all destructured values are `undefined`. TypeScript trusts the cast. At runtime, trying to RENDER a map screen will log "Element type invalid" but it won't crash at module evaluation time, so Expo Router successfully registers all routes.

## Files patched (both canonical + standalone)

- `src/components/location/MapLocationPicker.tsx`
- `src/components/location/MeetupAreaPreview.tsx`
- `src/components/discovery/DiscoveryMapView.tsx`
- `src/components/discovery/GemMapPreview.tsx`
- `src/components/discovery/TravelerMapLayer.tsx`
- `src/components/circle/CircleMapSection.tsx`
- `src/components/compass/CompassMiniMap.tsx`
- `src/components/itinerary/MapView.tsx`
- `src/components/gems/GemLocationPreview.tsx`
- `src/components/passport/DestinationsTab.tsx`
- `src/components/map/EntityMarkers.tsx`
- `src/components/trip/LocationCheckMapPicker.tsx`
- `src/components/SavedPlacesMapView.tsx`
- `src/components/MapTab.tsx`

`.web.tsx` stubs do NOT need the change — they don't import the native module at all.

**Why:** Route registration failure from missing MLRNCameraModule was identified as the root cause of Discovery, Passport, and AI tabs disappearing after a merge wave. Symptom: "[Layout children]: No route named 'discovery' exists in nested children" logged after iOS bundle loads.
