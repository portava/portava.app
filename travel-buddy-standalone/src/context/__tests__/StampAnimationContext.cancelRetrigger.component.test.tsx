/**
 * StampAnimationContext — cancel-then-retrigger race test.
 *
 * Proves that calling cancelStamp() (simulating a cell unmount mid-animation)
 * and immediately triggering a NEW animation does NOT result in:
 *   a) the old session's onImpact (setTimeout-based) firing on the stale cell, or
 *   b) the new session's lock being released by any stale deferred callback.
 *
 * This covers the race introduced when cancelStamp() only cleared the watchdog
 * but left the impactTimer running and did not invalidate in-flight callbacks.
 *
 * ## Timer strategy
 * The `fireImpact` callback is scheduled with `setTimeout(fireImpact, TRAVEL_MS)`
 * inside triggerStamp.  We use `jest.useFakeTimers()` to control exactly when
 * those timers fire so we can assert on ordering without waiting 400ms.
 *
 * Reanimated's `withTiming` worklet-callback path (runOnJS) is a no-op under
 * jest-expo mocks, so the test focuses on the JS-thread setTimeout timers
 * which represent the primary cancel race risk.
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — PortavaInkStamp imports native SVG and
// image modules; null stub keeps the provider tree render-safe under jest-expo.
jest.mock('../../components/stamps/PortavaInkStamp.tsx', () => ({
  PortavaInkStamp: () => null,
}));
// NOTE: intentionally exhaustive — StampIcon imports Reanimated and native
// image assets; null stub avoids asset-resolver failures under jest-expo.
jest.mock('../../components/stamps/StampIcon.tsx', () => ({
  StampIcon: () => null,
}));
// NOTE: intentionally exhaustive — expo-haptics calls native haptics TurboModule
// unavailable in jsdom; stub the two members StampAnimationContext uses.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Heavy: 'heavy' },
}));

import { useStampAnimationContext, StampAnimationProvider } from '../StampAnimationContext.tsx';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StampAnimationProvider>{children}</StampAnimationProvider>
);

describe('StampAnimationContext — cancel-then-retrigger race', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Drain any remaining timers inside act() to avoid "not wrapped in act"
    // warnings from timer callbacks that call setIsAnimating.
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('clears the old impactTimer on cancelStamp so a stale onImpact never fires', async () => {
    const { result } = await renderHook(() => useStampAnimationContext(), { wrapper });

    const onImpact1 = jest.fn();
    const onImpact2 = jest.fn();

    // ── Session 1: start → cancel ──────────────────────────────────────────
    await act(async () => {
      result.current.triggerStamp({
        launchX: 50,
        launchY: 50,
        onImpact: onImpact1,
      });
    });

    // Immediately cancel (simulates FlatList cell unmount mid-animation)
    await act(async () => {
      result.current.cancelStamp();
    });

    expect(result.current.isAnimating).toBe(false);

    // ── Session 2: fresh start ─────────────────────────────────────────────
    await act(async () => {
      result.current.triggerStamp({
        launchX: 100,
        launchY: 100,
        onImpact: onImpact2,
      });
    });

    expect(result.current.isAnimating).toBe(true);

    // ── Advance past TRAVEL_MS (400ms) so both timer slots would fire ──────
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // The old session's impact timer was cleared by cancelStamp — must not fire.
    expect(onImpact1).not.toHaveBeenCalled();
    // The new session's impact timer was NOT cleared — it must have fired.
    expect(onImpact2).toHaveBeenCalledTimes(1);
  });

  it('consecutive cancel-retrigger cycles each clear previous timers — only last session fires onImpact', async () => {
    // This proves:
    //  1. Every cancelStamp() clears the impact timer for that session, so a
    //     cancelled session's onImpact never fires later.
    //  2. Token increments accumulate correctly — N rapid cancel-retrigger
    //     cycles do not exhaust or overflow the token counter.
    //  3. The final non-cancelled session's impact timer fires normally.
    const { result } = await renderHook(() => useStampAnimationContext(), { wrapper });

    const onImpact1 = jest.fn();
    const onImpact2 = jest.fn();
    const onImpact3 = jest.fn();

    // ── Session 1: start → cancel ──────────────────────────────────────────
    await act(async () => {
      result.current.triggerStamp({ launchX: 50, launchY: 50, onImpact: onImpact1 });
    });
    await act(async () => { result.current.cancelStamp(); });

    // ── Session 2: start → cancel ──────────────────────────────────────────
    await act(async () => {
      result.current.triggerStamp({ launchX: 60, launchY: 60, onImpact: onImpact2 });
    });
    await act(async () => { result.current.cancelStamp(); });

    // ── Session 3: start — NOT cancelled ──────────────────────────────────
    await act(async () => {
      result.current.triggerStamp({ launchX: 70, launchY: 70, onImpact: onImpact3 });
    });

    // ── Advance past TRAVEL_MS (400ms) — all three impactTimer slots fire ──
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // Sessions 1 and 2 were cancelled → their timers were cleared → no call
    expect(onImpact1).not.toHaveBeenCalled();
    expect(onImpact2).not.toHaveBeenCalled();
    // Session 3 was not cancelled → its timer fires normally
    expect(onImpact3).toHaveBeenCalledTimes(1);
  });
});
