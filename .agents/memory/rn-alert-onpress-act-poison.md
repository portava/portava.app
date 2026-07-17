---
name: RN Alert onPress inside act() poisons later renders
description: React 19 + RNTL — awaiting an async Alert-button onPress inside act() breaks every subsequent render in the jest file
---

**Rule:** In travel-buddy jest component tests, never `await act(async () => { await btn.onPress() })` for Alert confirmation buttons. Instead `await btn.onPress?.(); await act(async () => {});` (flush after, outside).

**Why:** Under React 19 + RNTL 14, awaiting the async onPress inside act() leaves the renderer in a state where every later `render()` in the same file mounts but never runs its effects — async loads never fire, so `findByText` times out with an empty tree. The symptom looks like a mock/setup bug but is renderer poisoning from the earlier test.

**How to apply:** In any pressAlertButton-style helper, await the onPress bare, then flush. Prefer `jest.spyOn(Alert, 'alert').mockImplementation(() => {})`. If a shared file is already poisoned and can't be fixed yet, put new suites in a separate `.component.test.tsx` file for a fresh renderer.

The jest setup (loaded via setupFilesAfterEnv in both trees) sets IS_REACT_ACT_ENVIRONMENT=true globally, so new test files don't need module-level workarounds — only the bare-onPress rule still applies.

**Also:** RNTL `render()` and `unmount()` are async in this setup (React 19 concurrent). An unawaited `unmount()` leaves a dangling act scope — "overlapping act()" warnings and every later render in the file never flushes its initial async load. Always `await render(...)` and `await unmount()`.
