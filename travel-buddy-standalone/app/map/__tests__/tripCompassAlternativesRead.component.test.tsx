/**
 * census-discovery §108 (DV-83 round 11, D-W11X2-81). The §11 trip map's Compass alternatives,
 * open since §104.10. `buildComposedTrip` read GET /compass/recommendations (surface `trip`) as
 * `compassRes.ok ? data.recommendations : []`, so a failed read and a refused body were drawn as
 * "Compass has no alternatives" (no pins, no word), and a `partial` body as the complete set. The
 * map now branches on coverage and says a failed or partial Compass read over the trip.
 *
 *   TM1  the trip's Compass read fails (transport) → the failed banner
 *   TM2  a refused `nothing` body → the failed banner
 *   TM3  a `partial` body → the partial banner
 *   TMc  CONTROL: a healthy body → no banner; no trip named → no banner and no Compass read
 *
 * Harness copied from tripContextAndCapabilities.component.test.tsx.
 */
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

const mockFetchCompassRecommendations = jest.fn();
// NOTE: a stand-in on purpose — the trip's Compass read is the INPUT under test;
// everything else in the service is the real module.
jest.mock('../../../src/services/compass', () => ({
  ...jest.requireActual('../../../src/services/compass'),
  fetchCompassRecommendations: (...args: unknown[]) => mockFetchCompassRecommendations(...args),
}));

// Mutable per-test knobs, read lazily by the mock factories below.
const knobs: {
  params: Record<string, string>;
  flags: Record<string, boolean>;
  userId: string | null;
  tripStops: unknown[];
  /** useMapEntities source — 'gateway' means the projection (and its temporal
   *  sibling) answered, which is what opens §15 Time Machine. */
  entitiesSource: 'gateway' | 'legacy' | 'mixed';
  /** The objects the PROJECTION RESPONSE carried. §30's CROWD_FLOW capability
   *  is derived from these and nothing else — see the M221 block at the foot
   *  of this file for why that distinction is the whole requirement. */
  objects: { kind: string; id: string }[];
  /** What GET /api/map/projection/temporal answers the §15 session probe.
   *  'enabled'  — the producer is reachable.
   *  'refused'  — the flag-off envelope: ok, but `enabled: false`.
   *  'error'    — the request did not complete at all. */
  temporalProducer: 'enabled' | 'refused' | 'error';
} = {
  params: {}, flags: {}, userId: null, tripStops: [], entitiesSource: 'legacy',
  objects: [], temporalProducer: 'refused',
};

/** Written by the LayersSheet stub on every render; read after a deep link. */
const layerContextHolder: { mode?: string } = {};

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => knobs.params,
    usePathname:          () => '/',
    useSegments:          () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// The §11 itinerary read. Two stops is the minimum Optimize Today needs — a
// single stop has no ordering to propose.
// NOTE: intentionally exhaustive — the itinerary is an INPUT under test;
// requireActual would fetch over the network.
jest.mock('../../../src/features/trips/planning/tripPlan', () => ({
  fetchTripPlanMap: jest.fn(() => Promise.resolve(knobs.tripStops)),
}));

// §12's session start. It had no reachable caller at all before trip context
// arrived, so this spy is the proof it is reachable now.
// NOTE: intentionally exhaustive — requireActual pulls the presence/privacy
// ladder and would POST a real session.
jest.mock('../../../src/services/locateFriends', () => ({
  startLocateFriendsSession: jest.fn(() =>
    Promise.resolve({ ok: true, data: { session: { id: 'sess-1' }, requestedClass: 'approximate' } }),
  ),
  sharePermittedLocation: jest.fn(() =>
    Promise.resolve({ ok: true, data: { enabled: true, stored: true, storedPrecision: 'approximate', refusal: null } }),
  ),
  LOCATE_FRIENDS_PUBLISH_INTERVAL_MS: 30_000,
}));

// NOTE: intentional stub — the panel's own polling is covered elsewhere.
jest.mock('../../../src/components/map/LocateFriendsPanel', () => ({
  LocateFriendsPanel: () => null,
}));

// One pulse item so LivePulseCard mounts; the item's content is irrelevant
// because the deep link is invoked directly below.
// NOTE: intentionally exhaustive — network service, not under test here.
jest.mock('../../../src/services/livePulse', () => ({
  getLivePulseItems: jest.fn().mockResolvedValue({ ok: true, items: [{ id: 'pulse-1' }] }),
}));

// LivePulseCard — exposes onDeepLink so a §26 "open this map state" tap can be
// simulated. That deep link is the app's only route into LOCATE_FRIENDS mode,
// so it is also the only way to observe whether the capability gate opened.
jest.mock('../../../src/components/map/LivePulseCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  const holder: { onDeepLink?: (d: { mode?: string }) => void } = {};
  return {
    __holder: holder,
    LivePulseCard: (props: { onDeepLink?: (d: { mode?: string }) => void }) => {
      holder.onDeepLink = props.onDeepLink;
      return <View testID="live-pulse-card" />;
    },
  };
});

// §15's scrubber. Rendered only when the TIME_MACHINE capability is true, which
// is what makes its absence an assertion rather than a stub detail.
jest.mock('../../../src/components/map/TimeMachineControl', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { TimeMachineControl: () => <View testID="time-machine-control" /> };
});

// NOTE: intentionally exhaustive — the flag answer is an INPUT under test, so
// it is driven from `knobs` rather than from a real /api/feature-flags fetch.
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => knobs.flags[key] === true,
    isLivePlacesEnabled: (key: string) => knobs.flags[key] === true,
    loading: false,
  }),
}));

// NOTE: intentionally exhaustive — the viewer id is an INPUT under test;
// requireActual pulls the Supabase client.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: knobs.userId, isAuthed: knobs.userId != null, loading: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: { coords: { lat: 14.6, lng: 120.98 }, place: null, permissionStatus: 'granted' },
    resolvedLocation: { place: null, coords: { lat: 14.6, lng: 120.98 }, source: 'home', freshness: 'live' },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stubs — not under test here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet: () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue(['buddies', 'events', 'gems', 'trips', 'friends']),
}));
// The stub RECORDS its `context` prop rather than discarding it. That prop is
// `layerContext`, which the screen builds from `machine.mode`, so it is the
// screen's own mode as the screen itself reports it to a real child — not a
// test-only hook bolted on to observe internal state. It is what the §30
// capability gates ultimately decide.
//
// NOTE: intentionally exhaustive — reads AsyncStorage at import. (This line
// must stay within four lines of the mock: check-test-mocks.mjs looks back
// exactly NOTE_LOOKBEHIND_LINES for it.)
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet: (props: { context?: { mode?: string } }) => {
    layerContextHolder.mode = props?.context?.mode;
    return null;
  },
  loadLayerPreferences: jest.fn().mockResolvedValue({}),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapTopControls', () => ({ MapTopControls: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/AskCompassBar', () => ({ AskCompassBar: () => null }));
// NOTE: intentional stub — passport mode is not exercised here.
jest.mock('../../../src/lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));

jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { DiscoveryMapView: () => <View testID="map-view" /> };
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

// NOTE: intentionally exhaustive — this is the network edge, and the §15
// session probe is the thing under test, so the REAL hook must run against a
// controlled answer rather than being stubbed out.
jest.mock('../../../src/services/mapTemporal', () => ({
  fetchMapTemporal: jest.fn(async () => {
    if (knobs.temporalProducer === 'error') return { ok: false, error: 'Network error' };
    return {
      ok: true,
      data: {
        enabled: knobs.temporalProducer === 'enabled',
        objects: [], sources: [], total: 0, nextCursor: null,
        viewport: null, target: null, aggregation: null, protection: null,
        forecast: null, history: null,
      },
    };
  }),
}));

// NOTE: intentionally exhaustive — the hook is the object/entity SOURCE for
// this screen; requireActual would fetch over the network.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: [], objects: knobs.objects, liveEnrichment: null,
    loading: false, error: null, refresh: () => {}, source: knobs.entitiesSource,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const STOPS = [
  { id: 's1', title: 'Breakfast', locationName: 'Poblacion', lat: 14.55, lng: 121.0, locationIsPrivate: false, sortOrder: 0, lockType: 'flexible', startsAt: null, endsAt: null },
  { id: 's2', title: 'Museum', locationName: 'Intramuros', lat: 14.59, lng: 120.97, locationIsPrivate: false, sortOrder: 1, lockType: 'flexible', startsAt: null, endsAt: null },
];

async function mount() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

/** Fire the §26 pulse deep link that asks for a given map mode. */
async function deepLinkTo(mode: string) {
  const { __holder } = jest.requireMock('../../../src/components/map/LivePulseCard') as {
    __holder: { onDeepLink?: (d: { mode?: string }) => void };
  };
  await waitFor(() => expect(typeof __holder.onDeepLink).toBe('function'));
  await act(async () => { __holder.onDeepLink!({ mode }); });
}

function locateSession() {
  return jest.requireMock('../../../src/services/locateFriends')
    .startLocateFriendsSession as jest.Mock;
}

beforeEach(() => {
  knobs.params = {};
  knobs.flags = {};
  knobs.userId = null;
  knobs.tripStops = [];
  knobs.entitiesSource = 'legacy';
  knobs.objects = [];
  knobs.temporalProducer = 'refused';
  delete layerContextHolder.mode;
  locateSession().mockClear();
});


const REC = { id: 'r1', type: 'place', category: 'food', title: 'Cafe', reason: 'r', city: 'Manila', score: 1, data: { lat: 14.56, lng: 121.01 } };
const refusal = (coverage: string) => ({ class: 'transient_db', code: 'compass_sources_unread', coverage, failedSources: ['events'] });

async function mountTrip() {
  knobs.params = { tripId: 'trip-1' };
  knobs.tripStops = STOPS;
  await mount();
  await waitFor(() => expect(mockFetchCompassRecommendations).toHaveBeenCalled());
  await act(async () => {}); await act(async () => {});
}

describe('§108 the trip map says a failed or partial Compass read', () => {
  beforeEach(() => { mockFetchCompassRecommendations.mockReset(); });

  it('TM1 the Compass read fails → the failed banner', async () => {
    mockFetchCompassRecommendations.mockResolvedValue({ ok: false, error: 'network_error' });
    await mountTrip();
    await waitFor(() => expect(screen.queryByTestId('map-compass-alternatives-failed')).not.toBeNull());
  });

  it('TM2 a refused `nothing` body → the failed banner', async () => {
    mockFetchCompassRecommendations.mockResolvedValue({ ok: true, data: { recommendations: [], surface: 'trip', refusal: refusal('nothing') } });
    await mountTrip();
    await waitFor(() => expect(screen.queryByTestId('map-compass-alternatives-failed')).not.toBeNull());
  });

  it('TM3 a `partial` body → the partial banner', async () => {
    mockFetchCompassRecommendations.mockResolvedValue({ ok: true, data: { recommendations: [REC], surface: 'trip', refusal: refusal('partial') } });
    await mountTrip();
    await waitFor(() => expect(screen.queryByTestId('map-compass-alternatives-partial')).not.toBeNull());
    expect(screen.queryByTestId('map-compass-alternatives-failed')).toBeNull();
  });

  it('TMc CONTROL: a healthy body → no banner; no trip → no banner and no Compass read', async () => {
    mockFetchCompassRecommendations.mockResolvedValue({ ok: true, data: { recommendations: [REC], surface: 'trip' } });
    await mountTrip();
    expect(screen.queryByTestId('map-compass-alternatives-failed')).toBeNull();
    expect(screen.queryByTestId('map-compass-alternatives-partial')).toBeNull();
  });

  it('TMc2 CONTROL: no trip named → no banner, and the trip Compass read is not made', async () => {
    mockFetchCompassRecommendations.mockResolvedValue({ ok: false, error: 'network_error' });
    knobs.params = {};
    await mount();
    await act(async () => {}); await act(async () => {});
    expect(screen.queryByTestId('map-compass-alternatives-failed')).toBeNull();
    expect(mockFetchCompassRecommendations.mock.calls.some((c) => (c[0] as { surface?: string } | undefined)?.surface === 'trip')).toBe(false);
  });
});
