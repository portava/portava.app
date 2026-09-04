/**
 * FullScreenMapScreen — canonical places through the projection (Map spec §19).
 *
 * ## What this covers
 *
 * Places used to reach this screen ONLY as legacy `MapEntity<DiscoveryPlace>`
 * envelopes built from GET /api/discovery/places, which skipped the gateway's
 * §24 protection, §31 aggregation and §7 enrichment, and could not open the
 * §8 Live Place sheet or arm the §25 rail. The screen now:
 *
 *  1. asks `useMapEntities` for the `place` kind (from the §16 relevant_places
 *     preference), and
 *  2. when the hook reports `source === 'gateway'`, uses the projected places
 *     and does NOT run the legacy Discovery fetch; a projected place is a
 *     `MapObject`, so tapping its marker opens LivePlaceSheet and the rail;
 *  3. when the hook reports the legacy source, keeps the legacy path exactly as
 *     before (the flag-off rollback), and
 *  4. holds the legacy fetch while the gateway's FIRST verdict is still pending
 *     rather than flashing unprotected pins and then discarding them.
 *
 * ## Why the hook is mocked here
 *
 * `useMapEntities` has its own suite proving it requests `place` and returns the
 * gateway's objects. This file proves what the SCREEN does with the answer,
 * so the hook is a controlled source and its call arguments are read back.
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
      holder.onSelectEntity = props.onSelectEntity;
      return (
        <View testID="map-view">
          <Text testID="map-legacy-place-ids">{(props.places ?? []).map((p) => p.id).join(',')}</Text>
          <Text testID="map-entity-ids">{(props.entities ?? []).map((e) => e.id).join(',')}</Text>
        </View>
      );
    },
  };
});

jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapCarousel = React.forwardRef((_p: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
    return <View testID="map-carousel" />;
  });
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type HookAnswer = {
  source: 'gateway' | 'legacy';
  stage: 'cached_geography' | 'canonical' | 'live_state';
  objects?: ReturnType<typeof placeObject>[];
};

/** Make the hook answer with a fixed envelope, recording what it was asked. */
function hookAnswers({ source, stage, objects = [] }: HookAnswer) {
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
    unreadLayers: [],
  }));
}

/** The `places` option of the most recent hook call. */
function placesRequested(): boolean | undefined {
  const calls = mockUseMapEntities.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].places;
}

async function mount() {
  render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
  // Let the async preference/layer loads and any effects settle.
  await act(async () => { await Promise.resolve(); });
}

function mapMock() {
  return jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as {
    __holder: { onSelectEntity?: (e: unknown) => void };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadLayerPreferences.mockResolvedValue({});
  mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [LEGACY_PLACE] } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The projected path
// ═══════════════════════════════════════════════════════════════════════════════

describe('projected places (source === gateway)', () => {
  it('asks the hook for the place kind from the §16 relevant_places default', async () => {
    hookAnswers({ source: 'gateway', stage: 'live_state', objects: [placeObject()] });
    await mount();
    expect(placesRequested()).toBe(true);
  });

  it('does not run the legacy Discovery fetch even though the legacy layer is armed', async () => {
    hookAnswers({ source: 'gateway', stage: 'live_state', objects: [placeObject()] });
    await mount();
    expect(mockGetDiscoveryPlaces).not.toHaveBeenCalled();
  });

  it('hands the map the projected place as an entity and NO legacy place list', async () => {
    hookAnswers({ source: 'gateway', stage: 'live_state', objects: [placeObject()] });
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId('map-entity-ids').props.children).toContain(`place:${PLACE_ID}`);
    });
    expect(screen.getByTestId('map-legacy-place-ids').props.children).toBe('');
  });

  it('a tap on the projected place opens the §8 Live Place sheet and arms the §25 rail', async () => {
    const obj = placeObject();
    hookAnswers({ source: 'gateway', stage: 'live_state', objects: [obj] });
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId('map-entity-ids').props.children).toContain(obj.id);
    });
    expect(screen.queryByTestId(`live-place-sheet:${obj.id}`)).toBeNull();

    const [entity] = mapObjectsToEntities([obj]);
    await act(async () => { mapMock().__holder.onSelectEntity!(entity); });

    await waitFor(() => expect(screen.getByTestId(`live-place-sheet:${obj.id}`)).toBeTruthy());
    expect(screen.getByTestId(`map-bottom-actions:${obj.id}`)).toBeTruthy();
  });

  it('a viewer who switched Relevant Places OFF is not asked for the kind, and keeps the legacy layer', async () => {
    mockLoadLayerPreferences.mockResolvedValue({ relevant_places: 'off' });
    hookAnswers({ source: 'gateway', stage: 'live_state', objects: [] });
    await mount();
    await waitFor(() => expect(placesRequested()).toBe(false));
    // Not wanted from the gateway ⇒ the projected path is not live for places,
    // so the armed legacy layer runs exactly as before.
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalled());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The legacy path is kept
// ═══════════════════════════════════════════════════════════════════════════════

describe('legacy places (source === legacy)', () => {
  it('runs the legacy Discovery fetch once the gateway has declined', async () => {
    hookAnswers({ source: 'legacy', stage: 'canonical' });
    await mount();
    await waitFor(() => expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1));
    expect(mockGetDiscoveryPlaces.mock.calls[0][0]).toBe('Da Nang');
  });

  it('draws the legacy list through DiscoveryMapView and envelopes it for the carousel', async () => {
    hookAnswers({ source: 'legacy', stage: 'canonical' });
    await mount();
    await waitFor(() => {
      expect(screen.getByTestId('map-legacy-place-ids').props.children).toBe('db/legacy-1');
    });
    expect(screen.getByTestId('map-entity-ids').props.children).toContain('place:db/legacy-1');
  });

  it('holds the legacy fetch while the gateway has not yet answered', async () => {
    // §33: the stage ladder leaves `cached_geography` only on a network verdict.
    hookAnswers({ source: 'legacy', stage: 'cached_geography' });
    await mount();
    await act(async () => { await Promise.resolve(); });
    expect(mockGetDiscoveryPlaces).not.toHaveBeenCalled();
  });
});
