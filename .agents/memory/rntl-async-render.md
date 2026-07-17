---
name: RNTL render must be awaited
description: In travel-buddy jest component tests, render() is async — call `await render(...)` or screen stays unbound.
---

In the travel-buddy jest setup (RNTL v14 + test-renderer 1.x + React 19), `render()` from
`@testing-library/react-native` returns a promise. Calling it without `await`:

- leaves the shared `screen` object unbound → "`render` function has not been called", or
- reads a stale tree from a prior test → "Cannot access .container on unmounted test renderer".

**How to apply:** always `await render(<X />)` in `*.component.test.tsx`, and drain concurrent work
in `afterEach` with `await act(async () => {})` (existing tests like GeocodeCacheScreen follow this
pattern). No synchronous `render()` call works in this suite.
