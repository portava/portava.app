/**
 * LayoverMapCard — spec §13's map bands SAFE / TIGHT / BLOCKED (census-layover
 * L67), as the SERVER computed them from the certified budget
 * (`artifacts/api-server/src/services/airport/layoverMapBands.ts`) and sent on
 * each plan stop under `layover_map_bands_enabled`.
 *
 * Mounts the card and asserts on what a traveller sees: each band is labelled
 * with the server's own reason, and a BLOCKED band keeps the pin off the map
 * and lists it — exactly as an envelope-blocked pin is. Nothing here computes a
 * band; a stop the server did not band renders as before.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';
import type { LayoverSafeEnvelope } from '../../../services/layover.ts';

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
// It captures `places` so the test can assert WHICH pins reached the map.
let capturedPlaces: any[] = [];
jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedPlaces = props.places;
      return <View testID="layover-map-view" />;
    },
  };
});

// NOTE: intentional stub — avoids pulling in services/collections/discovery.
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View } = require('react-native');
  return { PlaceDetailSheet: () => <View /> };
});

const AIRPORT = {
  iataCode: 'TPE',
  name: 'Taiwan Taoyuan International Airport',
  city: 'Taoyuan',
  country: 'Taiwan',
  countryCode: 'TW',
  timezone: 'Asia/Taipei',
  lat: 25.0797,
  lng: 121.2342,
  verified: false,
  id: 'airport-tpe',
};

/**
 * The server's own `safeEnvelope` shape, as `GET /overview` publishes it.
 *
 * TYPED, not `any`: `certifiedInward` and `basis` are literal types on the real
 * contract, and a fixture that widened them to `boolean`/`string` would compile
 * against a shape the server never emits — which is the whole point of the
 * test-typecheck gate.
 */
function envelope(over: Partial<LayoverSafeEnvelope> = {}): LayoverSafeEnvelope {
  return {
    centre: { lat: AIRPORT.lat, lng: AIRPORT.lng },
    radiusMetres: 40_000,
    usableMinutes: 240,
    maxOneWayMinutes: 120,
    basis: 'straight_line_lower_bound' as const,
    certifiedOutward: true as const,
    certifiedInward: false as const,
    confidence: 'LOW' as const,
    uncertaintyBudgetMinutes: 60,
    plannedMaxOneWayMinutes: 90,
    plannedRadiusMetres: 30_000,
    ...over,
  };
}

function stop(over: Partial<any> = {}) {
  return {
    id: 'stop-1', title: 'Raohe Night Market', description: null, stopOrder: 1,
    durationMin: 60, travelMin: 30, placeId: null, recommendationId: null,
    lat: 25.05, lng: 121.577, locationLabel: 'Songshan', insideAirport: false,
    source: 'user' as const,
    ...over,
  };
}

function band(b: 'SAFE' | 'TIGHT' | 'BLOCKED' | null, reason: string) {
  return { band: b, reason, neededMin: 120, usableMinutes: 300, spareMin: 180 };
}

beforeEach(() => { capturedPlaces = []; });

describe("L67 — the server's map band is rendered", () => {
  it('SAFE and TIGHT are labelled with the server reason, and both stay on the map', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[
          stop({ id: 'a', mapBand: band('SAFE', 'Fits with 180 min to spare, using the travel time you entered — not a measured route.') }),
          stop({ id: 'b', mapBand: band('TIGHT', 'Only 10 min to spare after the stay and the trip there and back.') }),
        ]}
        envelope={envelope()}
        envelopeGate={{ status: 'open' } as any}
      />,
    );
    expect(screen.getByTestId('layover-map-band-SAFE-a')).toBeTruthy();
    expect(screen.getByTestId('layover-map-band-TIGHT-b')).toBeTruthy();
    expect(screen.getByText(/180 min to spare/)).toBeTruthy();
    expect(screen.getByText(/Only 10 min to spare/)).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).toEqual(expect.arrayContaining(['stop-a', 'stop-b']));
  });

  it('a BLOCKED band keeps the pin off the map and lists it with the reason', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 'c', mapBand: band('BLOCKED', 'About 400 min for the stay and the trip there and back — more than your 300 usable minutes.') })]}
        envelope={envelope()}
        envelopeGate={{ status: 'open' } as any}
      />,
    );
    expect(screen.getByTestId('layover-map-blocked-c')).toBeTruthy();
    expect(screen.getByTestId('layover-map-band-BLOCKED-c')).toBeTruthy();
    expect(screen.getByText(/more than your 300 usable minutes/)).toBeTruthy();
    expect(capturedPlaces.map((p) => p.id)).not.toContain('stop-c');
  });

  it('a stop the server did not band (band null, or no mapBand) shows no band label', async () => {
    await render(
      <LayoverMapCard
        airport={AIRPORT as any}
        stops={[stop({ id: 'd', mapBand: band(null, 'not stated') }), stop({ id: 'e' })]}
        envelope={envelope()}
        envelopeGate={{ status: 'open' } as any}
      />,
    );
    for (const id of ['d', 'e']) for (const b of ['SAFE', 'TIGHT', 'BLOCKED', 'null', 'undefined']) {
      expect(screen.queryByTestId(`layover-map-band-${b}-${id}`)).toBeNull();
    }
    expect(capturedPlaces.map((p) => p.id)).toEqual(expect.arrayContaining(['stop-d', 'stop-e']));
  });
});
