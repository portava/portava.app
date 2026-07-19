---
name: MapLibre web platform splits
description: Any route-reachable component importing @maplibre/maplibre-react-native needs a .web.tsx sibling or the whole web app crashes at startup
---

Rule: every component that imports `@maplibre/maplibre-react-native` and is reachable from any expo-router route MUST have a `.web.tsx` sibling (web-safe variant with zero maplibre imports).

**Why:** maplibre-react-native v11 uses New Architecture codegen components; react-native-web has no working `codegenNativeComponent`, so merely importing the package on web throws `(0, _reactNativeWebDistIndex.codegenNativeComponent) is not a function`. Because expo-router statically requires every route file at startup, ONE missing split crashes the ENTIRE web app on every page — not just the map screen. Bundling succeeds; it's a runtime error, so "Web Bundled" in Metro logs proves nothing.

**How to apply:**
- New maplibre-importing component → create the `.web.tsx` fallback in the same commit (pattern: MapTab.web / DiscoveryMapView.web — same data layer + flat pin/grid substitute + "interactive map is mobile-only" note). ~13 precedents exist in src/.
- Importers of modules with platform siblings must use extensionless paths; an explicit `.tsx` extension bypasses Metro platform resolution. Both trees enforce this via `scripts/check-import-extensions.mjs`, which runs as part of `pnpm run typecheck` — bare `tsc --noEmit` is NOT the full typecheck.
- Transitive leaks count: importing even one small helper from a maplibre-importing file pulls maplibre in. Put shared helpers in their own file.
- To audit: rg for `@maplibre` importers, then trace each up to route files; files only imported by native map internals (already behind a .web split) are safe.
- Jest is unaffected either way: jest.config.js maps the maplibre package to a stub, and jest-expo (ios platform) never picks `.web.tsx`.
