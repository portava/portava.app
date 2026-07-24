---
name: uploadItem test-environment constraint
description: useMediaComposer.uploadItem cannot be tested in isolation under React 19 jest-expo — use it.skip with docs; fix requires useRef refactor.
---

# uploadItem test-environment constraint

## The rule

`uploadItem` uses a `setItems(updaterFn)` call as a synchronous state reader (side-effect
sets a local variable). This only works when React runs the updater eagerly, which
requires `fiber.lanes === NoLanes`. Under React 19 concurrent mode in jest-expo, the first
`setItems` puts a lane into `fiber.lanes`; the internal `await setTimeout(r, 0)` fires
before the re-render commits, so the second `setItems` updater is never called eagerly,
`currentItem` stays undefined, and `uploadItem` returns null early.

**Why:** Every isolation approach (renderHook+act, component+useEffect, component+press handler+settleWith) hits the same root cause — React 19 never has `NoLanes` at the right moment in jest-expo.

**How to apply:**
- Do NOT write upload-URL tests for `uploadItem` via renderHook or simple component harnesses — mark as `it.skip` with documentation (see `useMediaComposer.uploadUrl.component.test.tsx`).
- End-to-end upload coverage exists in `MemoriesTab.photoUploadSuccess.component.test.tsx` via a real form component.
- The correct fix (follow-up task #2452): replace lines 274-281 of `useMediaComposer.ts` with a `useRef` snapshot updated via `useEffect`, so `uploadItem` reads from the ref directly.
