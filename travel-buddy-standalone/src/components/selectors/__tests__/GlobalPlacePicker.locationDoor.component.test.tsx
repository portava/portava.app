/**
 * GlobalPlacePicker — census-layover L164, §70: the picker asks the phone for
 * location only through the location door, only when the user presses "Use my
 * current location", and that press behaves exactly as it did before the door.
 *
 * The REAL door sits between the picker and the mocked OS adapter, so these
 * cases see the whole path: row press → requestLocationForUserAction (spied,
 * not replaced) → getCurrentGps (mocked).
 *
 *   1. Opening the sheet asks nothing: it reads the EXISTING permission (and
 *      would read the last known fix if one were granted) and never calls the
 *      door, the GPS function or the OS permission request.
 *   2. Pressing the row opens the door once, with a press for map context,
 *      and the GPS function runs once.
 *   3. The outcomes the row has always shown are unchanged: a denied
 *      permission reads "Location is off…", a failed fix "Couldn't get
 *      location…".
 *   4. allowGPS={false} renders no row, so there is nothing to press.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - GlobalPlacePicker.tsx: useGPS calls getCurrentGps directly again → 2 red.
 *   - GlobalPlacePicker.tsx: useGPS passes a non-press request → 2 red (the
 *     door refuses; the GPS function never runs).
 *   - GlobalPlacePicker.tsx: the open effect calls useGPS() → 1 red.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — the real expo-location needs native modules.
// The request/fix members are present only so a regression that calls them is
// SEEN (asserted never called) rather than crashing.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  getLastKnownPositionAsync: jest.fn().mockResolvedValue(null),
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

// NOTE: intentionally exhaustive — the adapter is the OS boundary; the picker
// reaches it only through the door, and the door uses only getCurrentGps.
jest.mock('../../../services/location.ts', () => ({
  getCurrentGps: jest.fn(),
}));

// The REAL door, wrapped so its calls can be counted.
jest.mock('../../../lib/location/locationRequestDoor.ts', () => {
  const actual = jest.requireActual('../../../lib/location/locationRequestDoor.ts');
  return { ...actual, requestLocationForUserAction: jest.fn(actual.requestLocationForUserAction) };
});

jest.mock('../../../hooks/usePlaceSearch.ts', () => ({
  ...jest.requireActual('../../../hooks/usePlaceSearch.ts'),
  usePlaceSearch: () => ({ results: [], loading: false, error: null }),
}));
jest.mock('../../../hooks/useGooglePlacesAutocomplete.ts', () => ({
  ...jest.requireActual('../../../hooks/useGooglePlacesAutocomplete.ts'),
  useGooglePlacesAutocomplete: () => ({ places: [], loading: false }),
  fetchGooglePlaceDetails: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../hooks/useRecentPlaces.ts', () => ({
  ...jest.requireActual('../../../hooks/useRecentPlaces.ts'),
  useRecentPlaces: () => ({ recents: [], saveRecent: jest.fn() }),
}));
jest.mock('../../../hooks/usePopularCities.ts', () => ({
  ...jest.requireActual('../../../hooks/usePopularCities.ts'),
  usePopularCities: () => ({ places: [] }),
}));

import * as ExpoLocation from 'expo-location';
import { GlobalPlacePicker } from '../GlobalPlacePicker.tsx';
import { getCurrentGps } from '../../../services/location.ts';
import { requestLocationForUserAction } from '../../../lib/location/locationRequestDoor.ts';

const gps = getCurrentGps as jest.MockedFunction<typeof getCurrentGps>;
const door = requestLocationForUserAction as jest.MockedFunction<typeof requestLocationForUserAction>;
const getPerm = ExpoLocation.getForegroundPermissionsAsync as jest.Mock;
const requestPerm = ExpoLocation.requestForegroundPermissionsAsync as jest.Mock;
const takeFix = ExpoLocation.getCurrentPositionAsync as jest.Mock;

beforeEach(() => {
  gps.mockReset();
  door.mockClear();
  getPerm.mockClear();
  requestPerm.mockClear();
  takeFix.mockClear();
});

async function openPicker(props: Partial<React.ComponentProps<typeof GlobalPlacePicker>> = {}) {
  const utils = await render(<GlobalPlacePicker visible onSelect={jest.fn()} onClose={jest.fn()} {...props} />);
  await waitFor(() => expect(getPerm).toHaveBeenCalled());
  return utils;
}

describe('GlobalPlacePicker — the location door (census-layover L164)', () => {
  it('1. opening the sheet reads the existing permission and asks for nothing', async () => {
    const { getByText } = await openPicker();
    expect(getByText('Use my current location')).toBeTruthy();
    expect(door).not.toHaveBeenCalled();
    expect(gps).not.toHaveBeenCalled();
    expect(requestPerm).not.toHaveBeenCalled();
    expect(takeFix).not.toHaveBeenCalled();
  });

  it('2. pressing "Use my current location" opens the door once, as a press for map context', async () => {
    gps.mockResolvedValue({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' });
    const { getByText } = await openPicker();
    await fireEvent.press(getByText('Use my current location'));
    await waitFor(() => expect(gps).toHaveBeenCalledTimes(1));
    expect(door).toHaveBeenCalledTimes(1);
    expect(door).toHaveBeenCalledWith({ trigger: 'user_press', purpose: 'map_context' });
  });

  it('3a. a denied permission still reads "Location is off" — unchanged by the door', async () => {
    gps.mockResolvedValue({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' });
    const { getByText, findByText } = await openPicker();
    await fireEvent.press(getByText('Use my current location'));
    expect(await findByText('Location is off. Choose a city manually.')).toBeTruthy();
  });

  it('3b. a failed fix still reads "Couldn\'t get location" — unchanged by the door', async () => {
    gps.mockResolvedValue({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'gps_failed' });
    const { getByText, findByText } = await openPicker();
    await fireEvent.press(getByText('Use my current location'));
    expect(await findByText("Couldn't get location. Choose a city below.")).toBeTruthy();
  });

  it('4. allowGPS={false} renders no row to press, and nothing asks', async () => {
    const { queryByText } = await openPicker({ allowGPS: false });
    expect(queryByText('Use my current location')).toBeNull();
    expect(door).not.toHaveBeenCalled();
    expect(gps).not.toHaveBeenCalled();
  });
});
