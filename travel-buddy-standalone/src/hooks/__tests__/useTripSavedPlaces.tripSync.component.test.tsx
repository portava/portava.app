/**
 * WP-10 / TRIP-F25: useTripSavedPlaces shows the TRIP's list (crew saves +
 * this device's pending ones) and says when it cannot (census-trips §77, WP10-D1).
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useTripSavedPlaces } from '../useTripSavedPlaces.ts';
import type { BookmarkedPlace } from '../../services/discoveryBookmarks.ts';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useFocusEffect: jest.fn((cb: () => void) => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      React.useEffect(() => { cb(); }, []);
    }),
  };
});

jest.mock('../../services/discoveryBookmarks.ts', () => ({
  ...jest.requireActual('../../services/discoveryBookmarks.ts'),
  listSaved: jest.fn(),
  listLocalSaved: jest.fn(),
  toggleSave: jest.fn(),
  removeSavedFromList: jest.fn(),
  clearAllSaved: jest.fn(),
}));

jest.mock('../../features/trips/savedPlaces/tripSavedPlacesSync.ts', () => ({
  ...jest.requireActual('../../features/trips/savedPlaces/tripSavedPlacesSync.ts'),
  syncTripSavedPlaces: jest.fn(),
  removeTripSavedPlace: jest.fn(),
  applyTripSaveToggle: jest.fn(),
}));

const bm = jest.requireMock('../../services/discoveryBookmarks.ts') as Record<string, jest.Mock>;
const sync = jest.requireMock('../../features/trips/savedPlaces/tripSavedPlacesSync.ts') as Record<string, jest.Mock>;

const place = (id: string, extra: Record<string, unknown> = {}): BookmarkedPlace =>
  ({ id, name: `P ${id}`, category: 'food', type: null, address: null, savedAt: 1, listId: 't1', ...extra }) as BookmarkedPlace;
const tripSave = (id: string, extra: Record<string, unknown> = {}) =>
  ({ ...place(id), entryId: `e-${id}`, savedBy: 'me', mine: true, pending: false, ...extra });

async function load() {
  const hook = await renderHook(() => useTripSavedPlaces('t1'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
  bm.listLocalSaved.mockResolvedValue([place('pending-only')]);
  bm.listSaved.mockResolvedValue([place('a')]);
  bm.removeSavedFromList.mockResolvedValue(undefined);
  bm.clearAllSaved.mockResolvedValue(undefined);
  sync.applyTripSaveToggle.mockResolvedValue({ state: 'synced' });
});

it('merges this device\'s saves — including one only the device still holds — into the trip list and shows the crew\'s list', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'ok', places: [tripSave('a'), tripSave('x', { mine: false, savedBy: 'crew' })], pending: 0 });
  const { result } = await load();
  const [, sent] = sync.syncTripSavedPlaces.mock.calls[0]!;
  expect((sent as BookmarkedPlace[]).map((p) => p.id).sort()).toEqual(['a', 'pending-only']);
  expect(bm.listLocalSaved.mock.invocationCallOrder[0]).toBeLessThan(bm.listSaved.mock.invocationCallOrder[0]!);
  expect(result.current.places.map((p) => p.id)).toEqual(['a', 'x']);
  expect(result.current.syncLabel).toBeNull();
});

it('says how many saves are still waiting to reach the trip', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'ok', places: [tripSave('a', { entryId: null, pending: true })], pending: 1 });
  const { result } = await load();
  expect(result.current.syncLabel).toBe('1 waiting to sync');
});

it('when the trip\'s list cannot be read it shows this device\'s saves AND says so — never as the crew\'s list', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'unavailable', detail: 'HTTP 500' });
  const { result } = await load();
  expect(result.current.places.map((p) => p.id)).toEqual(['a']);
  expect(result.current.syncLabel).toBe('this device only');
  expect(result.current.error).toBeNull();
});

it('removing a save on the trip list deletes its row there; a refusal rolls back and throws remove_failed', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'ok', places: [tripSave('a'), tripSave('b')], pending: 0 });
  sync.removeTripSavedPlace.mockResolvedValueOnce({ state: 'done', data: null, status: 204 })
    .mockResolvedValueOnce({ state: 'refused', status: 403, reason: 'TRIP_AUTH_NOT_OWNER', detail: 'Cannot remove this saved place' });
  const { result } = await load();
  await act(async () => { await result.current.remove(result.current.places[0]!); });
  expect(sync.removeTripSavedPlace).toHaveBeenCalledWith('t1', expect.objectContaining({ entryId: 'e-a' }));
  expect(bm.removeSavedFromList).toHaveBeenCalledWith('a', 't1');
  let err: Error | undefined;
  await act(async () => { await result.current.remove(result.current.places[0]!).catch((e: Error) => { err = e; }); });
  expect(err?.message).toBe('remove_failed');
  expect(result.current.places.map((p) => p.id)).toEqual(['b']);
  expect(bm.removeSavedFromList).toHaveBeenCalledTimes(1);
});

it('toggle carries the change to the trip list', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'ok', places: [], pending: 0 });
  bm.toggleSave.mockResolvedValue({ added: true, synced: true });
  const { result } = await load();
  await act(async () => { await result.current.toggle(place('n')); });
  expect(sync.applyTripSaveToggle).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'n' }), true);
});

it('clear all removes only this member\'s rows from the trip list', async () => {
  sync.syncTripSavedPlaces.mockResolvedValue({ state: 'ok', places: [tripSave('a'), tripSave('x', { mine: false })], pending: 0 });
  sync.removeTripSavedPlace.mockResolvedValue({ state: 'done', data: null, status: 204 });
  const { result } = await load();
  await act(async () => { await result.current.clearAll(); });
  expect(sync.removeTripSavedPlace).toHaveBeenCalledTimes(1);
  expect(sync.removeTripSavedPlace).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'a' }));
});
