/**
 * LocationContext's READ-ONLY half — census-layover L164, §70.
 *
 * `PlaceDetailSheet` (mounted by the layover map card) reads the resolved
 * location through `useResolvedLocation()` from ./locationContextValue.ts,
 * which imports no location hook. That only works if the app-root
 * `LocationProvider` supplies the read-only context with the SAME value every
 * other screen reads from `useLocationContext()`. Through the REAL provider
 * (its two hooks and the session stubbed):
 *
 *   1. both hooks return the very same resolved-location object — one source
 *      of truth, not two;
 *   2. a session override reaches both, as `manual_city`;
 *   3. the read-only value is DATA: no function anywhere in it, so a reader
 *      cannot request, refresh or require location through it;
 *   4. the full context every other screen uses is unchanged — same members,
 *      including the request functions;
 *   5. outside the provider the read-only hook throws, as `useLocationContext`
 *      does (a reader mounted without the root provider is a wiring defect).
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - LocationContext.tsx: drop the ResolvedLocationContext.Provider → 1, 2 red
 *     (the read-only hook throws inside the provider).
 *   - LocationContext.tsx: provide `{ ...resolvedLocation }` (a copy) → 1 red.
 *   - LocationContext.tsx: provide the full context value → 3 red.
 *   - locationContextValue.ts: return null instead of throwing → 5 red.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import type { Place } from '../../lib/location/placeTypes.ts';

const HOME: Place = {
  id: 'p-danang', type: 'city', name: 'Da Nang', displayName: 'Da Nang, Vietnam', country: 'Vietnam', countryCode: 'VN',
  region: null, city: 'Da Nang', district: null, lat: 16.054, lng: 108.202, timezone: 'Asia/Ho_Chi_Minh', source: 'gps',
};
const PICKED: Place = { ...HOME, id: 'p-hoian', name: 'Hoi An', displayName: 'Hoi An, Vietnam', city: 'Hoi An', lat: 15.88, lng: 108.335, source: 'manual' };

const mockHook = {
  locationState: {
    ok: true, permissionStatus: 'granted', source: 'gps_fresh', freshness: 'live',
    coords: { lat: 16.054, lng: 108.202, accuracyMeters: 20 }, place: HOME, lastUpdatedAt: '2026-10-14T00:00:00Z', userMessage: null,
  },
  isLoading: false,
  requestLocation: jest.fn(),
  refreshLocation: jest.fn(),
  setManualCity: jest.fn(),
  clearManualCity: jest.fn(),
  getLocationForFeature: jest.fn(),
};
// NOTE: intentionally exhaustive — the real hook reaches expo-location (native)
// and the network; the provider reads exactly these members.
jest.mock('../../hooks/useActiveLocation.ts', () => ({
  useActiveLocation: () => mockHook,
}));
// NOTE: intentionally exhaustive — the real hook fetches /api/me/location-preferences.
jest.mock('../../hooks/useLocationPreferences.ts', () => ({
  useLocationPreferences: () => ({ prefs: {}, isLoading: false, refresh: jest.fn() }),
}));
// NOTE: intentionally exhaustive — the provider reads only isAuthed; signed out
// keeps the permission sheet's timer from running.
jest.mock('../SessionContext.tsx', () => ({
  useSession: () => ({ isAuthed: false }),
}));

import { LocationProvider, useLocationContext } from '../LocationContext.tsx';
import type { LocationContextValue } from '../LocationContext.tsx';
import { useResolvedLocation } from '../locationContextValue.ts';
import type { ResolvedLocation } from '../locationContextValue.ts';

type Seen = { full: LocationContextValue; readOnly: ResolvedLocation };

async function mountProbe() {
  const seen: { current: Seen | null } = { current: null };
  function Probe() {
    seen.current = { full: useLocationContext(), readOnly: useResolvedLocation() };
    return null;
  }
  await render(<LocationProvider><Probe /></LocationProvider>);
  return seen;
}

function functionsIn(value: unknown, path = 'value'): string[] {
  if (typeof value === 'function') return [path];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => functionsIn(v, `${path}.${k}`));
}

describe('LocationProvider — the read-only resolved location (census-layover L164)', () => {
  it('1. both hooks return the SAME resolved-location object', async () => {
    const seen = await mountProbe();
    expect(seen.current!.readOnly).toBe(seen.current!.full.resolvedLocation);
    expect(seen.current!.readOnly).toEqual({
      place: HOME, coords: { lat: 16.054, lng: 108.202, accuracyMeters: 20 }, source: 'gps_fresh', freshness: 'live',
    });
  });

  it('2. a session override reaches the read-only hook too', async () => {
    const seen = await mountProbe();
    await act(async () => { seen.current!.full.setSessionLocation(PICKED); });
    expect(seen.current!.readOnly.place).toBe(PICKED);
    expect(seen.current!.readOnly.source).toBe('manual_city');
    expect(seen.current!.readOnly).toBe(seen.current!.full.resolvedLocation);
    await act(async () => { seen.current!.full.clearSessionLocation(); });
    expect(seen.current!.readOnly.place).toBe(HOME);
  });

  it('3. the read-only value is data — no function anywhere in it', async () => {
    const seen = await mountProbe();
    expect(functionsIn(seen.current!.readOnly)).toEqual([]);
    expect(Object.keys(seen.current!.readOnly).sort()).toEqual(['coords', 'freshness', 'place', 'source']);
  });

  it('4. the full context every other screen reads is unchanged', async () => {
    const seen = await mountProbe();
    expect(Object.keys(seen.current!.full).sort()).toEqual([
      'clearManualCity', 'clearSessionLocation', 'closeCityPicker', 'dismissPermissionPrompt', 'getLocationForFeature',
      'isLoading', 'locationPrefs', 'locationPrefsLoading', 'locationState', 'openCityPicker', 'refreshLocation',
      'refreshLocationPrefs', 'requestLocation', 'requireLocation', 'resolvedLocation', 'setManualCity',
      'setSessionLocation', 'showCityPicker', 'showPermissionPrompt',
    ]);
    expect(seen.current!.full.requestLocation).toBe(mockHook.requestLocation);
  });

  it('5. outside the provider the read-only hook throws, like useLocationContext', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      function Bare() { useResolvedLocation(); return null; }
      await expect(render(<Bare />)).rejects.toThrow('useResolvedLocation must be used inside <LocationProvider>');
    } finally {
      errors.mockRestore();
    }
  });
});
