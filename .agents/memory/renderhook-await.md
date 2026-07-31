---
name: renderHook must be awaited
description: renderHook() from @testing-library/react-native returns a Promise in jest-expo; not awaiting it leaves result.current undefined.
---

# renderHook must be awaited in jest-expo

## Rule
Always `await renderHook(...)` when using `@testing-library/react-native` in this project. A bare (non-awaited) call returns a Promise object; destructuring `{ result }` from it gives `result === undefined`, and `result.current` throws `TypeError: Cannot read properties of undefined (reading 'current')`.

**Why:** The jest-expo renderer wraps renderHook in an async act() internally. Other test environments may return synchronously, but this one does not.

**How to apply:**
```ts
// ✓ correct
const { result } = await renderHook(() => useMyHook());

// ✗ wrong — result is undefined
const { result } = renderHook(() => useMyHook());
```

If the hook triggers effects (e.g. an auto-fetch when `canTranslate` is true), `await renderHook` already flushes the initial render; a follow-up `await act(async () => {})` is generally NOT needed. But if the hook's effect fires an async call that updates state, await after renderHook covers the initial commit only — use `await waitFor(...)` for async state settled after the initial render.
