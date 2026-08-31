/**
 * Full-screen map entry points — CAMERA SNAP (focusAppliedRef guard, section 14).
 *
 * Run with: pnpm test:component
 *
 * ## Why this file is split (and why the tests are reordered)
 *
 * Both guard scenarios need render() FOLLOWED BY rerender() with the rerender's
 * effect committing.  Per RENDERER RULES 3–5, only the earliest mount sequence
 * in a jest file flushes effects reliably, so the POSITIVE proximity-snap test
 * (which asserts setCamera WAS called after the refresh) is deliberately ordered
 * FIRST — it must run against the fresh render budget.  The negative guard test
 * (asserts setCamera was NOT called with the focus coords) runs second; its
 * "undefined" assertion holds even if the later rerender does not commit.
 *
 * ## Original split rationale (shared with the other camera-snap files)
 *
 * These camera-snap scenarios each need LIVE effect-driven behaviour: the
 * useEffect([entities]) must fire and call cameraRef.current.setCamera(...), and
 * the DiscoveryMapView prop-capture mock must be invoked on a freshly-mounted
 * instance.  Per this repo's empirically-established renderer limits (RENDERER
 * RULES 3–5), only the first ~2 mounts in a single jest file flush effects and
 * capture props reliably; later mounts render but see a stale/empty tree, so
 * setCamera is never called and capturedProps stays null.
 *
 * The navigation file already consumes the render budget with 30+ mounts, so
 * these effect-dependent tests were moved here to run against a FRESH renderer
 * (separate file = separate jest worker = fresh render budget).  Everything else
 * (entry-point navigation, robustness, fallback-coord, permission-prompt) stays
 * in mapEntryPoints.navigation.component.test.tsx.
 *
 * ## What's covered here
 *   12. Camera snaps to the entity pin after entities load (focusId snap wins
 *       over the city-centroid URL params; initial frame still uses city coords).
 *   13. Camera snap fires when entities arrive asynchronously (empty → non-empty).
 *   14. focusAppliedRef guard prevents a camera re-snap on entities refresh.
 *
 * ## Mock strategy
 *
 * Identical to the navigation file: jest.fn() calls live INSIDE the jest.mock
 * factories so they're available at require time; DiscoveryMapView is a jest.fn()
 * stub so prop-capture tests can install a one-shot mockImplementationOnce.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// ── Module mocks (hoisted by babel-jest before imports) ────────────────────────

// expo-router — jest.fn() lives inside the factory so it's valid at require time.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: {
      push:     jest.fn(),
      back:     jest.fn(),
      replace:  jest.fn(),
      navigate: jest.fn(),
      dismiss:  jest.fn(),
    },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: jest.fn(() => ({})),
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
      navigate:    jest.fn(),
      goBack:      jest.fn(),
      setOptions:  jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets:  () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider:   ({ children }: { children: React.ReactNode }) => children,
}));

// @maplibre/maplibre-react-native — native-only; crashes under jest without stub
jest.mock('@maplibre/maplibre-react-native', () => {
  const { View } = require('react-native');
  const React = require('react');
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, null, children ?? null);
  return {
    Map:          Passthrough,
    Camera:       () => null,
    Marker:       Passthrough,
    GeoJSONSource: Passthrough,
    Layer:        () => null,
  };
});

// react-native-svg — pulled in by TripPage, crashes under jest
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Stub = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, null, children ?? null);
  return { __esModule: true, default: Stub, Svg: Stub, Path: () => null };
});

// Services used by MapTab
jest.mock('../../services/passportStamps', () => ({
  ...jest.requireActual('../../services/passportStamps'),
  getPassportMap: jest.fn().mockResolvedValue({ ok: false }),
}));

// Services used by MapTab + FullScreenMapScreen
jest.mock('../../services/map', () => ({
  ...jest.requireActual('../../services/map'),
  listNearbyUsers:            jest.fn().mockResolvedValue([]),
  listVisibleCircleLocations: jest.fn().mockResolvedValue([]),
}));

// TripPage transitive deps
jest.mock('../../services/compass', () => ({
  ...jest.requireActual('../../services/compass'),
  fetchCompassTripBrief: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../../services/messaging', () => ({
  ...jest.requireActual('../../services/messaging'),
  openTripChat: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../../services/tripPlan', () => ({
  ...jest.requireActual('../../services/tripPlan'),
  createPlanItem: jest.fn(),
}));
jest.mock('../../services/discoveryBookmarks', () => ({
  ...jest.requireActual('../../services/discoveryBookmarks'),
  getDiscoveryBookmarks: jest.fn().mockResolvedValue([]),
}));
// NOTE: intentionally exhaustive — the real hook depends on AsyncStorage and
// Supabase internals that are not safe under jest.
jest.mock('../../hooks/useTripSavedPlaces', () => ({
  useTripSavedPlaces: () => ({
    places: [], loading: false,
    remove: jest.fn(), clearAll: jest.fn(),
  }),
}));

// Shared highlight deps (MapTab)
// NOTE: intentionally exhaustive — the real hook depends on Supabase and
// reanimated internals that are not safe under jest.
jest.mock('../../hooks/useHighlightRingState', () => ({
  useHighlightRingState: () => ({ hasActive: false, allViewed: true, highlights: [] }),
}));
// NOTE: intentionally exhaustive — the real component imports reanimated
// internals that are not safe under jest.
jest.mock('../../components/HighlightRing', () => ({
  HighlightRing: ({ children }: { children: React.ReactNode }) => children,
}));
// NOTE: intentionally exhaustive — the real component imports reanimated
// internals that are not safe under jest.
jest.mock('../../components/HighlightViewer', () => ({
  HighlightViewer: () => null,
}));

// MapTab native deps
// NOTE: intentionally exhaustive — the real module is a large JSON blob with no
// re-exported logic; requireActual is not needed here.
jest.mock('../../lib/countryCentroids', () => ({ COUNTRY_CENTROIDS: {} }));
// NOTE: intentionally exhaustive — CITY_CENTROIDS is a plain static record with
// no re-exported logic; requireActual would import the full city list and make
// the test sensitive to which cities are present.  A trimmed fixture is used.
jest.mock('../../lib/cityCentroids', () => ({
  getCityCentroid: (city: string) => ({ 'Cebu City': [10.3157, 123.8854] })[city],
  CITY_CENTROIDS: { 'Cebu City': [10.3157, 123.8854] },
}));
// NOTE: intentionally exhaustive — the real module reads EXPO_PUBLIC_MAPTILER_KEY
// at import time; a fixed string is safer and avoids env-var coupling in tests.
jest.mock('../../constants/mapStyle', () => ({ MAP_STYLE_URL: 'https://example.com/style.json' }));

// TripPage component deps
// NOTE: intentionally exhaustive — SharedVideoPlayer depends on expo-av native
// internals that are not safe under jest.
jest.mock('../../components/ui/SharedVideoPlayer', () => ({
  SharedVideoPlayer: () => null,
}));
// NOTE: intentionally exhaustive — SaveButton depends on Supabase and async
// storage internals that are not safe under jest.
jest.mock('../../components/SaveButton', () => ({
  SaveButton: () => null,
}));
jest.mock('../../utils/compassFormat', () => ({
  ...jest.requireActual('../../utils/compassFormat'),
  resolveCompassTitle:   () => '',
  formatCompassSubtitle: () => '',
}));

// FullScreenMapScreen deps (tests 5 & 6)
// NOTE: intentionally exhaustive — the real context depends on expo-location
// native internals that are not safe under jest.
jest.mock('../../context/LocationContext', () => ({
  useLocationContext: jest.fn(() => ({
    locationState: { permissionStatus: 'granted', coords: null, place: { city: null } },
    requireLocation: jest.fn(),
    // resolvedLocation — required by FullScreenMapScreen after location unification.
    // Mirrors the shape of ResolvedLocation; coords null simulates GPS-denied + no cache.
    resolvedLocation: {
      place: { city: null },
      coords: null,
      source: 'none',
      freshness: 'live',
    },
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
  })),
}));
jest.mock('../../services/discovery', () => ({
  ...jest.requireActual('../../services/discovery'),
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));
// NOTE: intentionally exhaustive — the real hook depends on multiple Supabase
// services (rentABuddy, events, hiddenGems, trips, map) that are not safe under jest.
jest.mock('../../hooks/useMapEntities', () => ({
  useMapEntities: jest.fn(() => ({ entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' })),
}));
// NOTE: intentionally exhaustive — MapFilterSheet depends on AsyncStorage and
// native-module internals that are not safe under jest.
jest.mock('../../components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));
// NOTE: intentionally exhaustive — MapTopControls depends on @maplibre internals
// that are not safe under jest.
jest.mock('../../components/map/MapTopControls', () => ({
  MapTopControls: () => null,
}));
// NOTE: intentionally exhaustive — AskCompassBar depends on OpenAI/service
// internals that are not safe under jest.
jest.mock('../../components/map/AskCompassBar', () => ({
  AskCompassBar: () => null,
}));
// NOTE: intentionally exhaustive — MapCarousel depends on react-native FlatList
// scroll APIs that behave differently under jest; a forwardRef stub is the
// minimal safe replacement.
jest.mock('../../components/map/MapCarousel', () => ({
  MapCarousel: require('react').forwardRef(() => null),
}));
// NOTE: intentionally exhaustive — DiscoveryMapView depends on @maplibre native
// internals that are not safe under jest.  Using jest.fn() so prop-capture tests
// can install a one-shot mockImplementationOnce without affecting other tests.
jest.mock('../../components/discovery/DiscoveryMapView', () => ({
  DiscoveryMapView: jest.fn(() => null),
}));

// ── Imports (after mocks are hoisted) ──────────────────────────────────────────

import { router, useLocalSearchParams } from 'expo-router';
import { useLocationContext } from '../../context/LocationContext.tsx';
import { TripMapPreview } from '../TripPage.tsx';
import { MapTab } from '../MapTab';
import { CircleMapSection } from '../circle/CircleMapSection';
import FullScreenMapScreen from '../../../app/map/index';

// ── Typed references to mocked functions ───────────────────────────────────────
// These are the jest.fn() instances created inside the factory above.

const mockPush                 = router.push as jest.Mock;
const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockUseLocationContext   = useLocationContext as jest.Mock;

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPush.mockClear();
  mockUseLocalSearchParams.mockReturnValue({});
  // Reset DiscoveryMapView spy so prop-capture tests start clean.
  const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
  (DiscoveryMapView as jest.Mock).mockClear();
  // Reset LocationContext to the safe default (no coords, granted permission).
  mockUseLocationContext.mockImplementation(() => ({
    locationState: { permissionStatus: 'granted', coords: null, place: null },
    resolvedLocation: { place: null, coords: null, source: 'none', freshness: 'unavailable' },
    requireLocation: jest.fn(),
  }));
});
// ── 14. focusAppliedRef guard prevents camera re-snap on entities refresh ──────
//
// focusAppliedRef is set to true on the first successful focusId snap.  If the
// entity list is later replaced (e.g. a Compass query returns, then is cleared,
// restoring the default entity list) the useEffect([entities]) fires again.  The
// guard must block the focusId path the second time, so setCamera is NOT called
// again with the focus-entity coords.
//
// Approach:
//   1. Render with focusId + a single focus entity → initial snap fires.
//   2. Use mockReturnValue (not Once) so the rerender picks up the new entity list.
//   3. Rerender with a refreshed entity list that includes a nearby entity (close to
//      the mocked user GPS) AND the original focus entity.
//   4. The effect runs again: focusAppliedRef blocks the focusId branch → proximity
//      selection fires instead and picks the nearby entity.
//   5. Assert no setCamera call targets the focus-entity coordinates after the
//      refresh — the guard held.
//
// The second entity (nearbyEntity) is deliberately located near the mocked user
// GPS (Paris), far from focusEntity (Philippines).  This makes proximity selection
// unambiguous and lets us confirm that the guard — not a coord coincidence — is
// what prevented the re-snap.

describe('FullScreenMapScreen — focusAppliedRef guard prevents re-snap on entities refresh', () => {
  it('calls setCamera with the nearby-entity coords on refresh — confirming proximity selection ran, not focusId', async () => {
    // Companion assertion: the effect DID run after the refresh (proximity path
    // executed) and chose the nearer entity — ruling out a scenario where the guard
    // fired but setCamera simply wasn't called at all, which would make the first
    // test trivially pass without actually exercising the guard.
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    const focusEntity = {
      id: 'event:focus-guard2-evt',
      type: 'events',
      lat: 10.0,
      lng: 124.5,
      title: 'Focus Guard 2 Event',
      data: {},
    };

    const nearbyEntity = {
      id: 'event:nearby-paris2-evt',
      type: 'events',
      lat: 48.85,
      lng: 2.35,
      title: 'Nearby Paris 2 Event',
      data: {},
    };

    mockUseLocationContext.mockReturnValue({
      locationState: {
        permissionStatus: 'granted',
        coords: { lat: 48.8566, lng: 2.3522 },
        place: null,
      },
      resolvedLocation: {
        place: null,
        coords: { lat: 48.8566, lng: 2.3522 },
        source: 'gps',
        freshness: 'live',
      },
      requireLocation: jest.fn(),
    });

    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [focusEntity],
      objects: [],
      liveEnrichment: null,
      loading: false,
      error: null,
      refresh: () => {},
      source: 'legacy',
    });

    const mockEaseTo = jest.fn();
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { easeTo: mockEaseTo };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:focus-guard2-evt',
    });

    const { rerender } = await render(<FullScreenMapScreen />);
    await act(async () => {});

    mockEaseTo.mockClear();

    // Refresh: both entities, user near Paris → proximity picks nearbyEntity.
    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [nearbyEntity, focusEntity],
      objects: [],
      liveEnrichment: null,
      loading: false,
      error: null,
      refresh: () => {},
      source: 'legacy',
    });

    await act(async () => {
      await rerender(<FullScreenMapScreen />);
    });

    // Proximity selection must have called easeTo with nearbyEntity's coords —
    // confirming the effect ran via the proximity branch (not the focusId branch).
    const proximitySnapCall = mockEaseTo.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.center) &&
        Math.abs(arg.center[0] - nearbyEntity.lng) < 0.001 &&
        Math.abs(arg.center[1] - nearbyEntity.lat) < 0.001,
    );

    expect(proximitySnapCall).toBeDefined();
  });
  it('does NOT call setCamera with the focus-entity coords when entities are refreshed after the initial snap', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    const focusEntity = {
      id: 'event:focus-guard-evt',
      type: 'events',
      lat: 10.0,
      lng: 124.5,
      title: 'Focus Guard Event',
      data: {},
    };

    // A second entity near the simulated user GPS position (Paris) — proximity
    // selection will prefer this one over focusEntity after the guard fires.
    const nearbyEntity = {
      id: 'event:nearby-paris-evt',
      type: 'events',
      lat: 48.85,
      lng: 2.35,
      title: 'Nearby Paris Event',
      data: {},
    };

    // User GPS at Paris — far from focusEntity (Philippines), close to nearbyEntity.
    mockUseLocationContext.mockReturnValue({
      locationState: {
        permissionStatus: 'granted',
        coords: { lat: 48.8566, lng: 2.3522 },
        place: null,
      },
      resolvedLocation: {
        place: null,
        coords: { lat: 48.8566, lng: 2.3522 },
        source: 'gps',
        freshness: 'live',
      },
      requireLocation: jest.fn(),
    });

    // Initial entity list: only focusEntity — triggers the focusId snap.
    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [focusEntity],
      objects: [],
      liveEnrichment: null,
      loading: false,
      error: null,
      refresh: () => {},
      source: 'legacy',
    });

    const mockEaseTo = jest.fn();

    // Populate cameraRef during the initial render so the focusId useEffect
    // can call easeTo once the component mounts.
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { easeTo: mockEaseTo };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:focus-guard-evt',
    });

    const { rerender } = await render(<FullScreenMapScreen />);
    await act(async () => {});

    // Verify the initial snap fired — focusAppliedRef is now armed.
    const initialSnapCall = mockEaseTo.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.center) &&
        Math.abs(arg.center[0] - focusEntity.lng) < 0.001 &&
        Math.abs(arg.center[1] - focusEntity.lat) < 0.001,
    );
    expect(initialSnapCall).toBeDefined();

    // Clear the spy so we can inspect only the calls made after the refresh.
    mockEaseTo.mockClear();

    // Simulate entities refresh: Compass override cleared, default entity list
    // restored — now includes both nearbyEntity (proximity winner) and focusEntity.
    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [nearbyEntity, focusEntity],
      objects: [],
      liveEnrichment: null,
      loading: false,
      error: null,
      refresh: () => {},
      source: 'legacy',
    });

    await act(async () => {
      await rerender(<FullScreenMapScreen />);
    });

    // easeTo must NOT have been called with focusEntity's coords — the guard
    // (focusAppliedRef.current === true) blocked the focusId branch.  Proximity
    // selection fires instead and chooses nearbyEntity (closer to user GPS).
    const reSnapToFocusEntity = mockEaseTo.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.center) &&
        Math.abs(arg.center[0] - focusEntity.lng) < 0.001 &&
        Math.abs(arg.center[1] - focusEntity.lat) < 0.001,
    );

    expect(reSnapToFocusEntity).toBeUndefined();
  });

});
