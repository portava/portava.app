/**
 * useScreenTiming.component.test.tsx
 *
 * Tests for the perf-timing hook, focusing on:
 *   1. Cold log on first markFirstContent() after initial focus.
 *   2. Warm log after a blur/refocus cycle — even when data hasn't changed.
 *   3. No double-log within the same focus cycle (marked.current guard).
 *   4. epoch increments on each focus so screens can use it as a useEffect dep.
 *
 * Strategy:
 *   The global expo-router mock (via moduleNameMapper) wraps useFocusEffect in
 *   a useEffect(cb, []) that fires once on mount.  We spy on the mock's
 *   useFocusEffect export to capture the callback and fire it manually,
 *   letting us simulate additional focus events without remounting the hook.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { useScreenTiming } from '../useScreenTiming.ts';
import * as ExpoRouter from 'expo-router';

// ── helpers ───────────────────────────────────────────────────────────────────

/** The callback registered by the most recent useFocusEffect call. */
let capturedFocusCb: (() => void) | undefined;

/** Call to simulate the screen gaining focus (fires the hook's focus handler). */
function triggerFocus() {
  act(() => {
    capturedFocusCb?.();
  });
}

// ── setup ─────────────────────────────────────────────────────────────────────

let logSpy: jest.SpyInstance;

beforeEach(() => {
  capturedFocusCb = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  // Spy on the mock's useFocusEffect so we can capture and re-fire the callback.
  // The spy stores the callback but does NOT fire it immediately — tests call
  // triggerFocus() explicitly so each test controls timing precisely.
  jest.spyOn(ExpoRouter, 'useFocusEffect').mockImplementation((cb) => {
    capturedFocusCb = cb as () => void;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

it('logs cold= on the first markFirstContent after focus', () => {
  const { result } = renderHook(() => useScreenTiming('TestScreen'));

  triggerFocus();
  act(() => { result.current.markFirstContent(); });

  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    expect.stringMatching(/\[PerfTiming\] TestScreen cold=\d+ms/),
  );
});

it('logs warm= after a blur/refocus cycle even without data mutation', () => {
  const { result } = renderHook(() => useScreenTiming('TestScreen'));

  // First focus — cold open
  triggerFocus();
  act(() => { result.current.markFirstContent(); });
  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('cold='));
  logSpy.mockClear();

  // Simulate blur + re-focus (data has NOT changed; only epoch changes)
  triggerFocus();

  // markFirstContent re-fires — should log warm, not cold
  act(() => { result.current.markFirstContent(); });
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(
    expect.stringMatching(/\[PerfTiming\] TestScreen warm=\d+ms/),
  );
});

it('does not log twice within the same focus cycle', () => {
  const { result } = renderHook(() => useScreenTiming('TestScreen'));

  triggerFocus();
  act(() => { result.current.markFirstContent(); });
  act(() => { result.current.markFirstContent(); }); // second call — no-op

  expect(logSpy).toHaveBeenCalledTimes(1);
});

it('epoch starts at 0 and increments by 1 on each focus so screens can use it as a dep', () => {
  const { result } = renderHook(() => useScreenTiming('TestScreen'));

  expect(result.current.epoch).toBe(0);

  triggerFocus();
  expect(result.current.epoch).toBe(1);

  triggerFocus();
  expect(result.current.epoch).toBe(2);
});
