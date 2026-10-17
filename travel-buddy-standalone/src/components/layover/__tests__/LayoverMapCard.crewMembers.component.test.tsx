/**
 * census-layover L124 — spec §13's map element "Crew member: only with explicit
 * temporary location permission".
 *
 * `crewLocations` is exactly what `GET /crew/location` published to this
 * viewer: crewmates with a LIVE, explicit, scoped share (the server already
 * applied membership, blocks, preferences and every end). The card draws:
 *   - an exact share as a pin at its point;
 *   - a venue share as a pin at its 150 m cell centre — never a point it was
 *     not given;
 *   - an area share as a row with no pin at all;
 * and nothing at all for a crewmate who has not shared. Tapping a crew pin
 * does not open the "add to plan" place sheet: a person is not a place.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — LayoverMapCard touches no navigation at all; a
// requireActual spread here pulls expo-router's native linking internals into a
// suite that only renders one card.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
}));

// NOTE: intentional stub — MapLibre native modules are unavailable under Jest.
// It captures `places` and `onSelectPlace` so the test can assert which pins
// reached the map and what a tap on one does.
let capturedPlaces: any[] = [];
let capturedSelect: ((p: any) => void) | null = null;
jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedPlaces = props.places;
      capturedSelect = props.onSelectPlace;
      return <View testID="layover-map-view" />;
    },
  };
});

// NOTE: intentional stub — records whether the place sheet was asked to open.
let sheetVisible = false;
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View } = require('react-native');
  return { PlaceDetailSheet: (props: any) => { sheetVisible = !!props.visible; return <View />; } };
});

const AIRPORT = {
  iataCode: 'TPE', name: 'Taiwan Taoyuan International Airport', city: 'Taoyuan', country: 'Taiwan',
  countryCode: 'TW', timezone: 'Asia/Taipei', lat: 25.0797, lng: 121.2342, verified: false, id: 'airport-tpe',
};

const ENDS = '2026-10-17T11:00:00.000Z';

function mate(over: Record<string, unknown>) {
  return {
    userId: 'u-x', label: 'Somewhere', precision: 'area', sharedAt: '2026-10-17T10:00:00.000Z', endsAt: ENDS,
    position: null, ring: null, proximity: null, handle: null, name: null, ...over,
  } as any;
}

const CREW = [
  mate({ userId: 'u-exact', label: 'Gate B12', precision: 'exact', position: { lat: 25.08, lng: 121.23 }, name: 'Ann' }),
  mate({ userId: 'u-venue', label: 'Night market', precision: 'venue', ring: { center: { lat: 25.05, lng: 121.57 }, radiusMeters: 150 }, handle: 'bo' }),
  mate({ userId: 'u-area', label: 'Old town', precision: 'area' }),
];

beforeEach(() => { capturedPlaces = []; capturedSelect = null; sheetVisible = false; });

describe('L124 — a crew member is on the map only with an explicit, live share', () => {
  it('exact draws at its point, venue at its cell centre, area draws no pin', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} crewLocations={CREW} />);
    const crewPins = capturedPlaces.filter((p) => String(p.id).startsWith('crew-'));
    expect(crewPins.map((p) => p.id).sort()).toEqual(['crew-u-exact', 'crew-u-venue']);
    expect(crewPins.find((p) => p.id === 'crew-u-exact')).toMatchObject({ lat: 25.08, lng: 121.23 });
    expect(crewPins.find((p) => p.id === 'crew-u-venue')).toMatchObject({ lat: 25.05, lng: 121.57 });
  });

  it('every sharing crewmate is listed with the end of their share; an area share says it has no pin', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} crewLocations={CREW} />);
    expect(screen.getByTestId('layover-map-crew-u-exact')).toBeTruthy();
    expect(screen.getByTestId('layover-map-crew-u-venue')).toBeTruthy();
    expect(screen.getByTestId('layover-map-crew-u-area')).toBeTruthy();
    expect(screen.getByText(/Ann · Gate B12/)).toBeTruthy();
    expect(screen.getByText(/@bo · Night market · within 150 m/)).toBeTruthy();
    expect(screen.getByText(/Old town · area only, no pin/)).toBeTruthy();
  });

  it('no share, no crew member: the map is what it was', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);
    expect(capturedPlaces.some((p) => String(p.id).startsWith('crew-'))).toBe(false);
    expect(screen.queryByTestId('layover-map-crew')).toBeNull();
  });

  it('tapping a crew pin does not offer to add a person to the plan (a stop pin still does)', async () => {
    const stop = { id: 'st-1', title: 'Raohe', description: null, stopOrder: 1, durationMin: 60, travelMin: 30, placeId: null,
      recommendationId: null, lat: 25.05, lng: 121.577, locationLabel: 'Songshan', insideAirport: false, source: 'user' as const };
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[stop as any]} crewLocations={CREW} />);
    expect(typeof capturedSelect).toBe('function');
    await act(async () => { capturedSelect!(capturedPlaces.find((p) => p.id === 'crew-u-exact')); });
    expect(sheetVisible).toBe(false);
    // CONTROL: the same handler opens the sheet for a place, so the refusal above is real.
    await act(async () => { capturedSelect!(capturedPlaces.find((p) => p.id === 'stop-st-1')); });
    expect(sheetVisible).toBe(true);
  });
});
