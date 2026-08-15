---
name: DisplayMediaImage URI-change reset order
description: Both phase and resolvedSource must reset together on URI prop change; useState order matters.
---

## Rule
In `DisplayMediaImage`, the `resolvedSource` `useState` declaration must appear **before** the `prevUri` guard that calls both `setPhase` and `setResolvedSource`. React's rules of hooks require all hooks to be declared before they are used; violating this causes a TypeScript TDZ error and a runtime crash.

**Why:** A prior fix moved `setResolvedSource(...)` into the `prevUri` guard (to reset both `phase` and `resolvedSource` together when the URI prop changes) but placed the `useState` call after the guard. This caused TS2448/TS2454 errors and the guard silently never ran — leaving Discovery place cards for OSM-only destinations stuck in error phase after the initial fallback WebP 404'd.

**How to apply:** Whenever adding a render-phase `setState` call (inside a `if (prevRef.current !== prop)` guard), ensure the corresponding `useState` is declared above the guard in the component body, not below it.

## The bug it fixed (OSM place cards showing no photo)
- OSM places have no `headerImageUrl` in `discovery_places` — they rely entirely on a 500 ms deferred FSQ proxy call.
- `resolveHeaderImage` returns the category fallback WebP (`/assets/fallbacks/generic-place.webp`) as the initial URI.
- In the Expo web dev server, that path 404s (assets are served at content-hashed paths).
- ExpoImage fires `onError` → `phase = 'error'`.
- 500 ms later, PlaceCard re-renders with the real FSQ URL as the new URI prop.
- Pre-fix: only `setPhase('loading')` was reset; `resolvedSource` still held the old fallback URL → ExpoImage tried the old URL → another 404 → stayed in `error` phase → FSQ photo never rendered.
- Post-fix: both `setPhase` and `setResolvedSource` are called in the guard; ExpoImage loads the correct URL on the next render.
