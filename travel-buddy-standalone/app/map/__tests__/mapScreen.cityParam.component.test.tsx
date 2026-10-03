/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; the round-18 verifier's B17): the map screen never reads its
 * display title as a city.
 *
 * app/map/index.tsx handed `params.title` to every reader that expects a city: the NOW map hook (the rollback path reads
 * gems and buddies by it), the legacy places layer (`getDiscoveryPlaces`), the trip map's Compass alternatives
 * (`fetchCompassRecommendations`), the Ask Compass bar and the search sheet. The only entry that sets `title` is a
 * Compass card, with the PLACE's or EVENT's name (CompassChatBlocks), so 'Han Market' was read as a city and an empty
 * gem layer was drawn whole. Those readers now take a `city` query parameter; the title stays the header's label.
 *
 *   SC2  a Compass place card (title = the venue) → the hook gets no city (the rollback path then says the gem and buddy
 *        layers unread, §116 B16)
 *   SC3  the places layer armed with only a title → getDiscoveryPlaces is never asked for the title as a city
 *   SC4  a trip map with only a title → the Compass alternatives are not asked for the title as a city
 *   SC5  a Compass card → the Ask Compass bar and the search sheet are not handed the venue as the city
 *   SC5b an explicit `city` param → the Ask Compass bar gets it (it read the title)
 *   SC0  CONTROL: an explicit `city` param (with the same title) → the hook, the places layer and the search sheet get it
 *   SC1  REACH: the Gems tab's "View on map" → no city, gems enabled, coordinates resolved (B16's entry)
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';
import { placeObject, PLACE_ID } from '../../../src/__fixtures__/mapEntities.ts';

// ── expo-router ───────────────────────────────────────────────────────────────
// The legacy places layer is armed the way Discovery arms it (`entityTypes=
// places` + a city title), so the tests below can prove the projected path
// SUPPRESSES it rather than merely never starting it. zoom=14 is the district
// band, where §17 introduces individual places.
const mockParams: Record<string, string> = {};
function setParams(p: Record<string, string>) { for (const k of Object.keys(mockParams)) delete mockParams[k]; Object.assign(mockParams, p); }
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
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

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — device location is unavailable under Jest.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { coords: null, place: null, permissionStatus: 'granted' },
    resolvedLocation: {
      place: { city: 'Da Nang', country: 'Vietnam' },
      coords: { lat: 16.0544, lng: 108.2022 },
      source: 'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stub — the hook is the CONTROLLED source under test here;
// its own suite proves it requests `place` from the gateway.
jest.mock('../../../src/hooks/useMapEntities', () => ({ useMapEntities: jest.fn() }));
const mockUseMapEntities = jest.requireMock('../../../src/hooks/useMapEntities').useMapEntities as jest.Mock;

// NOTE: intentional stub — filter sheet is not exercised; loadEnabledLayers is async.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue(['buddies', 'events', 'gems', 'trips', 'friends']),
}));
// NOTE: intentionally exhaustive — reads AsyncStorage at import. The §16
// preference is what decides whether `place` is requested, so it is settable.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet: () => null,
  loadLayerPreferences: jest.fn().mockResolvedValue({}),
}));
const mockLoadLayerPreferences = jest.requireMock('../../../src/components/map/LayersSheet').loadLayerPreferences as jest.Mock;

// NOTE: intentional stub — passport mode is not active here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentional stubs — UI chrome that imports Reanimated.
jest.mock('../../../src/components/map/MapTopControls', () => ({ MapTopControls: () => null }));
// The Compass bar and the search sheet are stubs that record the city they are handed (§116 B17: a query parameter).
const mockSeen: { askCity?: unknown; searchCity?: unknown } = {};
// NOTE: intentional stub — records the city the Ask Compass bar is handed; the bar itself is not exercised.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: (p: { city: unknown }) => { mockSeen.askCity = p.city; return null; } }));
// NOTE: intentional stub — records the city the search sheet is handed; the sheet itself is not exercised.
jest.mock('../../../src/components/map/MapSearchSheet', () => ({ MapSearchSheet: (p: { city: unknown }) => { mockSeen.searchCity = p.city; return null; } }));
jest.mock('../../../src/services/compass', () => ({ ...jest.requireActual('../../../src/services/compass'), fetchCompassRecommendations: jest.fn().mockResolvedValue({ ok: false, error: 'offline' }) }));
// map_search_enabled gates whether AskCompassBar renders at all; on, so the city it is handed can be read.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext'),
  useFeatureFlags: () => ({ isEnabled: (flag: string) => flag === 'map_search_enabled', flags: { map_search_enabled: true }, loading: false, error: null, refresh: () => {} }),
}));
const mockFetchCompassRecommendations = jest.requireMock('../../../src/services/compass').fetchCompassRecommendations as jest.Mock;
// NOTE: intentional stub — passport mode is off.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));

// The legacy transport. Whether it is CALLED is the assertion.
jest.mock('../../../src/services/discovery', () => ({ getDiscoveryPlaces: jest.fn() }));
const mockGetDiscoveryPlaces = jest.requireMock('../../../src/services/discovery').getDiscoveryPlaces as jest.Mock;

const LEGACY_PLACE = {
  id: 'db/legacy-1',
  canonicalPlaceId: 'legacy-1',
  name: 'Legacy Market',
  category: 'food',
  type: null,
  description: null,
  distanceKm: 1,
  lat: 16.05,
  lng: 108.2,
  tags: [],
  address: null,
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
};

// ── §8 sheet and §25 rail — render what they were handed ─────────────────────
// Both stubs write the selected object's id into the tree, so the assertions
// read rendered output: "the sheet opened for THIS place".
jest.mock('../../../src/components/map/LivePlaceSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LivePlaceSheet: (props: { object: { id: string } }) => (
      <View testID={`live-place-sheet:${props.object.id}`} />
    ),
  };
});
jest.mock('../../../src/components/map/MapBottomActions', () => {
  // Keep the real module's non-component exports — MapLongPressMenu imports
  // `LONG_PRESS_ACTIONS` from here at module-eval time, and dropping it makes
  // that constant `undefined` and crashes the whole screen on import. Only the
  // heavy `MapBottomActions` component is stubbed.
  const actual = jest.requireActual('../../../src/components/map/MapBottomActions');
  const React = require('react');
  const { View } = require('react-native');
  return {
    ...actual,
    MapBottomActions: (props: { selected: { id: string } }) => (
      <View testID={`map-bottom-actions:${props.selected.id}`} />
    ),
  };
});

// ── DiscoveryMapView — writes the two lists it receives into the tree ─────────
// `places` is the LEGACY list (its own pin loop); `entities` is what
// EntityMapLayers would draw. Which list a place appears in is the whole test.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const holder: { onSelectEntity?: (e: unknown) => void } = {};
  return {
    __holder: holder,
    DiscoveryMapView: (props: {
      places?: { id: string }[];
      entities?: { id: string }[];
      onSelectEntity?: (e: unknown) => void;
    }) => {
      holder.onSelectEntity = props.onSelectEntity; (holder as any).props = props;
      return (
        <View testID="map-view">
          <Text testID="map-legacy-place-ids">{(props.places ?? []).map((p) => p.id).join(',')}</Text>
          <Text testID="map-entity-ids">{(props.entities ?? []).map((e) => e.id).join(',')}</Text>
        </View>
      );
    },
  };
});

// NOTE: the carousel is where the legacy places layer reports itself — it takes
// `placesError` and `placesEmpty` from the screen and draws the error card or the
// zero-results state. The stub renders both as text so a test can tell the two
// apart; no earlier assertion in this file reads the carousel's output, so
// exposing them adds coverage without changing any existing case.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const MapCarousel = React.forwardRef(
    (p: { placesError?: string | null; placesEmpty?: boolean }, ref: React.Ref<unknown>) => { (global as any).__v16CarouselProps = p;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
      return (
        <View testID="map-carousel">
          <Text testID="places-error">{p.placesError ?? ''}</Text>
          <Text testID="places-empty">{String(p.placesEmpty ?? false)}</Text>
        </View>
      );
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});


function recordHook() {
  mockUseMapEntities.mockImplementation(() => ({ entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy', stage: 'canonical', staleness: null, unreadLayers: [], truncated: false }));
}
async function argsFor(params: Record<string, string>) {
  setParams(params); recordHook(); delete mockSeen.askCity; delete mockSeen.searchCity;
  const r: any = await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
  await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
  const calls = mockUseMapEntities.mock.calls.map((c: any[]) => c[0]);
  const last = calls[calls.length - 1];
  await r.unmount();
  return {
    city: last.city, enabledLayers: last.enabledLayers, lat: last.lat, lng: last.lng,
    placesCities: mockGetDiscoveryPlaces.mock.calls.map((c: any[]) => c[0]),
    compassCities: mockFetchCompassRecommendations.mock.calls.map((c: any[]) => c[0]?.city),
    askCity: mockSeen.askCity, searchCity: mockSeen.searchCity,
  };
}
beforeEach(() => { jest.clearAllMocks(); mockLoadLayerPreferences.mockResolvedValue({}); mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [] } }); });

const COMPASS_CARD = { entry: 'compass', lat: '16.0544', lng: '108.2022', focusId: 'p1', title: 'Han Market', category: 'night_market' };
describe('census-discovery §116 (B17): the map screen reads a city param, never its title', () => {
  it('SC0 CONTROL: an explicit city param → every city reader gets it', async () => {
    const a = await argsFor({ entityTypes: 'places', city: 'Da Nang', title: 'Da Nang', zoom: '14', lat: '16.0544', lng: '108.2022' });
    expect(a.city).toBe('Da Nang');
    expect(a.placesCities).toContain('Da Nang');
    expect(a.searchCity).toBe('Da Nang');
  });
  it('SC1 REACH: the Gems tab View on map → no city, gems enabled, coordinates resolved', async () => {
    const a = await argsFor({ entityTypes: 'gems', entry: 'gems' });
    expect(a.city ?? null).toBeNull();
    expect(a.enabledLayers).toContain('gems');
    expect(a.lat).not.toBeNull();
  });
  it('SC2 a Compass place card → the venue name is never the hook\'s city', async () => {
    const a = await argsFor(COMPASS_CARD);
    expect({ city: a.city ?? null, seen: JSON.stringify(a) }).toEqual(expect.objectContaining({ city: null }));
  });
  it('SC3 the places layer armed with only a title → getDiscoveryPlaces is never asked for it as a city', async () => {
    const a = await argsFor({ entityTypes: 'places', title: 'Han Market', zoom: '14', lat: '16.0544', lng: '108.2022' });
    expect(a.placesCities).not.toContain('Han Market');
  });
  it('SC4 a trip map with only a title → the Compass alternatives are not asked for it as a city', async () => {
    const a = await argsFor({ entityTypes: 'trips', entry: 'trip', tripId: 't-1', title: 'Han Market', lat: '16.0544', lng: '108.2022' });
    expect(a.compassCities.length).toBeGreaterThan(0);
    expect(a.compassCities).not.toContain('Han Market');
  });
  it('SC5 a Compass card → the Ask Compass bar and the search sheet are not handed the venue as the city', async () => {
    const a = await argsFor(COMPASS_CARD);
    expect(a.askCity).toBeDefined();
    expect(a.askCity).not.toBe('Han Market');
    expect(a.searchCity).not.toBe('Han Market');
  });
  it('SC5b an explicit city param → the Ask Compass bar gets it, not the title', async () => {
    const a = await argsFor({ ...COMPASS_CARD, city: 'Da Nang' });
    expect(a.askCity).toBe('Da Nang');
  });
});
