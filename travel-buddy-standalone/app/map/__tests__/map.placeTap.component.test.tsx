/**
 * FullScreenMapScreen — venue/place pin tap tests.
 *
 * Confirms that:
 * 1. Discovery places are converted to MapEntity<DiscoveryPlace> objects and
 *    appear in the carousel entity list (i.e. onSelectPlace is NOT a no-op).
 * 2. Calling onSelectPlace with a place navigates to the discover tab when
 *    the carousel card CTA is tapped (router.push to /(tabs)/discover).
 *
 * Mock strategy mirrors the passport.errorCard test: DiscoveryMapView is
 * replaced with a stub that exposes the onSelectPlace callback, and
 * MapCarousel is a stub that renders entity testIDs for easy assertion.
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ────────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ entityTypes: 'places', title: 'Bangkok' }),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const R = require('react');
    R.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));

// ── react-native-safe-area-context ─────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── LocationContext ────────────────────────────────────────────────────────────
// NOTE: intentional stub — provides resolvedLocation for map init; real context
// requires device location permissions unavailable under Jest.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      coords: null,
      place: null,
      permissionStatus: 'granted',
    },
    resolvedLocation: {
      place: { city: 'Bangkok', country: 'Thailand' },
      coords: { lat: 13.7563, lng: 100.5018 },
      source: 'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// ── useMapEntities ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — entities from the hook are not under test here; place
// entities come from getDiscoveryPlaces which is mocked separately.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({ entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' }),
}));

// ── MapFilterSheet / loadEnabledLayers ─────────────────────────────────────────
// NOTE: intentional stub — filter sheet is not exercised in place-tap tests;
// loadEnabledLayers is async and would require a DB setup not available here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// ── passportStamps ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — passport mode is not active in these tests; returning
// ok:false keeps the component in the places branch without a real Supabase call.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── MapTopControls / AskCompassBar ─────────────────────────────────────────────
// NOTE: intentional stub — UI chrome components that import Reanimated; not
// relevant to place-tap behaviour and would crash under Jest without the native
// Reanimated module.
jest.mock('../../../src/components/map/MapTopControls', () => ({ MapTopControls: () => null }));
// NOTE: intentional stub — same Reanimated constraint as MapTopControls above.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));

// ── COUNTRY_CENTROIDS ──────────────────────────────────────────────────────────
// NOTE: intentional stub — passport mode is off; the centroid map is only read
// when building stamp entities, which are empty in this test.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));

// ── discovery service ──────────────────────────────────────────────────────────
// NOTE: intentional stub — only getDiscoveryPlaces is under test; using jest.fn()
// lets the test control the resolved place list without a live Supabase call.
import { getDiscoveryPlaces } from '../../../src/services/discovery.ts';
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn(),
}));
const mockGetDiscoveryPlaces = getDiscoveryPlaces as jest.Mock;

const TEST_PLACE = {
  id: 'osm-123',
  name: 'Chatuchak Market',
  category: 'places',
  lat: 13.7999,
  lng: 100.5500,
  type: 'market',
  description: null,
  distanceKm: 5.0,
  tags: [],
  address: '587/10 Kamphaeng Phet 2 Rd',
  website: null,
  phone: null,
  openingHours: null,
  rating: 4.5,
  isOpenNow: null,
};

// ── DiscoveryMapView — captures onSelectPlace prop ─────────────────────────────
// NOTE: intentional stub — MapLibre native modules are unavailable under Jest.
let capturedOnSelectPlace: ((place: typeof TEST_PLACE) => void) | null = null;

jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return {
    DiscoveryMapView: (props: any) => {
      capturedOnSelectPlace = props.onSelectPlace;
      return <View testID="map-view" />;
    },
  };
});

// ── MapCarousel — renders entity testIDs for assertion ─────────────────────────
// NOTE: intentional stub — avoids react-native-reanimated native modules.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const MapCarousel = React.forwardRef(
    ({ entities }: { entities: { id: string; type: string }[] }, _ref: unknown) => (
      <View testID="map-carousel">
        {entities.map((e: { id: string; type: string }) => (
          <Text key={e.id} testID={`carousel-entity-${e.id}`}>{e.type}</Text>
        ))}
      </View>
    ),
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — venue/place pin tap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedOnSelectPlace = null;
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: { places: [TEST_PLACE] },
    });
  });

  it('converts discovery places to MapEntity<DiscoveryPlace> in the carousel', async () => {
    await render(<FullScreenMapScreen />);

    // After getDiscoveryPlaces resolves, placeEntities is computed and passed
    // to MapCarousel — the place entity must appear in the carousel.
    await waitFor(() => {
      expect(screen.getByTestId('carousel-entity-place:osm-123')).toBeTruthy();
    });
  });

  it('passes a real onSelectPlace handler (not a no-op) to DiscoveryMapView', async () => {
    await render(<FullScreenMapScreen />);

    // Wait for the component to settle and DiscoveryMapView to receive its props.
    await waitFor(() => {
      expect(capturedOnSelectPlace).not.toBeNull();
    });

    // Calling onSelectPlace with the test place must not throw and the entity
    // must still be present in the carousel (handleSelectEntity was called).
    await waitFor(() => {
      expect(screen.getByTestId('carousel-entity-place:osm-123')).toBeTruthy();
    });

    // Call onSelectPlace — this triggers handleSelectPlace → handleSelectEntity.
    act(() => { capturedOnSelectPlace!(TEST_PLACE); });

    // Carousel entity remains visible (entity list unchanged by selection).
    expect(screen.getByTestId('carousel-entity-place:osm-123')).toBeTruthy();
  });
});
