---
name: Stamp animation architecture
description: Screen-level traveling stamp animation — provider, context hook, StampButton state split, WatchItemOverlay migration, test fallback.
---

## Architecture

`StampAnimationProvider` is mounted in `_layout.tsx` (inside `StampEarnedToastProvider`).
It renders an `absoluteFill` `Animated.View` overlay with `pointerEvents="none"` — three
layers: shadow ellipse, traveling `StampIcon`, ink impression (`PortavaInkStamp` at content center).

The provider exposes `triggerStamp({ launchX, launchY, contentX?, contentY?, theme, onImpact, onComplete? })` via `useStampAnimationContext()`.

`useStampAnimation` now only handles the LOCAL button bounce (92% scale) and count-label spring pop. All traveling animation lives in the context.

## Delayed visual state pattern

`StampButton` and `WatchItemOverlay` both carry:
- `visualIsStamped` / `visualCount` — display state, NOT flipped on press
- `apiStateRef` — tracks latest API truth without stale closures
- `animatingRef` — prevents overlapping taps
- `onImpact` callback flips `visualIsStamped`/`visualCount` at ~TRAVEL_MS (400 ms)
- `onComplete` applies `apiStateRef.current` to catch any rollback that landed during animation

**Why:** spec requires hollow→filled happens AT impact, not on press.

## Test fallback

`useStampAnimationContext()` returns `NOOP_CONTEXT` (`{ triggerStamp: () => {}, isAnimating: false }`)
when called outside the provider — so isolated component tests never throw.
The real provider is always present in the running app via `_layout.tsx`.

**Why:** throwing broke every component test that renders any screen containing a StampButton or WatchItemOverlay, even when those tests don't care about the animation at all.

## Double-tap

`DoubleTapStampable` (both trees): `Gesture.Tap().numberOfTaps(2)` → `runOnJS(onDoubleTap)(event.absoluteX, event.absoluteY)`.
Content screens wire the callback to `triggerStamp()` from the context + a shared `useStamp` instance.

## Key constants (TRAVEL_MS, etc.)
- `TRAVEL_MS = 400` ms — button → content center
- `RETURN_DELAY_MS ≈ 525` ms from impact (squash + spring settle + hold)
- `RETURN_MS = 180` ms — return journey
- `STAMP_FULL_SIZE = 160` px — peak diameter
- `INK_HOLD_MS = 620` ms, `INK_FADE_MS = 380` ms

## Files changed
`travel-buddy-standalone/` (this listed both trees until `artifacts/travel-buddy` was archived at `bc1bef404`):
- `src/context/StampAnimationContext.tsx` — NEW
- `src/components/stamps/DoubleTapStampable.tsx` — NEW
- `src/hooks/useStampAnimation.ts` — stripped to bounce + count pop only
- `src/components/stamps/StampButton.tsx` — context integration + delayed state
- `src/components/media/WatchItemOverlay.tsx` — migrated, removed local PortavaInkStamp overlay
- `app/_layout.tsx` — added `<StampAnimationProvider>`
