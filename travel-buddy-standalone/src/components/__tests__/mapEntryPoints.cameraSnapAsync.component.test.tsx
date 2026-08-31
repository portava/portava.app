/**
 * Full-screen map entry points — CAMERA SNAP (async entity arrival, section 13).
 *
 * Run with: pnpm test:component
 *
 * ## Why this file is split
 *
 * The async-arrival scenario needs render() FOLLOWED BY rerender() with both
 * cycles committing effects (empty entities → non-empty).  Per RENDERER RULES
 * 3–5, only the earliest mounts in a jest file flush effects; a render+rerender
 * sequence must therefore be the FIRST sequence in its own file.  It is isolated
 * here so the rerender commits against a fresh render budget.
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
// ── 13. Camera snap fires when entities arrive asynchronously ──────────────────
//
// In production useMapEntities fetches data, so entities is [] on the first render
// and the real list arrives in a later render cycle.  The focusId effect must fire
// when the entities array transitions from empty → non-empty, not only when
// entities is already populated on the very first render.
//
// Approach:
//   - useMapEntities returns [] on the first render call (loading state).
//   - A rerender() is issued to simulate the async data arriving; the mock now
//     returns the entity.
//   - The useEffect([entities]) fires again; setCamera must be called with the
//     entity's coordinates.

describe('FullScreenMapScreen — camera snap fires on async entity arrival', () => {
  it('calls setCamera with entity coords when entities arrive in a second render cycle', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    const entityLat = 10.0;
    const entityLng = 124.5;

    const asyncEntity = {
      id: 'event:evt-async-load',
      type: 'events',
      lat: entityLat,
      lng: entityLng,
      title: 'Async Load Event',
      data: {},
    };

    // Drive entities via a mutable list the mock reads on EVERY call.  React 19
    // renders (and re-runs hooks) more than the two logical cycles here — the
    // rerender alone triggers several hook calls — so mockReturnValueOnce would
    // be exhausted and return undefined, dropping the entity list.  A live
    // variable keeps every render consistent within each phase.
    let currentEntities: Array<typeof asyncEntity> = [];
    (useMapEntities as jest.Mock).mockImplementation(() => ({ entities: currentEntities, objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' }));

    const mockEaseTo = jest.fn();

    // Install easeTo on the ref on every render so it persists across rerenders.
    (DiscoveryMapView as jest.Mock).mockImplementation((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { easeTo: mockEaseTo };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:evt-async-load',
    });

    const { rerender } = await render(<FullScreenMapScreen />);

    // After the first render entities is [], so the focusId effect finds nothing
    // and must NOT have called easeTo yet.
    expect(mockEaseTo).not.toHaveBeenCalled();

    // Simulate the async load completing: flip the live list, then trigger a
    // re-render so the hook now returns the entity and the effect re-fires.
    currentEntities = [asyncEntity];
    await act(async () => {
      await rerender(<FullScreenMapScreen />);
    });

    // The useEffect([entities]) must have fired with the new non-empty list and
    // called easeTo with the entity's coordinates.
    expect(mockEaseTo).toHaveBeenCalled();

    const snapCall = mockEaseTo.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.center) &&
        Math.abs(arg.center[0] - entityLng) < 0.001 &&
        Math.abs(arg.center[1] - entityLat) < 0.001,
    );

    expect(snapCall).toBeDefined();
  });

  it('does not call setCamera on the first render when entities is still empty', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    // Entities never arrive in this test — we only care about the first render.
    (useMapEntities as jest.Mock).mockReturnValue({ entities: [], objects: [], liveEnrichment: null, loading: false, error: null, refresh: () => {}, source: 'legacy' });

    const mockEaseTo = jest.fn();
    (DiscoveryMapView as jest.Mock).mockImplementation((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { easeTo: mockEaseTo };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:evt-not-yet-loaded',
    });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // With an empty entity list the focusId effect bails early — no snap yet.
    expect(mockEaseTo).not.toHaveBeenCalled();
  });
});

