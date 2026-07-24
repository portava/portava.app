---
name: uploadItem test-environment constraint (RESOLVED)
description: The setItems-as-reader pattern in uploadItem was fixed via useRef snapshot; tests now pass. uploadAll has the same pattern and still needs fixing.
---

# uploadItem test-environment constraint — RESOLVED

## What was fixed

`uploadItem` previously used a `setItems(updaterFn)` call as a synchronous state reader
to capture `currentItem`. This broke under React 19 concurrent mode in jest-expo because
eager evaluation requires `fiber.lanes === NoLanes`, which is never true after the first
`setItems` queues a lane.

**Fix applied:** Added `itemsRef = useRef<MediaItem[]>([])` kept fresh via
`useEffect(() => { itemsRef.current = items; }, [items])`. `uploadItem` now reads
`itemsRef.current.find(it => it.id === id)` before calling `setItems`, eliminating both
the second `setItems` reader call and the `await setTimeout(r, 0)` tick entirely.

## Remaining issue

`uploadAll` in `useMediaComposer.ts` still uses the same setItems-as-reader + setTimeout
pattern to collect idle item IDs. It should be updated to read from `itemsRef.current`
directly. (See follow-up task for this.)

**Why:** Same root cause — React 19 concurrent mode + fiber.lanes != NoLanes.

**How to apply:**
- `uploadItem` tests in `useMediaComposer.uploadUrl.component.test.tsx` are now active (no skip).
- For any new async state-read need in useMediaComposer, use `itemsRef.current` — never a setItems-as-reader pattern.
- `uploadAll` fix: replace the setItems block + setTimeout with `itemsRef.current.filter(it => it.uploadState === 'idle').map(it => it.id)`.
