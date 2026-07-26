---
name: FlatList test contamination
description: React Native VirtualizedList leaves internal state after fireEvent interactions that zeros tiles in subsequent renders within the same jest worker.
---

# FlatList interaction tests poison subsequent renders

## Rule
All FlatList-dependent tests that use `fireEvent.press` or `fireEvent.scroll` on tiles must be in ONE describe block, and both interaction types must be combined into a SINGLE test case. Subsequent renders in separate `it()` blocks after any `fireEvent` on a FlatList child return 0 items.

**Why:** React Native's VirtualizedList has internal module-level or static state (frames cache, layout measurements) that is not reset by RNTL's `cleanup()`. After `fireEvent` + `await act()`, this state is corrupted so that the next `render()` of any FlatList renders 0 items.

**How to apply:**
- Put all FlatList render assertions (tile count, video guard) and all FlatList interactions (scroll, press) in a single `describe` block
- Combine multiple interaction assertions in a single `it()` that renders once and tests both scroll and press sequentially
- Tests that don't use `fireEvent` (pure math, non-FlatList) can live in separate describes

## FlatList testID is NOT queryable
`testID="grid-flatlist"` on a FlatList is NOT findable via `screen.getByTestId` in jest-expo's renderer — the testID propagates to the underlying ScrollView but RNTL's test renderer doesn't expose it as a queryable element. Use `screen.getByTestId` on mocked child tiles instead, or `fireEvent.scroll` on a tile (RNTL v14 propagates events up through the component tree).

## restoreAllMocks() breaks jest.mock() factories
`jest.restoreAllMocks()` in a `beforeEach` or `afterEach` can break `jest.mock()` module factories if Jest internally instruments the factory's exports as spies. Symptoms: tiles render 0 items or hooks return defaults after a `restoreAllMocks()` call in a previous test.

**Fix:** Never call `jest.restoreAllMocks()` in GridFeed or FlatList-heavy test files. Use direct property assignment (`router.push = jest.fn()`) instead of `jest.spyOn(router, 'push')` to avoid needing restoreAllMocks at all.
