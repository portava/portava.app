import AsyncStorage from '@react-native-async-storage/async-storage';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken } from './observedOwnerSessionFixture.ts';

jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners,
    onAuthStateChange: (listener: unknown) => {
      listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
  } } };
});
import { freshToken } from '../apiToken.ts';
import { pendingPlaceChanges, reconcileSavedPlaceRead, retryPendingPlaces, type PendingPlaceChange } from '../discoveryBookmarks.ts';
import { loadSavedPlaces, type SavedPlaceSummary } from '../savedPlaces.ts';
jest.mock('../apiToken.ts', () => ({ ...jest.requireActual('../apiToken.ts'), freshToken: jest.fn() }));
jest.mock('../discoveryBookmarks.ts', () => ({ ...jest.requireActual('../discoveryBookmarks.ts'),
  pendingPlaceChanges: jest.fn(), reconcileSavedPlaceRead: jest.fn(), retryPendingPlaces: jest.fn(),
}));
const ownerId = '10000000-0000-4000-a000-000000000001';
const sessionId = 'saved-place-session';
const key = `portava_saved_place_library_v1:${ownerId}`;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const place: SavedPlaceSummary = { key: 'osm:node/123', placeId: 'osm:node/123', collectionEntityId: null,
  title: 'Harbor Café', city: null, country: null, latitude: 0, longitude: 123, savedAt: null,
  sources: ['wishlist'], listIds: ['global'], collectionIds: [], pending: false };
const pending: PendingPlaceChange = { operationId: 'local-save', add: true, sent: false,
  place: { id: 'osm:way/456', name: 'New local café', category: 'food', type: null, address: null, savedAt: 1000, listId: 'trip-1' } };
const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
beforeEach(async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  setDiscoveryViewerFromSession(ownerId);
  seedObservedOwnerSession(ownerId, sessionId);
  jest.mocked(freshToken).mockResolvedValue(observedOwnerAccessToken(ownerId, sessionId));
  jest.mocked(retryPendingPlaces).mockResolvedValue(undefined);
  jest.mocked(pendingPlaceChanges).mockResolvedValue([]);
  jest.mocked(reconcileSavedPlaceRead).mockResolvedValue([]);
  await AsyncStorage.clear();
  await AsyncStorage.setItem(key, JSON.stringify([place]));
  jest.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
  jest.restoreAllMocks(); jest.clearAllMocks();
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});
it.each([404, 503, 200])('keeps local saves after an unreadable HTTP %s without calling it offline or clearing the cache', async (status) => {
  jest.mocked(fetch).mockResolvedValueOnce({ ...reply(null, status), json: async () => { throw new SyntaxError('HTML response'); } });
  jest.mocked(pendingPlaceChanges).mockResolvedValue([pending]);
  const result = await loadSavedPlaces();
  expect(result.state).toBe('unavailable');
  expect(result.places.map(p => p.placeId)).toEqual([pending.place.id, place.placeId]);
  expect(result.places[0]).toMatchObject({ pending: true, listIds: ['trip-1'] });
  expect(reconcileSavedPlaceRead).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(key)).toBe(JSON.stringify([place]));
});
it('labels a transport connection failure and preserves the initiating owner cache', async () => {
  jest.mocked(fetch).mockRejectedValueOnce(new TypeError('Network request failed'));
  expect(await loadSavedPlaces()).toMatchObject({ state: 'offline', places: [place] });
});
it.each([401, 403])('does not replace authoritative HTTP %s denial with private cached data', async status => {
  jest.mocked(fetch).mockResolvedValueOnce(reply({ message: 'denied' }, status));
  expect(await loadSavedPlaces()).toMatchObject({ state: 'unavailable', places: [] });
  expect(reconcileSavedPlaceRead).not.toHaveBeenCalled();
});
it('does not expose the previous account cache after an in-flight read fails', async () => {
  jest.mocked(fetch).mockImplementationOnce(async () => {
    setDiscoveryViewerFromSession('another-owner');
    throw new TypeError('Network request failed');
  });
  expect(await loadSavedPlaces()).toMatchObject({ state: 'unavailable', places: [] });
});
it('retains a newer local save when a successful server read has not seen it yet', async () => {
  jest.mocked(fetch).mockResolvedValueOnce(reply({ state: 'ready', places: [place], unavailableSources: [] }));
  jest.mocked(reconcileSavedPlaceRead).mockResolvedValue([pending]);
  const result = await loadSavedPlaces();
  expect(result.state).toBe('ready');
  expect(result.places.map(p => p.placeId)).toEqual([pending.place.id, place.placeId]);
  expect(result.places[0].pending).toBe(true);
  expect(reconcileSavedPlaceRead).toHaveBeenCalledWith(ownerId, [], [place]);
});
