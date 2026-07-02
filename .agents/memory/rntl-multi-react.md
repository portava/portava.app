---
name: RNTL component tests broken — multiple React instances
description: jest-expo + React 19 produces "Invalid hook call / null useState dispatcher" in ALL component tests; machine-layer is the working alternative
---

## The problem
All `.component.test.{ts,tsx}` files fail with:

```
TypeError: Cannot read properties of null (reading 'useState')
Invalid hook call. Hooks can only be called inside of the body of a function component.
```

This is the "multiple React instances" error — `ReactCurrentDispatcher.current` is null when
the component's `useState` runs. Affects every component test including `ReviewsSection.component.test.tsx`
(a pre-existing failure, not caused by new code).

## Root cause (suspected)
jest-expo preset + React 19.1 creates two React instances: one for the reconciler
(`react-reconciler`) and one loaded by the test file/component. The `renderer` and the
component's `react` module path resolve to different instances.

## Working alternative — machine-layer pattern
The project already uses this in `ReportPostSheet.test.ts`. Instead of rendering with RNTL:

1. Extract the press-handler or wiring contract into a pure function (e.g. `buildRentBuddyCtaUrl`,
   `simulateCtaPress`) in the helper module (zero imports).
2. Test with `node:test` + `tsx/esm` — no renderer needed.
3. The machine function is the exact code path the component uses; if the component
   diverges, test assertions break.

**Why:** The machine-layer approach avoids the multi-React problem entirely and runs faster
(no Babel transform, no React reconciler). It tests the exact wiring contract.

**How to apply:** For any new screen or component that needs a "screen-level" test,
extract the interactive logic into a pure function in a zero-import helper, then test
that function with node:test. Only use `.component.test.tsx` for pure UI snapshots or
simple isolated components with no service dependencies.
