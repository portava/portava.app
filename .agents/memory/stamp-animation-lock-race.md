---
name: Singleton animation lock + stale-ref race
description: An app-wide isAnimatingRef guard for a shared traveling-stamp animation can get stuck permanently, and its completion callback can read stale server state — both make a working tap handler look completely dead in production while unit tests pass.
---

## The lock can get stuck forever

`StampAnimationContext`'s `triggerStamp` guarded re-entrancy with a single
module/provider-level `isAnimatingRef` boolean shared by *every* cell in the
whole app (Watch feed, feed cards, etc. all call through one provider). If
any single animation's completion callback never runs to completion — e.g.
the cell that launched it gets unmounted mid-sequence by list virtualization
during a fast scroll, or a Reanimated worklet chain gets interrupted — the
ref is never reset. From that point on, *every* stamp tap anywhere in the
app becomes a silent no-op: the guard returns early before touching state,
before calling the API, before logging anything (unless you specifically
instrument that early-return branch).

**Why this matters:** a component-level test that mounts a single instance
of the animation pipeline in isolation will never reproduce this — it always
starts with a fresh, unlocked ref. The bug only shows up after the shared
provider has been through at least one interrupted animation, which usually
requires real scrolling/unmounting in the actual app.

**How to apply:** any shared/singleton "is this busy" ref that gates a
multi-step async/animated sequence needs a watchdog timeout that
force-resets the flag after a safe upper bound, regardless of whether the
normal completion path ever fires. Also add a log on the early-return branch
so a stuck lock is diagnosable from console output alone.

## The completion callback can race a still-in-flight API call

Separately, the animation's `onComplete` handler used to reconcile the
optimistic visual state to a `useRef` that was kept in sync with the toggle
hook's `isStamped`/`count` state via a `useEffect`. If the API round-trip for
the toggle took longer than the time between the optimistic update and
`onComplete` firing, `onComplete` would read the *stale pre-toggle* ref value
and revert the visual fill back to its original state — even though the
toggle had succeeded (or was still pending and would succeed shortly after).

**Why this matters:** the effect-mirrored ref updates on React's render
schedule, not on the promise's actual resolution — there's an inherent
window where the ref is stale relative to an in-flight request.

**How to apply:** when an animation's finalization step needs the "final
truth" of an async mutation, have the mutating function's own promise
resolve with the authoritative final value, and gate finalization on
`animationDone && promiseResolved` (whichever finishes second) — never on a
separately mirrored ref that can lag behind the promise it's supposed to
reflect.
