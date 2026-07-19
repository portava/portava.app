---
name: Modal Proxy mock for react-native
description: How to mock react-native's Modal as a synchronous View in RNTL component tests, and the ActivityIndicator stub requirement.
---

## Rule
When a component test renders a component that uses react-native's `<Modal>`, mock `react-native` via a Proxy that intercepts `Modal` (and `ActivityIndicator`) while passing everything else through `Reflect.get`.

## Why
Modal's animation lifecycle leaves a floating async act() scope inside RNTL's render() promise. Any subsequent explicit act() call collides with that scope → "overlapping act() calls" → actScopeDepth corrupted → state updates never flush.

ActivityIndicator must also be stubbed: the Proxy calls `Reflect.get(target, prop, receiver)` with `receiver = Proxy` as `this`. In some jest-expo / RN 0.81 builds, ActivityIndicator is a getter that reads `this.NativeModules` through `this`. When `this` is the Proxy, those accesses re-enter Proxy.get and can reach uninitialized native-module stubs, causing a silent render error. React 19 rolls back the failed render, reverting all state in the same batch.

## How to apply
```ts
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  // Stable reference: same object every time so React never remounts
  const MockModal = ({ children, visible }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});
```

## Two-file rule
Two async Modal tests cannot coexist in the same file — test 1's act scopes corrupt the screen global, preventing test 2's render from rebinding it. Separate files → separate Jest workers → no shared state.

## React 19 + RNTL v14 state commit limitation
Synchronous state updates from the *first synchronous tick* of an async event handler (e.g. `setSaving(true)` before the first `await`) consistently fail to commit to the RNTL tree — no render error, no console warning. Async-continuation state updates (called after an `await`) reliably commit.

**Workaround for complex async flows:** assert on mock call counts rather than rendered state when the state change involves the synchronous pre-await portion. Document the limitation with a reference to this note.

## Renderer render-count limit (July 2026)
Beyond the two-file rule: in a single jest file, only the first ~2 `await render()` mounts flush reliably — the 3rd+ test's render mounts but queries see a stale/empty tree. Consolidate variations into ONE test using `await view.rerender(...)` with queries bound to the render result (`const view = await render(...)`), not the shared `screen`. Very late rerenders can also fail to commit — don't assert unmount-style negatives at the end of a long test.

## Mock-hygiene guard
`run-node-tests.mjs` (mobile-test workflow) fails the suite if a jest.mock factory is a bare object literal: either spread `jest.requireActual(...)` or put a `// NOTE: ...` comment directly above the `jest.mock(` line.
