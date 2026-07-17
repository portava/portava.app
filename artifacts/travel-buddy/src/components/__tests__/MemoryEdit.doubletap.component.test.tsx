/**
 * Memory edit screen — double-tap guard on the Save button.
 *
 * ## What's covered
 *
 * Two rapid presses of the Save button before the first `updateMemory` call
 * resolves must produce exactly one PATCH — not two.
 *
 * The screen uses a `saveLock` ref (same pattern as the composer's
 * `publishLock`).  Because `saveLock.current` is set synchronously on the
 * first press, a second press that arrives before `updateMemory` resolves
 * finds the lock held and returns immediately without firing a second network
 * call.
 *
 * ## Why React state alone is insufficient
 *
 * `setSaving(true)` is an async state update — it only takes effect after the
 * next render.  A second tap that arrives before that re-render sees
 * `saving=false` and would bypass the `disabled` prop, calling `updateMemory`
 * a second time.  The synchronous ref prevents this without relying on the
 * render cycle.
 *
 * ## act() discipline (mirrors GlobalControlsPanel.doubletap.component.test.tsx)
 *
 * Every state-producing operation is wrapped in `await act(async () => {...})`:
 *
 *   - render + setTimeout(20): the 20 ms gap lets getMemory's microtask
 *     resolve within the act scope so setLoading(false) does not fire as a
 *     stray update after act exits, which would corrupt actScopeDepth.
 *
 *   - each fireEvent.press: wrapping ensures setSaving(true) is processed
 *     within the act scope.  Bare (unwrapped) presses leave the state update
 *     in an open internal act scope that leaks into subsequent tests.
 *
 *   - settleWith: resolves the deferred and waits 30 ms so handleSave's
 *     continuation (including setSaving(false) in the finally block) runs
 *     inside the act scope before the test ends.
 *
 * ## Deferred promises instead of mockResolvedValue
 *
 * Each test creates a controllable `{ promise, resolve }` pair for
 * updateMemory.  The call-count assertion happens synchronously after the
 * presses (both decisions are made before any microtask drains), and then
 * `resolve()` is called inside a `settleWith` act so handleSave completes
 * cleanly.  This avoids never-resolving mocks (which leave saving=true at
 * cleanup) and avoids fast-resolving mocks that fire setSaving(false) outside
 * any act scope between waitFor polls.
 *
 * ## Finding the Save button
 *
 * The Pressable has `testID="memory-edit-save-btn"`.  We use testID rather
 * than `getByText('Save')` because the first press immediately queues
 * `setSaving(true)` → next render swaps the "Save" label for an
 * ActivityIndicator, making subsequent `getByText('Save')` calls fail.
 * The testID stays stable across saving/idle states.
 */

import React from 'react';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react-native';
import EditMemoryScreen from '../../../app/memory/edit.tsx';
import { getMemory, updateMemory } from '../../services/memories.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'mem-test-id' }),
  router: { back: jest.fn() },
}));

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../services/memories', () => ({
  ...jest.requireActual('../../services/memories'),
  getMemory: jest.fn(),
  updateMemory: jest.fn(),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location and
// other native modules that crash under jest.  Its own behavior is tested
// separately in GlobalPlacePicker.error.component.test.tsx.
jest.mock('../selectors/GlobalPlacePicker', () => ({
  GlobalPlacePicker: () => null,
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

const LOADED_MEMORY = {
  id: 'mem-test-id',
  ownerId: 'user-1',
  title: 'Sunset in Lisbon',
  caption: 'Golden hour over the Tagus.',
  visibility: 'friends_only' as const,
  allowedUserIds: [],
  hiddenUserIds: [],
  tripId: null,
  eventId: null,
  placeId: null,
  locationCity: null,
  locationCountry: null,
  locationLat: null,
  locationLng: null,
  canonicalLocationId: null,
  startsAt: null,
  endsAt: null,
  state: 'published',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: null,
};

type UpdateResult = { ok: true; memory: typeof LOADED_MEMORY };

const getMemoryMock    = getMemory    as jest.Mock;
const updateMemoryMock = updateMemory as jest.Mock;

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getMemoryMock.mockReset().mockResolvedValue({ ok: true, memory: LOADED_MEMORY });
  updateMemoryMock.mockReset();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Renders EditMemoryScreen and waits for the loading phase to complete.
 *
 * The 20 ms gap inside the act scope lets getMemory's microtask resolve
 * (setLoading false, field population) within the same act, preventing those
 * state updates from leaking out as stray updates between tests.
 */
async function renderAndLoad() {
  await act(async () => {
    render(<EditMemoryScreen />);
    await new Promise<void>((r) => setTimeout(r, 20));
  });
  // Verify the form is visible after loading.
  screen.getByTestId('memory-edit-save-btn');
}

/**
 * Returns a controllable `{ promise, resolve }` pair for updateMemory.
 *
 * Call `resolve()` inside `settleWith` after making call-count assertions so
 * handleSave's continuation (setSaving(false) in the finally block) runs
 * within the act scope before the test ends.
 */
function deferred() {
  let resolve!: (v: UpdateResult) => void;
  const promise = new Promise<UpdateResult>((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Runs `setup` synchronously then waits 30 ms inside a single act scope.
 *
 * `setup` should call the deferred's resolve().  The resolve queues a
 * microtask for handleSave's continuation; that microtask fires before the
 * 30 ms setTimeout, so setSaving(false) runs inside the act scope.
 */
async function settleWith(setup: () => void) {
  await act(async () => {
    setup();
    await new Promise<void>((r) => setTimeout(r, 30));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('EditMemoryScreen — Save button double-tap guard', () => {

  it('single tap calls updateMemory exactly once', async () => {
    const d = deferred();
    updateMemoryMock.mockReturnValue(d.promise);

    await renderAndLoad();
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });

    expect(updateMemoryMock).toHaveBeenCalledTimes(1);

    await settleWith(() => d.resolve({ ok: true, memory: LOADED_MEMORY }));
  });

  it('rapid double-tap before first updateMemory resolves — called exactly once, not twice', async () => {
    const d = deferred();
    updateMemoryMock.mockReturnValue(d.promise);

    await renderAndLoad();

    // First press: handleSave runs synchronously to `await updateMemory()`,
    // setting saveLock.current=true before suspending.
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });
    // Second press: saveLock.current is already true → handleSave returns
    // immediately without calling updateMemory a second time.
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });

    expect(updateMemoryMock).toHaveBeenCalledTimes(1);

    await settleWith(() => d.resolve({ ok: true, memory: LOADED_MEMORY }));
  });

  it('triple rapid-tap fires updateMemory exactly once', async () => {
    const d = deferred();
    updateMemoryMock.mockReturnValue(d.promise);

    await renderAndLoad();

    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });

    expect(updateMemoryMock).toHaveBeenCalledTimes(1);

    await settleWith(() => d.resolve({ ok: true, memory: LOADED_MEMORY }));
  });

  it('lock releases after updateMemory returns ok:false — Save stays pressable for a retry', async () => {
    const d1 = deferred();
    const d2 = deferred();
    updateMemoryMock
      .mockReturnValueOnce(d1.promise)
      .mockReturnValue(d2.promise);

    await renderAndLoad();

    // First press — resolve with ok:false so the error message appears and
    // the screen stays mounted (no router.back() called).
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });
    await settleWith(() => d1.resolve({ ok: false, message: 'Server error' } as any));
    await waitFor(() => expect(screen.getByText('Server error')).toBeTruthy());

    // Lock must have released in the finally block — second press fires a new
    // updateMemory call rather than being silently discarded.
    await act(async () => { fireEvent.press(screen.getByTestId('memory-edit-save-btn')); });
    expect(updateMemoryMock).toHaveBeenCalledTimes(2);

    await settleWith(() => d2.resolve({ ok: true, memory: LOADED_MEMORY }));
  });

});
