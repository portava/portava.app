/**
 * Memory composer — location tagging component tests.
 *
 * Covers:
 *  1. The Location row opens the GlobalPlacePicker; a selection lands as a
 *     normalized Place in composer state (displayName shown in the row).
 *  2. Publish calls createMemory with the mapped location fields
 *     (locationCity/Country/Lat/Lng, placeId, canonicalLocationId).
 *  3. Clearing the location publishes with no location fields set.
 *
 * The picker itself is stubbed (its search/error behavior is covered by
 * GlobalPlacePicker.error.component.test.tsx); the stub emits a real Place
 * through the same onSelect contract the real picker uses.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import CreateMemoryScreen from '../../../app/memory/create.tsx';
import { createMemory } from '../../services/memories.ts';
import type { Place } from '../../lib/location/placeTypes.ts';

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));

jest.mock('../../services/memories', () => ({
  ...jest.requireActual('../../services/memories'),
  createMemory: jest.fn(),
  addMemoryItem: jest.fn(),
}));

const LISBON: Place = {
  id: 'nominatim:123',
  type: 'city',
  name: 'Lisbon',
  displayName: 'Lisbon, Portugal',
  country: 'Portugal',
  countryCode: 'PT',
  region: null,
  city: 'Lisbon',
  district: null,
  lat: 38.716,
  lng: -9.139,
  timezone: 'Europe/Lisbon',
  source: 'nominatim',
  canonicalId: '5b2a8a1e-9c7d-4a53-9a70-000000000001',
};

// Stub picker: when visible, renders a button that emits LISBON through the
// real onSelect contract.
// NOTE: intentionally exhaustive — the stub must replace the real component
// (requireActual would pull expo-location native internals).
jest.mock('../selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable, Text } = jest.requireActual('react-native');
  return {
    GlobalPlacePicker: ({ visible, onSelect, onClose }: any) =>
      visible
        ? ReactActual.createElement(
            Pressable,
            {
              testID: 'mock-pick-lisbon',
              onPress: () => {
                onSelect({
                  id: 'nominatim:123', type: 'city', name: 'Lisbon',
                  displayName: 'Lisbon, Portugal', country: 'Portugal',
                  countryCode: 'PT', region: null, city: 'Lisbon', district: null,
                  lat: 38.716, lng: -9.139, timezone: 'Europe/Lisbon',
                  source: 'nominatim',
                  canonicalId: '5b2a8a1e-9c7d-4a53-9a70-000000000001',
                });
                onClose();
              },
            },
            ReactActual.createElement(Text, null, 'pick lisbon'),
          )
        : null,
  };
});

const createMemoryMock = createMemory as jest.Mock;

beforeEach(() => {
  createMemoryMock.mockReset().mockResolvedValue({
    ok: true,
    memory: { id: 'mem-1' },
  });
});

async function renderWithLisbonSelected() {
  const utils = await render(<CreateMemoryScreen />);
  await fireEvent.press(utils.getByTestId('memory-location-row'));
  await fireEvent.press(utils.getByTestId('mock-pick-lisbon'));
  return utils;
}

describe('Memory composer — location tagging', () => {
  it('shows the placeholder before a location is chosen', async () => {
    const { getByText } = await render(<CreateMemoryScreen />);
    expect(getByText('Add a location (optional)')).toBeTruthy();
  });

  it('selecting a place shows its displayName in the Location row', async () => {
    const { getByText, queryByText } = await renderWithLisbonSelected();
    expect(getByText('Lisbon, Portugal')).toBeTruthy();
    expect(queryByText('Add a location (optional)')).toBeNull();
  });

  it('publish calls createMemory with the normalized location fields', async () => {
    const { getByText } = await renderWithLisbonSelected();
    await fireEvent.press(getByText('Publish'));
    await waitFor(() => expect(createMemoryMock).toHaveBeenCalledTimes(1));
    expect(createMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locationCity: 'Lisbon',
        locationCountry: 'Portugal',
        locationLat: LISBON.lat,
        locationLng: LISBON.lng,
        placeId: 'nominatim:123',
        canonicalLocationId: LISBON.canonicalId,
      }),
    );
  });

  it('clearing the location publishes without location fields', async () => {
    const { getByTestId, getByText } = await renderWithLisbonSelected();
    await fireEvent.press(getByTestId('memory-location-clear'));
    expect(getByText('Add a location (optional)')).toBeTruthy();
    await fireEvent.press(getByText('Publish'));
    await waitFor(() => expect(createMemoryMock).toHaveBeenCalledTimes(1));
    const payload = createMemoryMock.mock.calls[0][0];
    expect(payload.locationCity).toBeUndefined();
    expect(payload.placeId).toBeUndefined();
    expect(payload.canonicalLocationId).toBeUndefined();
  });
});
