---
name: Stale partial jest.mock factories
description: Per-file partial mocks crash suites when the component gains a new import/export the factory doesn't provide.
---

Rule: when a component gains a new import (an icon, a helper), any test that mocks the source module with a hand-written object literal starts failing with "X is not a function" or "Element type is invalid ... got: undefined".

**Why:** two standalone suites (StampStudioIndex, PassportIdentityCard) broke this way after components added a `Copy` icon and `truncateDisplayName` — the failures looked like render crashes, not mock drift.

**How to apply:** when a component test fails with "not a function" / "Element type invalid: undefined" right after a component change, check its `jest.mock()` factories first. Prefer `{ ...jest.requireActual(mod), override }` spreads where feasible; otherwise keep the factory in sync. Standalone component tests were converted to spreads (July 2026); lucide per-file overrides were deleted in favor of the global Proxy mock. Not spread-safe: modules importing @react-native-async-storage (e.g. discoveryBookmarks) — those stay exhaustive literals with a NOTE comment. The standalone setup (`travel-buddy-standalone/src/jest.setup.ts`) now provides global AsyncStorage + safe-area mocks, so device-module crashes are covered — module-drift crashes are not.
