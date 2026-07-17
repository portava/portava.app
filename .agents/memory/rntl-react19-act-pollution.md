---
name: RNTL/React 19 act-scope pollution from manual act wrappers
description: Avoid wrapping async Alert handlers in `act()` in React Native Testing Library v14 with React 19; it leaves nested act scopes that break subsequent tests.
---

# RNTL/React 19 act-scope pollution from manual act wrappers

## Rule

In React Native Testing Library v14 with React 19, do **not** wrap the async `onPress` handler of a mocked `Alert.alert` dialog in an explicit `act()` call. Invoke the handler directly and await it; the existing render/waitFor act scope will flush the resulting state updates.

```ts
// Bad — can leave an unresolved act scope and break the next test's render.
async function pressAlertButton(alertSpy, label) {
  const buttons = alertSpy.mock.calls.at(-1)[2];
  const btn = buttons.find((b) => b.text === label);
  await act(async () => { await btn.onPress?.(); });
}

// Good — let RNTL's own act scope manage flushes.
async function pressAlertButton(alertSpy, label) {
  const buttons = alertSpy.mock.calls.at(-1)[2];
  const btn = buttons.find((b) => b.text === label);
  await btn.onPress?.();
}
```

**Why:** RNTL's `render()` and `waitFor()` already manage the React act environment. Adding an extra `act()` around an async Alert handler can create a nested act scope that is not fully closed by the time the test finishes, causing the next test's initial `waitFor` to time out or state updates to be dropped. Removing the manual `act()` wrapper made the previously-failing `FailedJobsScreen` re-queue suite pass without changing the component or the assertions.

**How to apply:** When a test simulates an Alert confirmation whose handler performs async state updates (e.g. re-queue, delete), call the handler directly and await it. If warnings about unwrapped state updates still appear, address them by ensuring the component's async effects are awaited through `waitFor`/`findBy*`, not by adding more `act()` calls.
