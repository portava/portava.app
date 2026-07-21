---
name: Web-renderer Jest escape hatch
description: How to assert visual commits the jest-expo native React 19 renderer can't render (out-of-band event-bus setState) using jest-expo/web + react-dom
---

# Web-renderer escape hatch for the React 19 renderer wall

When a component's on-screen update comes from an out-of-band event-bus setState (e.g. a realtime notification listener), the jest-expo NATIVE renderer never commits it — mock-call-count wiring tests were the only option.

**The escape hatch:** run the same component under `jest-expo/web` (react-native-web + jsdom + real react-dom), where the commit works. Both travel-buddy trees have `jest.web.config.js` for this: only `*.webrender.test.{ts,tsx}` files run under it (main jest.config ignores that pattern), chained into `test:component`.

**How to apply:**
- Name the file `*.webrender.test.tsx`; render with `createRoot` + `act` from `react` (no RNTL); assert on `container.textContent`.
- jest-environment-jsdom resolves via jest-expo's own deps — no extra install needed.
- Config/package.json script wiring is per-tree (preserved mirror files); the test file itself lives in `src/` and auto-syncs.
- First proven on the CompassLive nudge card (event arrives → card text visible instantly).
