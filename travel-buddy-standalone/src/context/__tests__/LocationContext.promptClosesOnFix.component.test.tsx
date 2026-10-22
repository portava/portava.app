/**
 * The "Turn on location" sheet closes when location arrives.
 *
 * On the owner's iPhone (2026-10-22, release 9d3dc5d0): tap "Enable Location" → "Detecting…" → back to "Enable
 * Location" with the sheet still open, so the only way on was "Choose City Manually". Only `dismissPermissionPrompt`
 * and `openCityPicker` ever hid the sheet; a fix that succeeded while it was up left it there over the city it had
 * just found. And a fix that FAILED went back to the button with no word of why.
 *
 * Through the REAL provider and the REAL sheet (location hook, preferences and session stubbed):
 *   1. the sheet is up while there is no location, and closes once `locationState.ok` turns true;
 *   2. a failed attempt shows the hook's userMessage in the sheet.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

const mockState = {
  locationState: {
    ok: false, permissionStatus: 'granted', source: 'none', freshness: 'unavailable',
    coords: null as null | { lat: number; lng: number; accuracyMeters: number | null },
    place: { id: '', type: 'city', name: '', displayName: '', country: null, countryCode: null, region: null, city: null, district: null, lat: null, lng: null, timezone: null, source: 'manual' },
    lastUpdatedAt: null, userMessage: null as string | null,
  },
  isLoading: false,
};
// NOTE: intentionally exhaustive — the real hook reaches expo-location (native) and the network.
jest.mock('../../hooks/useActiveLocation.ts', () => ({
  useActiveLocation: () => ({
    locationState: mockState.locationState, isLoading: mockState.isLoading,
    requestLocation: jest.fn(), refreshLocation: jest.fn(), setManualCity: jest.fn(), clearManualCity: jest.fn(), getLocationForFeature: jest.fn(),
  }),
}));
// NOTE: intentionally exhaustive — the real hook fetches /api/me/location-preferences.
jest.mock('../../hooks/useLocationPreferences.ts', () => ({
  useLocationPreferences: () => ({ prefs: {}, isLoading: false, refresh: jest.fn() }),
}));
// NOTE: intentionally exhaustive — signed out keeps the auto-show timer off; the sheet is opened via requireLocation.
jest.mock('../SessionContext.tsx', () => ({
  useSession: () => ({ isAuthed: false }),
}));

import { LocationProvider, useLocationContext } from '../LocationContext.tsx';
import { LocationPermissionPrompt } from '../../components/LocationPermissionPrompt.tsx';

const ctx: { requireLocation?: (f?: string) => void } = {};
function Probe() {
  ctx.requireLocation = useLocationContext().requireLocation;
  return null;
}
const tree = () => <LocationProvider><Probe /><LocationPermissionPrompt /></LocationProvider>;

beforeEach(() => {
  mockState.locationState = { ...mockState.locationState, ok: false, coords: null, userMessage: null };
  mockState.isLoading = false;
});

describe('LocationPermissionPrompt — closes on a fix, explains a failure', () => {
  it('1. the sheet closes once location arrives', async () => {
    const view = await render(tree());
    await act(async () => { ctx.requireLocation?.('home'); });
    expect(screen.getByText('Turn on location')).toBeTruthy();

    // requestLocation succeeded: the hook now reports a fix.
    mockState.locationState = { ...mockState.locationState, ok: true, coords: { lat: 25.76, lng: -80.19, accuracyMeters: 20 } };
    await view.rerender(tree());
    await act(async () => {});
    expect(screen.queryByText('Turn on location')).toBeNull();
  });

  it('2. a failed attempt says why instead of silently resetting to the button', async () => {
    const view = await render(tree());
    await act(async () => { ctx.requireLocation?.('home'); });
    expect(screen.getByText('Enable Location')).toBeTruthy();

    mockState.locationState = { ...mockState.locationState, userMessage: 'Location timed out. Try again outside or choose a city.' };
    await view.rerender(tree());
    await act(async () => {});
    expect(screen.getByText('Turn on location')).toBeTruthy();
    expect(screen.getByText('Location timed out. Try again outside or choose a city.')).toBeTruthy();
  });
});
