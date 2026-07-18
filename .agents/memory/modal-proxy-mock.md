---
name: Modal Proxy mock for react-native
description: How to test components that use react-native's <Modal> without async act() corruption
---

## The problem

react-native's `<Modal>` has an async animation/visibility lifecycle. When `<Modal visible={true}>` mounts, it posts a macrotask (rAF / setTimeout) for the slide animation. That macrotask fires an extra `popActScope` after RNTL's render() act scope closes, corrupting `actScopeDepth` and `IsSomeRendererActing`. Every subsequent explicit `act()` then fails to flush state updates → `waitFor` times out.

## The fix: Proxy mock for react-native

Replace Modal with a synchronous View using a Proxy that intercepts only the 'Modal' key. All other react-native exports (AccessibilityInfo, Platform, etc.) fall through via Reflect.get — required so RNTL itself doesn't break.

```tsx
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});
```

**Why Proxy over spread or Object.create:**
- `{ ...actual, Modal: … }` — spread misses non-enumerable getters, crashes RNTL
- `Object.create(actual)` — `_interopRequireWildcard` uses hasOwnProperty; inherited props may not reach callers
- Proxy + Reflect.get — transparent for every key regardless of enumerability

## Two-file rule

Even with the Proxy mock, pickPhoto's `act()` leaves residual overlapping-act warnings that corrupt screen's cleanup between tests. Each Modal-component test that does async operations must live in its own file (separate Jest workers).

## Reference files

- `artifacts/travel-buddy/src/components/__tests__/MemoriesTab.photoUploadFail.component.test.tsx`
- `artifacts/travel-buddy/src/components/__tests__/MemoriesTab.photoUploadSuccess.component.test.tsx`
- `artifacts/travel-buddy/src/components/__tests__/TESTING.md` (Rule 6)
