---
name: RNTL Alert-button act() overlap
description: Why wrapping an async Alert onPress in awaited act() breaks all later renders in a jest-expo test file
---

In travel-buddy component tests (React 19 + RNTL + jest-expo), wrapping an async Alert confirm handler in `await act(async () => { await btn.onPress() })` overlaps with FlatList/VirtualizedList internal timers, producing "overlapping act() calls" warnings — and worse, it corrupts the act environment so every subsequent `render()` in the same file never flushes its initial async load (findByText times out with the element missing).

**Why:** React 19 rejects nested/overlapping act scopes; the VirtualizedList timer fires inside the awaited act and leaves a dangling scope.

**How to apply:** invoke the Alert button's `onPress()` WITHOUT act, then assert outcomes with `waitFor(...)`. Also note existing suites that use the awaited-act pattern may already be silently failing later tests.

Also: mobile jest testMatch covers both `src/**` and `app/**` `*.component.test.{ts,tsx}` (app/ was added for co-located screen tests).

## Render-order poisoning (July 2026, event-room tests)
Under React 19 + RNTL, some component tests corrupt the act environment for ALL later renders in the same file — subsequent `render()` calls never flush effects (mount fetches show 0 calls) or SectionList rows never appear. Flushing with extra `act()` / real-timer sleeps does NOT fix it. Observed polluters: an Alert-driven moderation flow, and rendering a card while the mocked call state holds a foreign in-progress session. Fix: reorder the file so polluting tests run LAST (leave a NOTE comment explaining why).
