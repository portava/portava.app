/**
 * LayoverMapCard — stop/airport pin tap tests.
 *
 * Confirms that tapping a stop pin in the layover map card opens
 * PlaceDetailSheet with the tapped place — onSelectPlace is no longer a no-op.
 *
 * Mock strategy:
 * - DiscoveryMapView is replaced with a stub that captures onSelectPlace.
 * - PlaceDetailSheet is replaced with a stub that renders a testID indicator
 *   when visible=true, so the test can assert the sheet opened.
 *
 * NOTE: PlaceDetailSheet is mocked with its .tsx extension because
 * LayoverMapCard.tsx imports it as '../discovery/PlaceDetailSheet.tsx'
 * (explicit extension), so the jest module key must match.
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { LayoverMapCard } from '../LayoverMapCard.tsx';

// ── react-native-safe-area-context ─────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — LayoverMapCard only needs router; all nav calls are
// irrelevant here, so a full requireActual spread would pull in native modules.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
}));

// ── DiscoveryMapView — captures onSelectPlace prop ─────────────────────────────
// NOTE: intentional stub — MapLibre native modules are unavailable under Jest.
let capturedOnSelectPlace: ((place: any) => void) | null = null;

jest.mock('../../discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedOnSelectPlace = props.onSelectPlace;
      return <View testID="layover-map-view" />;
    },
  };
});

// ── PlaceDetailSheet — visible indicator stub ──────────────────────────────────
// NOTE: must mock with .tsx extension to match the source import path:
// `import { PlaceDetailSheet } from '../discovery/PlaceDetailSheet.tsx'`
// NOTE: intentional stub — avoids pulling in services/collections/discovery.
jest.mock('../../discovery/PlaceDetailSheet.tsx', () => {
  const { View, Text } = require('react-native');
  return {
    PlaceDetailSheet: ({ visible, place }: { visible: boolean; place: any }) =>
      visible && place ? (
        <View testID="place-detail-sheet">
          <Text testID="place-detail-name">{place.name}</Text>
        </View>
      ) : null,
  };
});

// ── Test fixture ───────────────────────────────────────────────────────────────

const AIRPORT = {
  iataCode: 'BKK',
  name: 'Suvarnabhumi Airport',
  city: 'Bangkok',
  country: 'TH',
  lat: 13.6811,
  lng: 100.7476,
  timezone: 'Asia/Bangkok',
};

// DiscoveryPlace that DiscoveryMapView calls onSelectPlace with on pin tap.
const TEST_STOP_PLACE = {
  id: 'stop-101',
  name: 'Chatuchak Market',
  category: 'activity',
  lat: 13.7999,
  lng: 100.5500,
  type: null,
  description: null,
  distanceKm: null,
  tags: [],
  address: '587/10 Kamphaeng Phet 2 Rd',
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LayoverMapCard — stop pin tap opens PlaceDetailSheet', () => {
  beforeEach(() => {
    capturedOnSelectPlace = null;
  });

  it('renders the map and passes a real onSelectPlace handler to DiscoveryMapView', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);

    // DiscoveryMapView must be mounted.
    expect(screen.getByTestId('layover-map-view')).toBeTruthy();

    // The captured callback must be a real function, not the old no-op () => {}.
    expect(capturedOnSelectPlace).not.toBeNull();
    expect(typeof capturedOnSelectPlace).toBe('function');
  });

  it('opens PlaceDetailSheet when onSelectPlace is called with a stop place', async () => {
    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);

    // Ensure the component mounted and the callback was captured.
    await screen.findByTestId('layover-map-view');
    expect(capturedOnSelectPlace).not.toBeNull();

    // Sheet is initially closed.
    expect(screen.queryByTestId('place-detail-sheet')).toBeNull();

    // Simulate a stop pin tap. await act(async) ensures React 19 flushes the
    // setSelectedPlace + setPlaceSheetVisible state updates before assertions.
    await act(async () => {
      capturedOnSelectPlace!(TEST_STOP_PLACE);
    });

    // PlaceDetailSheet must now be visible with the tapped place's name.
    await waitFor(() => {
      expect(screen.getByTestId('place-detail-sheet')).toBeTruthy();
    });
    expect(screen.getByText('Chatuchak Market')).toBeTruthy();
  });

  it('passes the airport pin place to PlaceDetailSheet when the airport is tapped', async () => {
    const airportPlace = {
      id: 'airport-BKK',
      name: 'BKK — Suvarnabhumi Airport',
      category: 'transport',
      lat: 13.6811,
      lng: 100.7476,
      type: null,
      description: null,
      distanceKm: null,
      tags: [],
      address: 'Bangkok',
      website: null,
      phone: null,
      openingHours: null,
      rating: null,
      isOpenNow: null,
    };

    await render(<LayoverMapCard airport={AIRPORT as any} stops={[]} />);

    await screen.findByTestId('layover-map-view');
    expect(capturedOnSelectPlace).not.toBeNull();

    await act(async () => {
      capturedOnSelectPlace!(airportPlace);
    });

    await waitFor(() => {
      expect(screen.getByTestId('place-detail-sheet')).toBeTruthy();
    });
    expect(screen.getByText('BKK — Suvarnabhumi Airport')).toBeTruthy();
  });
});
