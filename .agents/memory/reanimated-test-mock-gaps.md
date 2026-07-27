---
name: Reanimated test mock gaps
description: Three recurring gaps in Reanimated jest mocks that crash or silently misbehave when hooks like useCollapsingHeader are added to a screen.
---

## The three gaps

**1. `useReducedMotion` absent from the default mock**
Reanimated's own `mock.ts` has `// useReducedMotion: ADD ME IF NEEDED` (commented out). Any hook that calls `useReducedMotion()` throws `TypeError: useReducedMotion is not a function` in tests that rely on the default mock. Fix: create a module-level safe wrapper in the hook:
```ts
import { useReducedMotion as _useReducedMotion } from 'react-native-reanimated';
const safeUseReducedMotion: () => boolean =
  (typeof _useReducedMotion === 'function' ? _useReducedMotion : () => false) as () => boolean;
```
Then call `safeUseReducedMotion()` inside the hook body.

**2. Per-file Reanimated mocks miss `useAnimatedReaction`, `runOnJS`, `useReducedMotion`**
Tests that supply their own full `jest.mock('react-native-reanimated', ...)` block replace the default mock entirely — including `useAnimatedReaction: NOOP` and `runOnJS: ID` that the default provides. If the tested component calls any of these (e.g. via `useCollapsingHeader`), they're `undefined`. Add them to every per-file Reanimated mock:
```js
useAnimatedReaction: () => {},
runOnJS: (fn) => fn,
useReducedMotion: () => false,
```

**3. `makeMutable(0)` returns `0` (identity), not `undefined` — `??` fallback misses it**
The default Reanimated mock maps `makeMutable` to the identity function (`ID = v => v`). So `makeMutable(0) === 0` — a falsy but **non-nullish** number. A module-level guard like `navBarProgress ?? { value: 0 }` won't fire because `0` is not nullish. To guard a SharedValue import from the mock environment, check `.value` existence:
```ts
const _progress: { value: number } =
  (navBarProgress as { value: number } | undefined) ?? { value: 0 };
```
This works for the "mock omits the export entirely" case (undefined) but NOT for the identity-function case where `navBarProgress = 0`. The real fix in that case is to ensure the `useNavBarCollapse` mock always includes `navBarProgress: { value: 0 }`.

**Why:**
Added `useCollapsingHeader` hook to all four primary tab screens. All three gaps surfaced at once when existing component tests imported those screens without updating their mocks.

**How to apply:**
- Any new hook that calls `useReducedMotion` → add the module-level `safeUseReducedMotion` wrapper.
- Any screen gaining `useCollapsingHeader` (or similar Reanimated hooks) → audit all existing component tests for that screen; add the three missing exports to per-file Reanimated mocks.
- `useNavBarCollapse` mocks → always include `navBarProgress: { value: 0 }`.
