/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B31, probes MP0, MP1): the NOW map's
 * bottom Live Pulse card says a section GET /pulse/live could not read, and never keeps a read's items after a failed one.
 *
 * The screen kept only `res.items` (app/map/index.tsx) and never read `failedSources`, so over a section the server
 * could not read (here `safe_return_sessions`, the section the card's own ladder puts first, pulseMapBridge.ts) it
 * headlined the next item as "the most important nearby change" and said nothing; on a failed read it kept the
 * previous camera's items. The answer is now read by pulseCardAnswer (src/features/map/pulse/pulseCardAnswer.ts,
 * unit-tested in its own suite) and the card says what could not be read.
 * Harness: the v16 full-screen map harness (mapScreen.unreadLayers), with getLivePulseItems faked.
 *
 *   MP0 CONTROL: whole answer [safe_return, event] → the Safe Return session is the headline, nothing said
 *   MP1 answer [event] + failedSources ['safe_return_sessions'] → the card says the Safe Return sessions could not be
 *       checked (the verifier's MP1)
 *   MP2 the read FAILS → no item is headlined; the card says live updates could not be loaded
 *   MP3 answer [] + failedSources ['safe_return_sessions'] → the card still says so (an empty answer is not "nothing")
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

// ── Helpers ───────────────────────────────────────────────────────────────────

type HookAnswer = {
  source: 'gateway' | 'legacy';
  stage: 'cached_geography' | 'canonical' | 'live_state';
  objects?: ReturnType<typeof placeObject>[]; unreadLayers?: string[];
};

/** Make the hook answer with a fixed envelope, recording what it was asked. */
function hookAnswers({ source, stage, objects = [], unreadLayers = [] }: HookAnswer) {
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
  }));
}


jest.mock('../../../src/services/livePulse', () => ({
  ...jest.requireActual('../../../src/services/livePulse'),
  getLivePulseItems: jest.fn(),
}));
const mockGetLivePulseItems = jest.requireMock('../../../src/services/livePulse').getLivePulseItems as jest.Mock;
const baseItem = { subtitle: null, city: 'Da Nang', starts_at: null, ends_at: null, user_relationship: 'going', primary_action: null, secondary_action: null, reason_labels: [], expires_at: null, is_joinable: true, people_count: null };
const SAFE = { ...baseItem, id: 'safe_return:s1', item_type: 'safe_return', item_id: 's1', status_label: 'Now', title: 'Safe Return check-in due in 12 min' };
const EVENT = { ...baseItem, id: 'event:e1', item_type: 'event', item_id: 'e1', status_label: 'Now', title: 'Rooftop quiz', people_count: 4 };
async function card(items: any[] | null, failedSources: string[]) {
  hookAnswers({ source: 'gateway', stage: 'live_state', objects: [], unreadLayers: [] });
  mockGetLivePulseItems.mockResolvedValue(items === null ? { ok: false, error: 'HTTP 503' } : { ok: true, items, sessionId: 's', failedSources });
  const r: any = await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
  await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
  const out = {
    asked: mockGetLivePulseItems.mock.calls.length,
    headline: screen.queryByText(SAFE.title) ? 'safe_return' : screen.queryByText(EVENT.title) ? 'event' : null,
    said: screen.queryAllByText(/couldn|could not|not be read|unread|incomplete|unavailable/i).map((n: any) => [].concat(n.props.children).join('')),
  };
  await r.unmount();
  return out;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockLoadLayerPreferences.mockResolvedValue({});
  mockGetDiscoveryPlaces.mockResolvedValue({ ok: true, data: { places: [] } });
});
describe('census-discovery §119 (B31): the NOW map Live Pulse card over a section /pulse/live could not read', () => {
  it('MP0 CONTROL: whole answer → the Safe Return session is the headline', async () => {
    const seen = await card([SAFE, EVENT], []);
    expect({ headline: seen.headline, said: seen.said }).toEqual({ headline: 'safe_return', said: [] });
  });
  it('MP1 safe_return_sessions unread → the card must not headline the event as the whole answer, unsaid', async () => {
    const seen = await card([EVENT], ['safe_return_sessions']);
    expect(seen.headline === null || seen.said.length > 0).toBe(true);
    expect(seen.said).toEqual(["Couldn't check your Safe Return sessions"]);
  });
  it('MP2 the read FAILS → nothing headlined; the card says live updates could not be loaded', async () => {
    const seen = await card(null, []);
    expect({ headline: seen.headline, said: seen.said }).toEqual({ headline: null, said: ["Couldn't load live updates here"] });
  });
  it('MP3 an empty answer beside safe_return_sessions unread → the card still says so', async () => {
    const seen = await card([], ['safe_return_sessions']);
    expect({ headline: seen.headline, said: seen.said }).toEqual({ headline: null, said: ["Couldn't check your Safe Return sessions"] });
  });
});
