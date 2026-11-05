/**
 * Edit trip (app/trip/edit.tsx) — the destination's point on the map.
 *
 * Neither the create nor the edit screen ever sent destination_lat/lng, so no
 * trip made in the app was on the map. The edit save now sends them
 * (lib/tripDestinationGeo.ts).
 *
 * Pinned: a destination picked again sends its point (replacing the old one);
 * an untouched destination fills in a missing point but never replaces a stored
 * one, and never changes the zone.
 *
 * Run with: npx jest app/trip/__tests__/tripEdit.destinationGeo.component.test.tsx
 */
import React from 'react';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({ id: 'trip-1' }),
}));

// NOTE: intentional stub — the owner is signed in throughout.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true, userId: 'owner-1' }),
}));

const mockGetTrip = jest.fn();
const mockUpdateTrip = jest.fn();
jest.mock('../../../src/services/trips', () => ({
  ...jest.requireActual('../../../src/services/trips'),
  getTrip: (...a: unknown[]) => mockGetTrip(...a),
  getTripMemberRole: jest.fn(),
  updateTrip: (...a: unknown[]) => mockUpdateTrip(...a),
}));

// The save resolves the stored destination through the registry; here that
// answers with Lisbon's registry row.
jest.mock('../../../src/lib/location/resolveCanonical', () => ({
  ...jest.requireActual('../../../src/lib/location/resolveCanonical'),
  resolveCanonicalPlace: async (p: any) => ({ ...p, lat: 38.72, lng: -9.14, canonicalId: 'loc_lisbon', timezone: 'Europe/Lisbon' }),
}));

// NOTE: intentionally exhaustive — the calendar is a full modal, closed throughout.
jest.mock('../../../src/components/selectors/GlobalCalendarPicker', () => ({ GlobalCalendarPicker: () => null }));
// NOTE: intentional stub — the stand-in hands back a fresh pick of Porto, as the real picker reports one.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    GlobalPlacePicker: (p: any) => ReactActual.createElement(Pressable, {
      testID: 'mock-place-pick',
      onPress: () => {
        p.onCanonicalBinding?.({
          entityType: 'city', entityId: 'loc_porto', canonicalId: 'loc_porto', displayName: 'Porto', city: 'Porto',
          country: 'Portugal', countryCode: 'PT', neighborhood: null, lat: 41.15, lng: -8.61, timezone: 'Europe/Lisbon', resolved: true,
        });
        p.onSelect?.({
          id: 'nominatim-porto', type: 'city', name: 'Porto', displayName: 'Porto, Portugal', country: 'Portugal', countryCode: 'PT',
          region: null, city: 'Porto', district: null, lat: 41.15, lng: -8.61, timezone: null, source: 'nominatim',
        });
      },
    }),
  };
});

import EditTrip from '../edit.tsx';

const TRIP = {
  id: 'trip-1', ownerId: 'owner-1', title: 'Lisbon', destinationCity: 'Lisbon', destinationCountry: 'Portugal',
  neighborhoods: [], startDate: null, endDate: null, status: 'planning', visibility: 'private',
  travelStyle: null, openToMeet: false, coverUrl: null, coverMediaType: null, progress: 0, tripNotes: null,
  showHeaderPublicly: false, allowJoinRequests: false, showInDiscovery: false,
  destinationLat: null as number | null, destinationLng: null as number | null, destinationPlaceId: null as string | null,
};

async function saveWith(trip: typeof TRIP, repick = false) {
  mockGetTrip.mockResolvedValue(trip);
  await render(<EditTrip />);
  await act(async () => {});
  if (repick) await act(async () => { fireEvent.press(screen.getByTestId('mock-place-pick')); });
  await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
  await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalledTimes(1));
  return mockUpdateTrip.mock.calls[0]![1] as Record<string, unknown>;
}

describe('Edit trip — the destination point', () => {
  beforeEach(() => {
    mockGetTrip.mockReset(); mockUpdateTrip.mockReset();
    mockUpdateTrip.mockResolvedValue({ ...TRIP });
  });

  it("a trip with no point gets the resolved destination's point, without a zone change", async () => {
    const sent = await saveWith(TRIP);
    expect(sent).toMatchObject({ destinationLat: 38.72, destinationLng: -9.14, destinationPlaceId: 'loc_lisbon' });
    expect('timezone' in sent).toBe(false);
  });

  it('a stored point is not replaced when the destination was not picked again', async () => {
    const sent = await saveWith({ ...TRIP, destinationLat: 38.7, destinationLng: -9.1, destinationPlaceId: 'loc_lisbon' });
    expect('destinationLat' in sent).toBe(false);
    expect('destinationLng' in sent).toBe(false);
    expect('destinationPlaceId' in sent).toBe(false);
  });

  it('a destination picked again sends the new point, id and zone', async () => {
    const sent = await saveWith({ ...TRIP, destinationLat: 38.7, destinationLng: -9.1, destinationPlaceId: 'loc_lisbon' }, true);
    expect(sent).toMatchObject({
      destinationCity: 'Porto', destinationLat: 41.15, destinationLng: -8.61, destinationPlaceId: 'loc_porto', timezone: 'Europe/Lisbon',
    });
  });
});
