/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B5): the full-screen NOW map says a
 * layer the gateway did not read, and an answer that is one page of several — the safety layer first and plainly.
 *
 * useMapEntities reports `unreadLayers` (every requested layer the gateway did not name in `sources`, §114 the optional
 * layers too) and `truncated` (the answer carried a `nextCursor`). app/map/index.tsx read neither, so a map whose
 * layers could not be read rendered exactly the map whose layers were read and empty — and a failed or cut
 * safety-notice read looked like "no hazards here".
 *
 *   V16-MS0 CONTROL: every layer read → the screen mounts the map and draws no unread notice
 *   V16-MS1 every enabled layer unread → the screen differs from the all-read, all-empty map: it says so
 *   MS2  the safety layer unread → "Safety notices couldn't be checked here", as an alert
 *   MS3  safety and events unread → the safety line comes first, then the layers that could not be loaded
 *   MS4  the answer is page one of several → "Showing only part of this area"
 *   MS6  safety, another layer and a cut together → in that order
 *   MS5  passport mode (nothing requested from the gateway) draws no unread notice
 * The harness is app/map/__tests__/projectedPlaces.component.test.tsx's (as the verifier's probe used it).
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
const mockParams: Record<string, string> = {
  entityTypes: 'places',
  title: 'Da Nang',
  zoom: '14',
  lat: '16.0544',
  lng: '108.2022',
};
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
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));
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
    (p: { placesError?: string | null; placesEmpty?: boolean }, ref: React.Ref<unknown>) => { (global as any).__carouselProps = p;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

type HookAnswer = {
  source: 'gateway' | 'legacy';
  stage: 'cached_geography' | 'canonical' | 'live_state';
  objects?: ReturnType<typeof placeObject>[]; unreadLayers?: string[]; truncated?: boolean;
};

/** Make the hook answer with a fixed envelope, recording what it was asked. */
function hookAnswers({ source, stage, objects = [], unreadLayers = [], truncated = false }: HookAnswer) {
  mockUseMapEntities.mockImplementation(() => ({
    entities: mapObjectsToEntities(objects),
    objects,
    liveEnrichment: null,
    loading: false,
    error: null,
    refresh: () => {},
    source,
    stage,
    staleness: null,
    unreadLayers,
    truncated,
  }));
}

const plain = (o: any) => JSON.stringify(o, (_k, v) => (typeof v === 'function' ? '<fn>' : v));
async function snapshot(unreadLayers: string[], truncated = false) {
  hookAnswers({ source: 'gateway', stage: 'live_state', objects: [], unreadLayers, truncated });
  const r: any = await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
  await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
  const holder = (jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as any).__holder;
  const banner = screen.queryByTestId('map-layers-unread');
  const lines = screen.queryAllByTestId(/^map-layers-unread-line/).map((n: any) => ({ text: [n.props.children].flat().join(''), role: n.props.accessibilityRole ?? null }));
  const out = { tree: plain(screen.toJSON()), mapProps: plain(holder.props), carouselProps: plain((global as any).__carouselProps), banner: banner !== null, lines };
  await r.unmount();
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadLayerPreferences.mockResolvedValue({});
  mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [] } });
  for (const k of Object.keys(mockParams)) if (k === 'mode') delete mockParams[k];
});

describe('§114 B5: the NOW map screen says a layer it could not read', () => {
  it('V16-MS0 CONTROL: every layer read → the map mounts, and no unread notice is drawn', async () => {
    const s = await snapshot([]);
    expect(mockUseMapEntities).toHaveBeenCalled();
    expect(s.tree.length).toBeGreaterThan(100);
    expect(s.banner).toBe(false);
  });

  it('V16-MS1 every enabled layer unread → the screen is not the all-read, all-empty map', async () => {
    const read = await snapshot([]);
    const unread = await snapshot(['events', 'gems', 'buddies', 'trips', 'friends']);
    expect(read.tree === unread.tree && read.mapProps === unread.mapProps && read.carouselProps === unread.carouselProps).toBe(false);
    expect(unread.banner).toBe(true);
    expect(unread.lines.map((l) => l.text)).toEqual(["Couldn\u2019t load events, hidden gems, buddies, trips and friends here"]);
  });

  it('MS2 the safety layer unread → "Safety notices couldn\u2019t be checked here", said as an alert', async () => {
    const s = await snapshot(['safety']);
    expect(s.lines).toEqual([{ text: "Safety notices couldn\u2019t be checked here \u2014 hazards may not be shown", role: 'alert' }]);
  });

  it('MS3 safety and events unread → the safety line first, then the layers that could not be loaded', async () => {
    const s = await snapshot(['events', 'safety', 'meeting_point']);
    expect(s.lines.map((l) => l.text)).toEqual(["Safety notices couldn\u2019t be checked here \u2014 hazards may not be shown", "Couldn\u2019t load events and meeting points here"]);
  });

  it('MS4 the answer is page one of several → "Showing only part of this area"', async () => {
    const s = await snapshot([], true);
    expect(s.lines.map((l) => l.text)).toEqual(['Showing only part of this area \u2014 zoom in to see everything']);
  });

  it('MS5 passport mode requests nothing from the gateway and draws no unread notice', async () => {
    mockParams.mode = 'passport';
    const s = await snapshot(['safety']);
    expect(s.banner).toBe(false);
  });

  it('MS6 safety, another layer and a page cut together → safety, then the layers, then the cut', async () => {
    const s = await snapshot(['events', 'safety'], true);
    expect(s.lines.map((l) => l.text)).toEqual(["Safety notices couldn\u2019t be checked here \u2014 hazards may not be shown", "Couldn\u2019t load events here", 'Showing only part of this area \u2014 zoom in to see everything']);
  });
});
