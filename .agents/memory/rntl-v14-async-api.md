---
name: RNTL v14 async API
description: @testing-library/react-native v14 made render/rerender/fireEvent fully async — must be awaited or queries are undefined.
---

## Rule

Every RNTL v14 call that mutates or initialises the test tree must be `await`ed:

- `const result = await render(<Comp />)`
- `await rerender(<Comp />)`
- `await fireEvent.press(el)`
- `await fireEvent.changeText(el, text)`
- `const { result } = await renderHook(() => useMyHook())`

**Why:** RNTL v14 wraps all renderer mutations in `act()`, which is async in React 19. Calling `render(...)` or `renderHook(...)` without `await` returns a Promise. Destructuring from that Promise gives `undefined`, causing `TypeError: Cannot read properties of undefined (reading 'current')` for `renderHook` or `TypeError: getByTestId is not a function` for `render`.

**How to apply:** In every test file using RNTL v14:
- Mark `it(...)` callbacks `async`
- Make helper functions like `renderSheet(...)` `async` and `return await render(...)`
- Await every `fireEvent.*` call and every `renderHook(...)` call

**Also:** If a test fires an async action (e.g. form submit) via `fireEvent.press`, wrap the press in `act(async () => { await fireEvent.press(...) })` to flush the async state update (e.g. `setSaving(false)`) before the test ends — otherwise the state update leaks into the next test and can hang it.

The `screen` object also needs the awaited `render` to have fired before it registers the rendered tree; `screen.getByTestId(...)` without a prior awaited `render` throws `` `render` function has not been called ``.
