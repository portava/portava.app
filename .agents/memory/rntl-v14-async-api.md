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

**Why:** RNTL v14 wraps all renderer mutations in `act()`, which is async in React 19. Calling `render(...)` without `await` returns a Promise. Destructuring `getByTestId` from a Promise gives `undefined`, then `TypeError: getByTestId is not a function` at the call site — not "element not found". `Object.keys(render(...))` will be empty (confirming the Promise diagnosis).

**How to apply:** In every test file using RNTL v14:
- Mark `it(...)` callbacks `async`
- Make helper functions like `renderSheet(...)` `async` and `return await render(...)`
- Await every `fireEvent.*` call

The `screen` object also needs the awaited `render` to have fired before it registers the rendered tree; `screen.getByTestId(...)` without a prior awaited `render` throws `` `render` function has not been called ``.
