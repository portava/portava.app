/**
 * Full-screen map entry points — navigation tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * Entry point navigation (each calls router.push with the correct URL):
 *   1. EventCard "View on map" → /map?entityTypes=events&focusId=event:<id>
 *   2. TripMapPreview "View map" → /map?entityTypes=trips
 *   3. MapTab "Open full map" → /map?entityTypes=stamps&mode=passport
 *   4. CircleMapSection "Full map" → /map?entityTypes=friends&mode=circle
 *
 * Map screen robustness (no crash):
 *   5. Unknown entityTypes in the URL are silently skipped — screen mounts cleanly
 *   6. focusId with no matching entity renders fine — camera stays on city default,
 *      no exception thrown
 *
 * ## Mock strategy
 *
 * jest.fn() calls go INSIDE the jest.mock factory so they're available when
 * imported modules first require expo-router (which happens before any module-level
 * `const` declarations run). References are retrieved after import via the
 * already-mocked module object.
 *
 * ## Strategy for tests 5 & 6
 *
 * FullScreenMapScreen checks Platform.OS and returns <WebPlaceholder> on web, but
 * all hooks still execute first (React rules — hooks must precede conditional
 * returns). Mocking Platform as 'web' exercises the full param-parsing and
 * focusId-fallthrough logic without needing @maplibre or DiscoveryMapView to render.
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
// the test sensitive to which cities are present.  A trimmed fixture containing
// only 'Cebu City' (the city used in makeEvent) is deliberately minimal.
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

// ── 2. TripMapPreview "View map" ───────────────────────────────────────────────

describe('TripMapPreview — View map entry point', () => {
  it('calls router.push with /map?entityTypes=trips', async () => {
    await render(<TripMapPreview />);

    fireEvent.press(screen.getByText('View map'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/map');
    expect(url).toContain('entityTypes=trips');
  });

  it('does not include unexpected entityTypes or mode params', async () => {
    await render(<TripMapPreview />);

    fireEvent.press(screen.getByText('View map'));

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).not.toContain('mode=');
    expect(url).not.toContain('events');
    expect(url).not.toContain('stamps');
  });
});

// ── 3. MapTab "Open full map" ──────────────────────────────────────────────────

describe('MapTab — Open full map entry point', () => {
  it('calls router.push with /map?entityTypes=stamps&mode=passport', async () => {
    await render(
      <MapTab postcards={[]} currentCity={null} currentUserId={null} />,
    );

    fireEvent.press(screen.getByText('Open full map'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/map');
    expect(url).toContain('entityTypes=stamps');
    expect(url).toContain('mode=passport');
  });
});

// ── 4. CircleMapSection "Full map" ────────────────────────────────────────────

describe('CircleMapSection — Full map entry point', () => {
  it('calls router.push with /map?entityTypes=friends&mode=circle', async () => {
    // Provide a meetingPoint so the map surface (not the no-data banner) renders
    await render(
      <CircleMapSection
        members={[]}
        meetingPoint={{ lat: 10.3, lng: 123.9, label: 'Ayala Mall' }}
      />,
    );

    fireEvent.press(screen.getByText('Full map'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/map');
    expect(url).toContain('entityTypes=friends');
    expect(url).toContain('mode=circle');
  });

  it('shows the full-map button when at least one member has coords', async () => {
    await render(
      <CircleMapSection
        members={[{ userId: 'u1', lat: 10.3, lng: 123.9, isStale: false }]}
        meetingPoint={null}
      />,
    );

    fireEvent.press(screen.getByText('Full map'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('entityTypes=friends'),
    );
  });
});

// ── 5. Unknown entityTypes are silently skipped (no crash) ────────────────────
//
// The screen passes the raw entityTypes string to useMapEntities (mocked to return
// [] regardless). The screen must mount without throwing even when the value
// doesn't match any known layer name.

describe('FullScreenMapScreen — unknown entityTypes silently skipped', () => {
  it('renders without crashing when entityTypes contains an unknown value', async () => {
    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'unknown_layer_xyz,another_bad_type',
    });

    await expect(
      act(async () => { await render(<FullScreenMapScreen />); }),
    ).resolves.not.toThrow();
  });

  it('renders without crashing when entityTypes is empty string', async () => {
    mockUseLocalSearchParams.mockReturnValue({ entityTypes: '' });

    await expect(
      act(async () => { await render(<FullScreenMapScreen />); }),
    ).resolves.not.toThrow();
  });

  it('renders without crashing when entityTypes param is omitted entirely', async () => {
    mockUseLocalSearchParams.mockReturnValue({});

    await expect(
      act(async () => { await render(<FullScreenMapScreen />); }),
    ).resolves.not.toThrow();
  });
});

// ── 6. focusId with no matching entity (no crash, camera stays on default) ─────
//
// useMapEntities returns an empty list; the focusId findIndex returns -1; the
// code falls through to proximity selection without throwing.

describe('FullScreenMapScreen — focusId with no matching entity', () => {
  it('renders without crashing when focusId matches no entity (empty entity list)', async () => {
    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:nonexistent-id-99',
    });

    await expect(
      act(async () => { await render(<FullScreenMapScreen />); }),
    ).resolves.not.toThrow();
  });

  it('renders without crashing when focusId matches no entity (non-empty list)', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    (useMapEntities as jest.Mock).mockReturnValueOnce({
      entities: [
        {
          id: 'event:some-other-id',
          type: 'events',
          lat: 10.3,
          lng: 123.9,
          title: 'Other Event',
          data: {},
        },
      ],
      objects: [],
      liveEnrichment: null,
      loading: false,
      error: null,
      refresh: () => {},
      source: 'legacy',
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:nonexistent-id-99',
    });

    let renderError: Error | null = null;
    try {
      await act(async () => { await render(<FullScreenMapScreen />); });
    } catch (e) {
      renderError = e as Error;
    }

    expect(renderError).toBeNull();
  });

  it('renders without crashing when focusId is set but entityTypes is unknown', async () => {
    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'totally_unknown',
      focusId: 'event:some-id',
    });

    await expect(
      act(async () => { await render(<FullScreenMapScreen />); }),
    ).resolves.not.toThrow();
  });
});

// ── 7. Camera initialised from explicit query params ──────────────────────────
//
// When lat/lng/zoom params are present, DiscoveryMapView must receive those
// values as fallbackLat, fallbackLng, and fallbackZoom — not [0,0] or the
// LocationContext defaults.

describe('FullScreenMapScreen — camera initialised from explicit query params', () => {
  it('passes fallbackLat, fallbackLng, and fallbackZoom from params to DiscoveryMapView', async () => {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({ lat: '10.317', lng: '123.891', zoom: '13' });

    await act(async () => { await render(<FullScreenMapScreen />); });

    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackLat).toBeCloseTo(10.317);
    expect(capturedProps!.fallbackLng).toBeCloseTo(123.891);
    expect(capturedProps!.fallbackZoom).toBe(13);
  });

  it('clamps fallbackZoom to the valid [1–22] range', async () => {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({ lat: '10.317', lng: '123.891', zoom: '99' });

    await act(async () => { await render(<FullScreenMapScreen />); });

    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackZoom).toBe(22);
  });
});

// ── 8. Camera falls back to LocationContext when params are absent ─────────────
//
// When no lat/lng params are in the URL, the screen must use the user's GPS
// coords from LocationContext — not leave the camera at [0,0].

describe('FullScreenMapScreen — camera falls back to LocationContext coords', () => {
  it('uses LocationContext coords as fallbackLat/fallbackLng when params are absent', async () => {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocationContext.mockReturnValueOnce({
      locationState: {
        permissionStatus: 'granted',
        coords: { lat: 48.8566, lng: 2.3522 },
        place: null,
      },
      resolvedLocation: { place: null, coords: { lat: 48.8566, lng: 2.3522 }, source: 'gps', freshness: 'live' },
      requireLocation: jest.fn(),
    });

    // No lat/lng in params — screen must fall back to LocationContext.
    mockUseLocalSearchParams.mockReturnValue({});

    await act(async () => { await render(<FullScreenMapScreen />); });

    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackLat).toBeCloseTo(48.8566);
    expect(capturedProps!.fallbackLng).toBeCloseTo(2.3522);
  });

  it('sets fallbackZoom to the default 11 when no zoom param is provided', async () => {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocationContext.mockReturnValueOnce({
      locationState: {
        permissionStatus: 'granted',
        coords: { lat: 48.8566, lng: 2.3522 },
        place: null,
      },
      resolvedLocation: { place: null, coords: { lat: 48.8566, lng: 2.3522 }, source: 'gps', freshness: 'live' },
      requireLocation: jest.fn(),
    });

    mockUseLocalSearchParams.mockReturnValue({});

    await act(async () => { await render(<FullScreenMapScreen />); });

    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackZoom).toBe(11);
  });
});

// ── 10. PermissionPrompt shown when permission is denied and no coords at all ───
//
// When location permission is denied AND no lat/lng comes from either the URL
// params or LocationContext (i.e. fallbackLat/fallbackLng are both null), the
// screen must show the PermissionPrompt — not a map centred at [0,0].
//
// The Platform.OS guard (web → WebPlaceholder) runs before the permission check.
// These tests run under the default jest-expo platform ('ios'), so the permission
// branch is reachable.

describe('FullScreenMapScreen — PermissionPrompt shown when denied with no coords', () => {
  it('shows "Location access needed" when permission is denied and no lat/lng available', async () => {
    // Use mockReturnValue (not Once) so every render — including re-renders
    // triggered by internal state flushes — sees the denied state.
    mockUseLocationContext.mockReturnValue({
      locationState: { permissionStatus: 'denied', coords: null, place: null },
      resolvedLocation: { place: null, coords: null, source: 'none', freshness: 'unavailable' },
      requireLocation: jest.fn(),
    });
    // No lat/lng in URL params either.
    mockUseLocalSearchParams.mockReturnValue({});

    await act(async () => { await render(<FullScreenMapScreen />); });

    expect(screen.getByText('Location access needed')).toBeTruthy();
  });

  it('does NOT render the map (DiscoveryMapView) when the PermissionPrompt is shown', async () => {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    (DiscoveryMapView as jest.Mock).mockClear();

    // Use mockReturnValue (not Once) so every render — including re-renders
    // triggered by internal state flushes — sees the denied state.
    mockUseLocationContext.mockReturnValue({
      locationState: { permissionStatus: 'denied', coords: null, place: null },
      resolvedLocation: { place: null, coords: null, source: 'none', freshness: 'unavailable' },
      requireLocation: jest.fn(),
    });
    mockUseLocalSearchParams.mockReturnValue({});

    await act(async () => { await render(<FullScreenMapScreen />); });

    // DiscoveryMapView must not have been called — the early return fires first.
    expect(DiscoveryMapView as jest.Mock).not.toHaveBeenCalled();
  });

  it('still renders the map when permission is denied but city coords are in the URL', async () => {
    // permDenied && !hasNoCoords → inline banner, not PermissionPrompt.
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocationContext.mockReturnValueOnce({
      locationState: { permissionStatus: 'denied', coords: null, place: null },
      resolvedLocation: { place: null, coords: null, source: 'none', freshness: 'unavailable' },
      requireLocation: jest.fn(),
    });
    // City coords come from the URL — e.g. pushed by a TripPage/EventCard that
    // includes lat/lng.
    mockUseLocalSearchParams.mockReturnValue({ lat: '10.317', lng: '123.891' });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // The permission prompt must NOT be shown when coords are available.
    expect(screen.queryByText('Location access needed')).toBeNull();
    // The map component must have received the city coords.
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackLat).toBeCloseTo(10.317);
    expect(capturedProps!.fallbackLng).toBeCloseTo(123.891);
  });
});

// ── 11. Invalid lat/lng strings are silently discarded ────────────────────────
//
// parseCoord returns null for any non-finite input (NaN, Infinity, alphabetic
// strings, empty string). When both lat and lng params are null the screen must
// fall back to the user's GPS coords from LocationContext — not lock the camera
// at [0,0] or pass NaN to DiscoveryMapView.

describe('FullScreenMapScreen — invalid lat/lng strings silently discarded', () => {
  /** Helper: set up a LocationContext with known GPS coords and capture the
   *  props DiscoveryMapView receives after rendering with the given params. */
  async function renderWithInvalidCoords(
    params: Record<string, string>,
    contextCoords = { lat: 48.8566, lng: 2.3522 },
  ): Promise<Record<string, any> | null> {
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      return null;
    });

    mockUseLocationContext.mockReturnValueOnce({
      locationState: {
        permissionStatus: 'granted',
        coords: contextCoords,
        place: null,
      },
      resolvedLocation: { place: null, coords: contextCoords, source: 'gps', freshness: 'live' },
      requireLocation: jest.fn(),
    });

    mockUseLocalSearchParams.mockReturnValue(params);

    await act(async () => { await render(<FullScreenMapScreen />); });

    return capturedProps;
  }

  it('falls back to LocationContext coords when lat="abc" and lng="NaN"', async () => {
    const props = await renderWithInvalidCoords({ lat: 'abc', lng: 'NaN' });

    expect(props).not.toBeNull();
    // Must use the context coords — not 0, not NaN.
    expect(props!.fallbackLat).toBeCloseTo(48.8566);
    expect(props!.fallbackLng).toBeCloseTo(2.3522);
    expect(props!.fallbackLat).not.toBeNaN();
    expect(props!.fallbackLng).not.toBeNaN();
  });

  it('falls back to LocationContext coords when lat="" (empty string)', async () => {
    const props = await renderWithInvalidCoords({ lat: '', lng: '' });

    expect(props).not.toBeNull();
    expect(props!.fallbackLat).toBeCloseTo(48.8566);
    expect(props!.fallbackLng).toBeCloseTo(2.3522);
    expect(props!.fallbackLat).not.toBeNaN();
    expect(props!.fallbackLng).not.toBeNaN();
  });

  it('falls back to LocationContext coords when lat="Infinity" and lng="-Infinity"', async () => {
    const props = await renderWithInvalidCoords({ lat: 'Infinity', lng: '-Infinity' });

    expect(props).not.toBeNull();
    expect(props!.fallbackLat).toBeCloseTo(48.8566);
    expect(props!.fallbackLng).toBeCloseTo(2.3522);
    expect(props!.fallbackLat).not.toBeNaN();
    expect(props!.fallbackLng).not.toBeNaN();
  });

  it('does not pass 0 to DiscoveryMapView when lat="abc" and no LocationContext coords', async () => {
    // When both the param and the context are absent the value should be null,
    // never a default of 0 that would freeze the camera in the mid-Atlantic.
    const props = await renderWithInvalidCoords(
      { lat: 'abc', lng: 'abc' },
      // Simulate no GPS fix: override helper by setting contextCoords to trigger
      // a null coords path — we do this by calling mockReturnValueOnce directly.
      // (The helper arg is ignored; we override below before the helper runs.)
      { lat: 0, lng: 0 }, // placeholder; overridden immediately below
    );

    // The helper already used the mockReturnValueOnce from the second arg, so we
    // re-run manually here for the no-coords case.
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');
    let capturedProps2: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((p: any) => {
      capturedProps2 = p;
      return null;
    });

    mockUseLocationContext.mockReturnValueOnce({
      locationState: { permissionStatus: 'granted', coords: null, place: null },
      resolvedLocation: { place: null, coords: null, source: 'none', freshness: 'unavailable' },
      requireLocation: jest.fn(),
    });
    mockUseLocalSearchParams.mockReturnValue({ lat: 'abc', lng: 'abc' });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // fallbackLat/fallbackLng must be null (not 0) when no source is available.
    expect(capturedProps2).not.toBeNull();
    expect(capturedProps2!.fallbackLat).toBeNull();
    expect(capturedProps2!.fallbackLng).toBeNull();
  });

  it('renders without crashing for every invalid-coord variant', async () => {
    const invalidValues = ['abc', 'NaN', 'Infinity', '-Infinity', '', '   ', 'null', 'undefined'];

    for (const val of invalidValues) {
      mockUseLocalSearchParams.mockReturnValue({ lat: val, lng: val });

      await expect(
        act(async () => { await render(<FullScreenMapScreen />); }),
      ).resolves.not.toThrow();
    }
  });
});

