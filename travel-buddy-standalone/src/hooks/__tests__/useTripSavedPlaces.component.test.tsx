/**
 * useTripSavedPlaces.component.test.tsx
 *
 * Covers the hook's clearAll contract:
 *   1. success path — optimistic empty, storage called once
 *   2. rollback on failure — state restored, error rethrown as clear_failed
 *   3. optimistic timing — empty lands before storage resolves/rejects
 *
 * Alert confirmation gate tests live in TripSavedPlacesSection.component.test.tsx
 * because they must exercise the real handleClearAll in the production component.
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useTripSavedPlaces } from '../useTripSavedPlaces';
import type { BookmarkedPlace } from '../../services/discoveryBookmarks';

jest.mock('../../services/discoveryBookmarks', () => ({
  listSaved: jest.fn(),
  clearAllSaved: jest.fn(),
  toggleSave: jest.fn(),
}));

const { listSaved, clearAllSaved } =
  jest.requireMock('../../services/discoveryBookmarks') as {
    listSaved: jest.Mock;
    clearAllSaved: jest.Mock;
  };

function makePlace(id: string, overrides: Partial<BookmarkedPlace> = {}): BookmarkedPlace {
  return { id, name: 'Test Place', category: 'food', savedAt: 1000, address: null, type: null, ...overrides };
}

async function renderAndLoad(initial: BookmarkedPlace[]) {
  listSaved.mockResolvedValue(initial);
  const hook = await renderHook(() => useTripSavedPlaces('trip-1'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAllSaved.mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// clearAll — success
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — clearAll success', () => {
  it('empties the places list after clearAllSaved resolves', async () => {
    const { result } = await renderAndLoad([makePlace('a'), makePlace('b')]);
    expect(result.current.places).toHaveLength(2);

    await act(async () => {
      await result.current.clearAll();
    });

    expect(result.current.places).toHaveLength(0);
  });

  it('calls clearAllSaved exactly once per clearAll invocation', async () => {
    const { result } = await renderAndLoad([makePlace('a')]);

    await act(async () => {
      await result.current.clearAll();
    });

    expect(clearAllSaved).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// clearAll — rollback on failure
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — clearAll rollback on failure', () => {
  it('restores the full places list when clearAllSaved rejects', async () => {
    clearAllSaved.mockRejectedValue(new Error('storage error'));
    const { result } = await renderAndLoad([makePlace('p1'), makePlace('p2')]);
    expect(result.current.places).toHaveLength(2);

    // Wait for the rejection to settle (signals rollback ran).
    // We verify the *final* state: React 18 may batch the optimistic setPlaces([])
    // and the rollback setPlaces(snapshot) together when rejection is immediate, so
    // the 0 state may never be observable.  The timing suite uses a deferred mock
    // to verify the intermediate state separately.
    let error: Error | undefined;
    await act(async () => {
      await result.current.clearAll().catch((e: Error) => { error = e; });
    });

    expect(result.current.places).toHaveLength(2);
    expect(result.current.places.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(error).toBeDefined();
  });

  it('re-throws as clear_failed (not the raw storage error)', async () => {
    clearAllSaved.mockRejectedValue(new Error('ENOENT'));
    const { result } = await renderAndLoad([makePlace('x')]);

    let caughtError: Error | undefined;
    await act(async () => {
      await result.current.clearAll().catch((e: Error) => { caughtError = e; });
    });

    expect(caughtError?.message).toBe('clear_failed');
  });

  it('rollback preserves all original place fields', async () => {
    clearAllSaved.mockRejectedValue(new Error('fail'));
    const richPlace = makePlace('r1', {
      name: 'Full Place',
      category: 'restaurant',
      address: '123 Main St',
      type: 'food',
    });
    const { result } = await renderAndLoad([richPlace]);

    await act(async () => {
      await result.current.clearAll().catch(() => {});
    });

    expect(result.current.places).toHaveLength(1);
    expect(result.current.places[0]).toMatchObject({
      id: 'r1',
      name: 'Full Place',
      category: 'restaurant',
      address: '123 Main St',
      type: 'food',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// clearAll — optimistic update timing
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — clearAll optimistic update timing', () => {
  it('empties the list before the storage promise resolves', async () => {
    let resolveSaved!: () => void;
    clearAllSaved.mockReturnValue(new Promise<void>((res) => { resolveSaved = res; }));

    const { result } = await renderAndLoad([makePlace('t1'), makePlace('t2')]);
    expect(result.current.places).toHaveLength(2);

    // Await the sync act so React flushes the optimistic setPlaces([]) that fires
    // synchronously before clearAll's first `await clearAllSaved()` suspends.
    await act(() => { void result.current.clearAll(); });
    // setPlaces([]) has been flushed — list is empty before storage resolves
    expect(result.current.places).toHaveLength(0);

    // Now let storage finish — places should stay empty (success path)
    await act(async () => { resolveSaved(); });
    expect(result.current.places).toHaveLength(0);
  });

  it('restores places before the storage rejection is handled', async () => {
    let rejectStorage!: (err: Error) => void;
    clearAllSaved.mockReturnValue(
      new Promise<void>((_, reject) => { rejectStorage = reject; }),
    );

    const { result } = await renderAndLoad([makePlace('r1'), makePlace('r2')]);
    expect(result.current.places).toHaveLength(2);

    // Await the sync act to flush the optimistic setPlaces([])
    await act(() => { void result.current.clearAll().catch(() => {}); });
    expect(result.current.places).toHaveLength(0);

    // Reject storage — rollback sets places back to the original list
    await act(async () => { rejectStorage(new Error('disk error')); });
    expect(result.current.places).toHaveLength(2);
  });
});
