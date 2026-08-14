/**
 * useMilestoneCelebration — once-per-threshold guard tests.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component -- --testPathPattern=useMilestoneCelebration
 *
 * ## What's covered
 *
 * The hook must play the celebration once when the user crosses a milestone
 * and never replay it after they dismiss.  The guard is an AsyncStorage key
 * (`@portava/stamp_milestone_v1_<level>`).
 *
 *  1. First mount with stampsEarned ≥ 100 and enabled=true → activeMilestone=100
 *     and the medium-haptic fires exactly once.
 *  2. Calling onDismiss writes the guard key to AsyncStorage.
 *  3. A second mount (new hook instance, identical props) with the guard key
 *     already present → activeMilestone=null (no replay).
 *
 * ## Render budget / React 19 notes (see src/components/__tests__/TESTING.md)
 *   - renderHook() is async and MUST be awaited.
 *   - Always flush with an empty async act() before reading result.current.
 *   - Animated.timing with useNativeDriver:true is synchronous under Jest
 *     (jest-expo stubs the native driver); no extra awaiting needed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useMilestoneCelebration } from '../useMilestoneCelebration.ts';
import * as Haptics from 'expo-haptics';

// NOTE: intentionally exhaustive — expo-haptics is a thin wrapper around
// native modules that are unavailable under Jest. All exports are replaced
// with jest.fn() stubs so tests never attempt a native bridge call.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// AsyncStorage is globally mapped by jest.config.js to the official jest mock
// (@react-native-async-storage/async-storage/jest/async-storage-mock).
// We spy on getItem/setItem per-test to control return values.

const impactAsyncSpy = Haptics.impactAsync as jest.Mock;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Storage key produced by the hook for the 100-stamp milestone. */
const KEY_100 = '@portava/stamp_milestone_v1_100';

/** Flush effects/microtasks so the hook's async IIFE settles. */
async function flushAsync() {
  await act(async () => {});
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no milestone has been seen yet.
  jest.spyOn(AsyncStorage, 'getItem').mockResolvedValue(null);
  jest.spyOn(AsyncStorage, 'setItem').mockResolvedValue(undefined);
});

afterEach(async () => {
  // Drain residual async state updates to prevent cross-test bleed.
  await act(async () => {});
});

// ── tests ─────────────────────────────────────────────────────────────────────

it('sets activeMilestone=100 and fires a medium haptic on the first mount', async () => {
  const { result } = await renderHook(() =>
    useMilestoneCelebration(100, true),
  );

  // Wait for the async guard check to settle.
  await waitFor(() => {
    expect(result.current.activeMilestone).toBe(100);
  }, { timeout: 1000 });

  // The 100-stamp tier uses a medium impact haptic.
  expect(impactAsyncSpy).toHaveBeenCalledTimes(1);
  expect(impactAsyncSpy).toHaveBeenCalledWith(
    Haptics.ImpactFeedbackStyle.Medium,
  );
});

it('writes the guard key to AsyncStorage when onDismiss is called', async () => {
  const setItemSpy = jest.spyOn(AsyncStorage, 'setItem').mockResolvedValue(undefined);

  const { result } = await renderHook(() =>
    useMilestoneCelebration(100, true),
  );

  await waitFor(() => {
    expect(result.current.activeMilestone).toBe(100);
  }, { timeout: 1000 });

  // Dismiss the celebration.
  await act(async () => {
    result.current.onDismiss();
  });

  // activeMilestone must reset to null immediately.
  expect(result.current.activeMilestone).toBeNull();

  // The guard key must have been written to AsyncStorage.
  expect(setItemSpy).toHaveBeenCalledWith(KEY_100, 'true');
});

it('produces activeMilestone=null on a second mount when the guard key is present', async () => {
  // Simulate the milestone having been seen: AsyncStorage already has the key.
  jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => {
    if (key === KEY_100) return 'true';
    return null;
  });

  const { result } = await renderHook(() =>
    useMilestoneCelebration(100, true),
  );

  // Give the async check time to resolve.
  await flushAsync();
  await flushAsync();

  // The milestone was already celebrated — no replay.
  expect(result.current.activeMilestone).toBeNull();

  // Haptics must NOT have fired a second time.
  expect(impactAsyncSpy).not.toHaveBeenCalled();
});

it('stays idle when stampsEarned=99 and enabled=true — no milestone fires below the threshold', async () => {
  const getItemSpy = jest.spyOn(AsyncStorage, 'getItem');

  const { result } = await renderHook(() =>
    useMilestoneCelebration(99, true),
  );

  // Flush any async work.
  await flushAsync();
  await flushAsync();

  // Below the 100-stamp threshold: no celebration.
  expect(result.current.activeMilestone).toBeNull();

  // No haptic should have been triggered.
  expect(impactAsyncSpy).not.toHaveBeenCalled();

  // AsyncStorage should not have been consulted — the threshold check short-circuits first.
  expect(getItemSpy).not.toHaveBeenCalled();
});

it('stays idle when stampsEarned=100 and enabled=false — own-profile guard respected', async () => {
  const getItemSpy = jest.spyOn(AsyncStorage, 'getItem');

  const { result } = await renderHook(() =>
    useMilestoneCelebration(100, false),
  );

  // Flush any async work.
  await flushAsync();
  await flushAsync();

  // enabled=false means we are not viewing the own profile — no celebration.
  expect(result.current.activeMilestone).toBeNull();

  // No haptic should have been triggered.
  expect(impactAsyncSpy).not.toHaveBeenCalled();

  // AsyncStorage should not have been consulted — enabled guard short-circuits first.
  expect(getItemSpy).not.toHaveBeenCalled();
});
