/**
 * GlobalPlacePicker — search-failure fallback component tests.
 *
 * Covers:
 *  1. When /api/places/search fails, the picker shows the inline
 *     "Couldn't load suggestions" error row instead of appearing broken.
 *  2. A Retry button is shown and re-runs the search (bumps refreshKey).
 *  3. The custom free-text row stays available, so the user can still tag a
 *     typed location name.
 *  4. The generic "No places found" empty state is NOT shown while errored.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker.tsx';
import { usePlaceSearch } from '../../hooks/usePlaceSearch.ts';

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — only these APIs are used by the picker, and
// the real expo-location requires native modules unavailable under jest.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getLastKnownPositionAsync: jest.fn().mockResolvedValue(null),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

jest.mock('../../hooks/usePlaceSearch', () => ({
  ...jest.requireActual('../../hooks/usePlaceSearch'),
  usePlaceSearch: jest.fn(),
}));

jest.mock('../../hooks/useRecentPlaces', () => ({
  ...jest.requireActual('../../hooks/useRecentPlaces'),
  useRecentPlaces: () => ({ recents: [], saveRecent: jest.fn() }),
}));

jest.mock('../../hooks/usePopularCities', () => ({
  ...jest.requireActual('../../hooks/usePopularCities'),
  usePopularCities: () => ({ places: [] }),
}));

const usePlaceSearchMock = usePlaceSearch as jest.Mock;

async function renderErrored() {
  usePlaceSearchMock.mockReturnValue({
    results: [],
    loading: false,
    error: 'Location search unavailable.',
  });
  const utils = await render(
    <GlobalPlacePicker visible onSelect={jest.fn()} onClose={jest.fn()} />,
  );
  // Type a query so the search branch (and its error row) is active.
  await fireEvent.changeText(
    utils.getByPlaceholderText('Search cities, hotels, landmarks…'),
    'Lisbon',
  );
  return utils;
}

describe('GlobalPlacePicker — search failure fallback', () => {
  it('shows the inline error row with a Retry button', async () => {
    const { getByTestId, getByText } = await renderErrored();
    expect(getByTestId('place-search-error')).toBeTruthy();
    expect(getByText("Couldn't load suggestions")).toBeTruthy();
    expect(getByTestId('place-search-retry')).toBeTruthy();
  });

  it('keeps the custom free-text row so the user can still tag a typed name', async () => {
    const { getByText } = await renderErrored();
    expect(getByText('Add as custom location')).toBeTruthy();
  });

  it('does not show the generic "No places found" empty state while errored', async () => {
    const { queryByText } = await renderErrored();
    expect(queryByText(/No places found/)).toBeNull();
  });

  it('Retry re-runs the search with a bumped refreshKey', async () => {
    const { getByTestId } = await renderErrored();
    const before = usePlaceSearchMock.mock.calls.length;
    const lastKeyBefore = usePlaceSearchMock.mock.calls[before - 1][1].refreshKey;
    await fireEvent.press(getByTestId('place-search-retry'));
    const callsAfter = usePlaceSearchMock.mock.calls;
    const lastKeyAfter = callsAfter[callsAfter.length - 1][1].refreshKey;
    expect(lastKeyAfter).toBe(lastKeyBefore + 1);
  });
});
