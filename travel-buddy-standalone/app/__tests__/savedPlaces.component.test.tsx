import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SavedPlacesScreen from '../saved-places.tsx';
import { fileSavedPlace, loadSavedPlaces, type SavedPlaceSummary } from '../../src/services/savedPlaces.ts';
import { createCollection, readCollections, type Collection } from '../../src/services/collections.ts';
import { router } from 'expo-router';

// NOTE: the screen fixture stays focused while service responses change, without mounting an Expo navigation tree.
jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]) }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../src/hooks/usePrivateSurfaceKey', () => ({ ...jest.requireActual('../../src/hooks/usePrivateSurfaceKey'), usePrivateSurfaceKey: () => 'viewer1' }));
jest.mock('../../src/services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../src/services/messagingOwnerRequest.ts'),
  captureMessagingOwnerRequest: () => ({ ownerId: 'viewer1', isCurrent: () => true, invalidate: jest.fn() }) }));
jest.mock('../../src/services/savedPlaces', () => ({ ...jest.requireActual('../../src/services/savedPlaces'), loadSavedPlaces: jest.fn(), fileSavedPlace: jest.fn() }));
jest.mock('../../src/services/collections.ts', () => ({ ...jest.requireActual('../../src/services/collections.ts'), readCollections: jest.fn(), createCollection: jest.fn() }));
const cafe: SavedPlaceSummary = { key: 'p', placeId: 'canonical-id', collectionEntityId: null, title: 'Harbor Café',
  city: 'Cebu', country: 'Philippines', latitude: 0, longitude: 123.9, savedAt: null,
  sources: ['wishlist'], listIds: ['global'], collectionIds: ['old'], pending: true };
const collection = (id: string, name: string): Collection => ({ id, name, coverUrl: null, position: 0, itemCount: 0, isDefault: false, createdAt: '', updatedAt: '' });
beforeEach(() => { jest.resetAllMocks(); });
it('labels a successful empty library, and shows Retry instead of empty when the sources were unreadable', async () => {
 jest.mocked(loadSavedPlaces).mockResolvedValueOnce({ state: 'unavailable', places: [], unavailableSources: ['wishlist'] })
  .mockResolvedValueOnce({ state: 'ready', places: [], unavailableSources: [] });
 await render(<SavedPlacesScreen />);
 await screen.findByText('Some saved places could not be loaded.');
 expect(screen.queryByText('No saved places yet')).toBeNull();
 await fireEvent.press(screen.getByLabelText('Retry'));
 expect(await screen.findByText('No saved places yet')).toBeTruthy();
});
it('keeps cached rows on an offline read and opens their actual place with both coordinates', async () => {
 jest.mocked(loadSavedPlaces).mockResolvedValue({ state: 'offline', places: [cafe], unavailableSources: ['community'] });
 await render(<SavedPlacesScreen />);
 expect(await screen.findByText('Could not connect. Showing places saved on this device.')).toBeTruthy();
 expect(screen.getByText('Cebu, Philippines')).toBeTruthy();
 expect(screen.getByText('Waiting to sync')).toBeTruthy();
 await fireEvent.press(screen.getByLabelText('Open Harbor Café'));
 expect(router.push).toHaveBeenCalledWith({ pathname: '/place/[id]', params: { id: cafe.placeId, name: cafe.title, lat: '0', lng: '123.9' } });
});
it('uses the real collection picker to file a saved place into a newly created collection', async () => {
 jest.mocked(loadSavedPlaces).mockResolvedValue({ state: 'ready', places: [cafe], unavailableSources: [] });
 jest.mocked(readCollections).mockResolvedValue({ ok: true, data: [collection('old', 'Favorites')] });
 jest.mocked(createCollection).mockResolvedValue(collection('new', 'Weekend'));
 jest.mocked(fileSavedPlace).mockResolvedValue({ ok: true });
 await render(<SavedPlacesScreen />);
 await fireEvent.press(await screen.findByLabelText('Organize Harbor Café'));
 expect((await screen.findByLabelText('Saved to Favorites')).props.accessibilityState.selected).toBe(true);
 await fireEvent.press(screen.getByText('New collection'));
 await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Weekend');
 await fireEvent.press(screen.getByLabelText('Create and save'));
 await waitFor(() => expect(fileSavedPlace).toHaveBeenCalledWith(cafe.placeId, 'new'));
 expect(loadSavedPlaces).toHaveBeenCalledTimes(2);
});

it('keeps local places visible on a service failure without calling the phone offline', async () => {
 jest.mocked(loadSavedPlaces).mockResolvedValue({ state: 'unavailable', places: [cafe], unavailableSources: ['wishlist', 'community', 'collections'] });
 await render(<SavedPlacesScreen />);
 await screen.findByText('Saved places could not be refreshed. Showing places saved on this device.');
 expect(screen.getByText('Harbor Café')).toBeTruthy();
 expect(screen.queryByText(/Offline/)).toBeNull();
 expect(screen.getByLabelText('Retry')).toBeTruthy();
});
