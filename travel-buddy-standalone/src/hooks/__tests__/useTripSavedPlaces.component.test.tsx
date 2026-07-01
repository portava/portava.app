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
  removeSavedFromList: jest.fn(),
}));

const { listSaved, clearAllSaved, toggleSave: toggleSaveMock, removeSavedFromList: removeSavedFromListMock } =
  jest.requireMock('../../services/discoveryBookmarks') as {
    listSaved: jest.Mock;
    clearAllSaved: jest.Mock;
    toggleSave: jest.Mock;
    removeSavedFromList: jest.Mock;
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

// ═══════════════════════════════════════════════════════════════════════════════
// toggle — add success
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — toggle add success', () => {
  it('returns true when toggleSave resolves true', async () => {
    const place = makePlace('p1');
    const { result } = await renderAndLoad([]);
    listSaved.mockResolvedValueOnce([place]);
    toggleSaveMock.mockResolvedValue(true);

    let returnVal!: boolean;
    await act(async () => {
      returnVal = await result.current.toggle(place);
    });

    expect(returnVal).toBe(true);
  });

  it('refreshes the list after a successful add', async () => {
    const place = makePlace('p2');
    const { result } = await renderAndLoad([]);
    // Post-toggle load returns the newly added place
    listSaved.mockResolvedValueOnce([place]);
    toggleSaveMock.mockResolvedValue(true);

    await act(async () => { await result.current.toggle(place); });

    await waitFor(() => expect(result.current.places).toHaveLength(1));
    expect(result.current.places[0].id).toBe('p2');
  });

  it('forwards the place and the hook-scoped tripId to toggleSave', async () => {
    const place = makePlace('q1');
    const { result } = await renderAndLoad([]);
    listSaved.mockResolvedValueOnce([]);
    toggleSaveMock.mockResolvedValue(true);

    await act(async () => { await result.current.toggle(place); });

    expect(toggleSaveMock).toHaveBeenCalledWith(place, 'trip-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// toggle — remove success
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — toggle remove success', () => {
  it('returns false when toggleSave resolves false', async () => {
    const place = makePlace('r1');
    const { result } = await renderAndLoad([place]);
    listSaved.mockResolvedValueOnce([]);
    toggleSaveMock.mockResolvedValue(false);

    let returnVal!: boolean;
    await act(async () => {
      returnVal = await result.current.toggle(place);
    });

    expect(returnVal).toBe(false);
  });

  it('refreshes the list after a successful remove', async () => {
    const place = makePlace('r2');
    const { result } = await renderAndLoad([place]);
    expect(result.current.places).toHaveLength(1);
    // Post-toggle load returns empty (place removed from storage)
    listSaved.mockResolvedValueOnce([]);
    toggleSaveMock.mockResolvedValue(false);

    await act(async () => { await result.current.toggle(place); });

    await waitFor(() => expect(result.current.places).toHaveLength(0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// toggle — storage error (silent-failure regression guard)
// ═══════════════════════════════════════════════════════════════════════════════
//
// If toggleSave throws, the error must reach the caller — silent swallowing
// here would leave the UI in a stale state with no way to surface an error.

describe('useTripSavedPlaces — toggle failure (storage error)', () => {
  it('propagates the error so the caller can surface it', async () => {
    const { result } = await renderAndLoad([makePlace('e1')]);
    toggleSaveMock.mockRejectedValue(new Error('disk full'));

    let caught: Error | undefined;
    await act(async () => {
      await result.current.toggle(makePlace('e1')).catch((e: Error) => { caught = e; });
    });

    expect(caught).toBeDefined();
    expect(caught?.message).toBe('disk full');
  });

  it('does not trigger a list refresh when toggleSave throws', async () => {
    // load() sits after `await toggleSave(...)` — a throw skips it entirely.
    // Verifying this prevents a regression where a misplaced load() call could
    // mask the error by triggering a silent state update.
    const { result } = await renderAndLoad([makePlace('e2')]);
    const callsBefore = listSaved.mock.calls.length;
    toggleSaveMock.mockRejectedValue(new Error('fail'));

    await act(async () => {
      await result.current.toggle(makePlace('e2')).catch(() => {});
    });

    expect(listSaved.mock.calls.length).toBe(callsBefore);
  });

  it('leaves the existing places list intact when toggleSave throws', async () => {
    const existing = [makePlace('s1'), makePlace('s2')];
    const { result } = await renderAndLoad(existing);
    expect(result.current.places).toHaveLength(2);
    toggleSaveMock.mockRejectedValue(new Error('storage error'));

    await act(async () => {
      await result.current.toggle(makePlace('s1')).catch(() => {});
    });

    // State must not change — no partial update should have occurred
    expect(result.current.places).toHaveLength(2);
    expect(result.current.places.map((p) => p.id)).toEqual(['s1', 's2']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// remove — success
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — remove success', () => {
  it('removes only the target place from the list after removeSavedFromList resolves', async () => {
    removeSavedFromListMock.mockResolvedValue(undefined);
    const { result } = await renderAndLoad([makePlace('p1'), makePlace('p2')]);
    expect(result.current.places).toHaveLength(2);

    await act(async () => { await result.current.remove(makePlace('p1')); });

    expect(result.current.places).toHaveLength(1);
    expect(result.current.places[0].id).toBe('p2');
  });

  it('calls removeSavedFromList with the place id and the hook-scoped tripId', async () => {
    removeSavedFromListMock.mockResolvedValue(undefined);
    const place = makePlace('p1');
    const { result } = await renderAndLoad([place]);

    await act(async () => { await result.current.remove(place); });

    expect(removeSavedFromListMock).toHaveBeenCalledWith(place.id, 'trip-1');
    expect(removeSavedFromListMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an empty list when the last place is removed', async () => {
    removeSavedFromListMock.mockResolvedValue(undefined);
    const { result } = await renderAndLoad([makePlace('only')]);

    await act(async () => { await result.current.remove(makePlace('only')); });

    expect(result.current.places).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// remove — rollback on failure
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — remove rollback on failure', () => {
  it('restores the original places list when removeSavedFromList rejects', async () => {
    removeSavedFromListMock.mockRejectedValue(new Error('disk full'));
    const { result } = await renderAndLoad([makePlace('p1'), makePlace('p2')]);

    await act(async () => {
      await result.current.remove(makePlace('p1')).catch(() => {});
    });

    expect(result.current.places).toHaveLength(2);
    expect(result.current.places.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('rethrows as remove_failed (not the raw storage error)', async () => {
    removeSavedFromListMock.mockRejectedValue(new Error('ENOENT'));
    const { result } = await renderAndLoad([makePlace('p1')]);

    let caught: Error | undefined;
    await act(async () => {
      await result.current.remove(makePlace('p1')).catch((e: Error) => { caught = e; });
    });

    expect(caught?.message).toBe('remove_failed');
  });

  it('rollback preserves all original place fields', async () => {
    removeSavedFromListMock.mockRejectedValue(new Error('fail'));
    const rich = makePlace('r1', { name: 'Full Place', category: 'restaurant', address: '1 Main St', type: 'food' });
    const { result } = await renderAndLoad([rich]);

    await act(async () => {
      await result.current.remove(makePlace('r1')).catch(() => {});
    });

    expect(result.current.places).toHaveLength(1);
    expect(result.current.places[0]).toMatchObject({ id: 'r1', name: 'Full Place', category: 'restaurant' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// remove — optimistic timing
// ═══════════════════════════════════════════════════════════════════════════════

describe('useTripSavedPlaces — remove optimistic timing', () => {
  it('drops the place from the list before removeSavedFromList resolves', async () => {
    let resolveRemove!: () => void;
    removeSavedFromListMock.mockReturnValue(
      new Promise<void>((res) => { resolveRemove = res; }),
    );

    const { result } = await renderAndLoad([makePlace('p1'), makePlace('p2')]);

    // Flush the synchronous optimistic setPlaces that fires before the first await
    await act(() => { void result.current.remove(makePlace('p1')); });
    expect(result.current.places.map((p) => p.id)).toEqual(['p2']);

    // Let storage complete — place stays gone on success
    await act(async () => { resolveRemove(); });
    expect(result.current.places.map((p) => p.id)).toEqual(['p2']);
  });

  it('restores the place before the storage rejection is handled', async () => {
    let rejectRemove!: (err: Error) => void;
    removeSavedFromListMock.mockReturnValue(
      new Promise<void>((_, reject) => { rejectRemove = reject; }),
    );

    const { result } = await renderAndLoad([makePlace('p1'), makePlace('p2')]);

    await act(() => { void result.current.remove(makePlace('p1')).catch(() => {}); });
    expect(result.current.places.map((p) => p.id)).toEqual(['p2']);

    await act(async () => { rejectRemove(new Error('disk error')); });
    expect(result.current.places.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
