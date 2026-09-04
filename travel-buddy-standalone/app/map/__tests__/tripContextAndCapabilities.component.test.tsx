/**
 * FullScreenMapScreen — §11 trip context and the §30 capability gates.
 *
 * ## The two defects this covers
 *
 * 1. `params.tripId` was a dead query parameter. The shell read it and gated
 *    the trip objects, the §11 Optimize Today chip and the §12 Locate My
 *    Friends group scope on it, but no navigation passed it. Optimize Today
 *    could never render and `startLocateFriendsSession` had no reachable
 *    caller. (The other half — the navigation that now sends it — is in
 *    src/components/__tests__/tripMapNavigationContext.component.test.tsx.)
 *
 * 2. `DEFAULT_MAP_CAPABILITIES` hardcoded three surfaces closed and nothing
 *    ever called `setMapCapabilities`, so `canEnterMode` refused them forever.
 *
 * ## Why the assertions look like this
 *
 * Capabilities are internal machine state, so asserting them directly would
 * only prove a value was written. These tests read the OBSERVABLE consequence
 * instead: a mode that `canEnterMode` refuses leaves the machine in LIVE, so
 * the surface's own affordance never appears. That is the difference a user
 * experiences, and it is the thing that was broken.
 */
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// Mutable per-test knobs, read lazily by the mock factories below.
const knobs: {
  params: Record<string, string>;
  flags: Record<string, boolean>;
  userId: string | null;
  tripStops: unknown[];
  /** useMapEntities source — 'gateway' means the projection (and its temporal
   *  sibling) answered, which is what opens §15 Time Machine. */
  entitiesSource: 'gateway' | 'legacy' | 'mixed';
} = { params: {}, flags: {}, userId: null, tripStops: [], entitiesSource: 'legacy' };

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
jest.mock('../../../src/services/tripPlan', () => ({
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
// NOTE: intentionally exhaustive — reads AsyncStorage at import.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet: () => null,
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

// NOTE: intentionally exhaustive — the hook is the object/entity SOURCE for
// this screen; requireActual would fetch over the network.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: [], objects: [], liveEnrichment: null,
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
  locateSession().mockClear();
});

// ── §11 trip context ──────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §11 Optimize Today is reachable', () => {
  it('renders the chip when the navigation named a trip', async () => {
    // Pre-fix this could not happen: TripMapPreview pushed
    // `/map?entityTypes=trips` with no tripId, so `tripId` was always null and
    // the chip's condition was unsatisfiable.
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.tripStops = STOPS;
    await mount();

    await waitFor(() => expect(screen.getByText('Optimize today')).toBeTruthy());
  });

  it('does not render the chip when no trip was named', async () => {
    knobs.params = { entityTypes: 'trips' };
    knobs.tripStops = STOPS;
    await mount();

    await waitFor(() => expect(screen.getByTestId('map-carousel')).toBeTruthy());
    expect(screen.queryByText('Optimize today')).toBeNull();
  });

  it('does not render the chip for a trip with only one stop', async () => {
    // §11 proposes an ORDER. One stop has no order to propose, so offering the
    // control would be offering a no-op.
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.tripStops = [STOPS[0]];
    await mount();

    await waitFor(() => expect(screen.getByTestId('map-carousel')).toBeTruthy());
    expect(screen.queryByText('Optimize today')).toBeNull();
  });
});

// ── §30 capabilities ──────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §12 Locate My Friends capability', () => {
  it('lets the mode be entered and the session started when flag, trip and viewer all exist', async () => {
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.flags = { locate_friends_enabled: true };
    knobs.userId = 'user-1';
    await mount();

    await deepLinkTo('LOCATE_FRIENDS');

    const chip = await screen.findByText('Locate my friends · 2h');
    await act(async () => { fireEvent.press(chip); });

    // The call that had no reachable caller in the whole app.
    expect(locateSession()).toHaveBeenCalledWith(
      expect.objectContaining({ groupScopeKind: 'trip', groupScopeId: 'trip-1' }),
    );
  });

  it('refuses the mode when the server flag is off', async () => {
    // canEnterMode fails closed, so ENTER_MODE returns the state unchanged and
    // the machine stays in LIVE — the chip never appears.
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.flags = {};
    knobs.userId = 'user-1';
    await mount();

    await deepLinkTo('LOCATE_FRIENDS');

    expect(screen.queryByText('Locate my friends · 2h')).toBeNull();
    expect(locateSession()).not.toHaveBeenCalled();
  });

  it('refuses the mode when no trip scopes the group', async () => {
    knobs.params = { entityTypes: 'trips' };
    knobs.flags = { locate_friends_enabled: true };
    knobs.userId = 'user-1';
    await mount();

    await deepLinkTo('LOCATE_FRIENDS');

    expect(screen.queryByText('Locate my friends · 2h')).toBeNull();
  });

  it('refuses the mode when nobody is signed in', async () => {
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.flags = { locate_friends_enabled: true };
    knobs.userId = null;
    await mount();

    await deepLinkTo('LOCATE_FRIENDS');

    expect(screen.queryByText('Locate my friends · 2h')).toBeNull();
  });
});

describe('FullScreenMapScreen — §15 Time Machine reachability', () => {
  it('stays shut while the projection gateway is not answering (source: legacy)', async () => {
    // The temporal producer rides map_projection_enabled; when the gateway is
    // not answering (the legacy per-layer path), there is no per-offset source
    // to scrub, so the control must not appear — and specifically must NOT be
    // hardcoded true to make the surface show.
    knobs.params = { entityTypes: 'trips', tripId: 'trip-1' };
    knobs.flags = { locate_friends_enabled: true, map_crowd_flow_enabled: true, map_search_enabled: true };
    knobs.userId = 'user-1';
    knobs.tripStops = STOPS;
    knobs.entitiesSource = 'legacy';
    await mount();

    await waitFor(() => expect(screen.getByTestId('map-carousel')).toBeTruthy());
    expect(screen.queryByTestId('time-machine-control')).toBeNull();
  });

  it('opens the scrubber once the gateway answers (source: gateway)', async () => {
    // The producer GET /api/map/projection/temporal is the source §15 never had.
    // When the projection gateway answers, that sibling endpoint is reachable,
    // so the mode opens — even before the user scrubs to an offset with data,
    // because an empty offset is an honest empty state, not a closed mode.
    knobs.params = { tripId: 'trip-1' };
    knobs.userId = 'user-1';
    knobs.entitiesSource = 'gateway';
    await mount();

    await waitFor(() => expect(screen.getByTestId('map-carousel')).toBeTruthy());
    expect(screen.queryByTestId('time-machine-control')).not.toBeNull();
  });
});
