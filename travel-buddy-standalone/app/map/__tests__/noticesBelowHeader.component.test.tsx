/**
 * FullScreenMapScreen — the map's notices hang BELOW the floating header stack, not behind the status bar.
 *
 * The "Using city location" banner was `position: 'absolute', top: 0` (a full-width strip), the partial-results
 * notice `top: 26` under it, and the passport / circle pill `top: 52`. On the owner's iPhone 17 Pro Max (insets.top
 * 62, Dynamic Island) all three sat inside the status-bar band or under MapHeader (62–114pt, zIndex 30): the strip's
 * centred text was behind the Dynamic Island and the mode pill behind the header, so the traveller read neither.
 *
 * The stack is MapHeader (insets.top + 52, then an 8 gap: mapHeaderStackOffset), the filter chips
 * (MAP_FILTER_CHIPS_HEIGHT) and MapTopControls' card (space.sm drop, a 44pt button row in space.xs padding). The map's
 * own All / Picks / Venues row hangs under the card (14pt, 36pt tall); the notices start a space.sm under it and keep their 26pt ladder.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import FullScreenMapScreen from '../index.tsx';
import { mapHeaderStackOffset } from '../../../src/components/map/MapHeader.tsx';
import { MAP_FILTER_CHIPS_HEIGHT } from '../../../src/components/map/MapFilterChips.tsx';
import { avatar, space } from '../../../src/theme/tokens.ts';

// Passport mode (the mode pill) with the legacy places layer armed (the partial notice) — Discovery's arming.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ mode: 'passport', entityTypes: 'places', title: 'Da Nang' }),
  usePathname: () => '/',
  useSegments: () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const R = require('react');
    R.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), addListener: () => () => {} }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack: { Screen: () => null },
  Tabs: { Screen: () => null },
}));

// The owner's iPhone 17 Pro Max.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — location permission DENIED with a resolved city: the map renders, with the city banner.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState: { coords: null, place: null, permissionStatus: 'denied' },
    resolvedLocation: {
      place: { city: 'Da Nang', country: 'Vietnam' },
      coords: { lat: 16.0544, lng: 108.2022 },
      source: 'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentionally exhaustive — the legacy source, settled: the legacy places fetch runs.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {},
    source: 'legacy', stage: 'canonical', staleness: null, unreadLayers: [],
  }),
}));

// NOTE: intentionally exhaustive — the real sheet pulls AsyncStorage.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — the stamps themselves are not under test; the fetch stays pending.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn(() => new Promise(() => {})),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — a PARTIAL answer with one place: drawn, and the partial notice shown.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      places: [{
        id: 'db/legacy-1', canonicalPlaceId: 'legacy-1', name: 'Legacy Market', category: 'food', type: null,
        description: null, distanceKm: 1, lat: 16.05, lng: 108.2, tags: [], address: null, website: null, phone: null,
        openingHours: null, rating: null, isOpenNow: null,
      }],
      refusal: { coverage: 'partial', failedSources: ['discovery_places'] },
    },
  }),
}));

// NOTE: intentionally exhaustive — MapLibre native modules are not available under Jest.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const { View } = require('react-native');
  return { DiscoveryMapView: ({ filterRowOffset }: { filterRowOffset?: number }) => <View testID="map-view" {...{ filterRowOffset }} /> };
});
// NOTE: intentionally exhaustive — UI chrome that imports Reanimated / native camera internals.
jest.mock('../../../src/components/map/MapTopControls', () => ({ MapTopControls: () => null }));
// NOTE: intentionally exhaustive — depends on AI completion and native keyboard.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));
// NOTE: intentional stub — no stamp is drawn here.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));
// NOTE: intentionally exhaustive — the carousel's states are not under test (it imports Reanimated).
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const MapCarousel = React.forwardRef((_p: unknown, _ref: unknown) => null);
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

const INSETS_TOP = 62;
const topOf = (n: any) => StyleSheet.flatten(n.props.style).top as number;
/** A notice is the absolutely positioned View holding its line of text. */
const noticeHolding = (text: string) => {
  let n: any = screen.getByText(text);
  while (n && StyleSheet.flatten(n.props?.style)?.position !== 'absolute') n = n.parent;
  return n;
};

it('city banner, partial notice and mode pill all start under the header stack, on their 26pt ladder', async () => {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
  expect(await screen.findByTestId('map-places-partial', {}, { timeout: 5000 })).toBeTruthy();

  const headerOffset = mapHeaderStackOffset(INSETS_TOP); // 122: MapHeader's bottom + its gap
  const stackBottom = headerOffset + MAP_FILTER_CHIPS_HEIGHT + space.sm + avatar.s44 + 2 * space.xs; // 218: MapTopControls' card
  const city = topOf(noticeHolding('Using city location — enable location for better results'));
  const partial = topOf(screen.getByTestId('map-places-partial'));
  const mode = topOf(noticeHolding('🗺 Passport map · your travel stamps'));

  for (const top of [city, partial, mode]) {
    expect(top).toBeGreaterThanOrEqual(headerOffset);
    expect(top).toBeGreaterThanOrEqual(stackBottom);
  }
  expect(screen.getByTestId('map-view').props.filterRowOffset).toBe(stackBottom); expect(city).toBe(stackBottom + 14 + 36 + space.sm); // the filter row is placed under the card (it sat behind it at 180pt), the notices under the row
  expect(partial).toBe(city + 26);
  expect(mode).toBe(city + 52);
});
