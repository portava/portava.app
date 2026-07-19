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
  useMapEntities: jest.fn(() => ({ entities: [] })),
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
import { EventCard } from '../EventCard.tsx';
import { TripMapPreview } from '../TripPage.tsx';
import { MapTab } from '../MapTab';
import { CircleMapSection } from '../circle/CircleMapSection';
import FullScreenMapScreen from '../../../app/map/index';

// ── Typed references to mocked functions ───────────────────────────────────────
// These are the jest.fn() instances created inside the factory above.

const mockPush                 = router.push as jest.Mock;
const mockUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockUseLocationContext   = useLocationContext as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(id = 'evt-1') {
  return {
    id,
    title: 'Rooftop Jazz Night',
    category: 'Nightlife',
    startAt: new Date('2026-09-01T20:00:00Z').toISOString(),
    city: 'Cebu City',
    attendeeCount: 12,
    capacity: null,
    host: null,
  };
}

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

// ── 1. EventCard "View on map" ─────────────────────────────────────────────────

describe('EventCard — View on map entry point', () => {
  it('calls router.push with /map?entityTypes=events&focusId=event:<id>', async () => {
    await render(<EventCard ev={makeEvent('abc-123')} />);

    fireEvent.press(screen.getByText('View on map'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toContain('/map');
    expect(url).toContain('entityTypes=events');
    expect(url).toContain('focusId=event%3Aabc-123');
  });

  it('includes the prefixed focusId so useMapEntities key-lookup matches', async () => {
    await render(<EventCard ev={makeEvent('xyz-999')} />);

    fireEvent.press(screen.getByText('View on map'));

    const decoded = decodeURIComponent(mockPush.mock.calls[0][0] as string);
    expect(decoded).toContain('focusId=event:xyz-999');
  });
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

// ── 9. EventCard "View on map" — city coords forwarded in the push URL ──────────
//
// EventCard derives lat/lng from the event's city via CITY_CENTROIDS and appends
// them to the /map push URL.  This gives the map camera an immediate starting
// position (the city view) while useMapEntities is still loading and the focusId
// snap hasn't resolved yet — preventing a blank-ocean first frame.
//
// When the city is not in the centroid map the params are omitted so the map
// falls back to the user's GPS location as normal.

describe('EventCard — city coords forwarded in the /map push URL', () => {
  it('includes lat and lng in the /map push URL for an event with a known city', async () => {
    // makeEvent uses city: 'Cebu City', which is present in the mocked CITY_CENTROIDS.
    await render(<EventCard ev={makeEvent('lat-check-id')} />);

    fireEvent.press(screen.getByText('View on map'));

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toMatch(/[?&]lat=/);
    expect(url).toMatch(/[?&]lng=/);
    // The values must match the Cebu City centroid from the mock.
    expect(url).toContain('lat=10.3157');
    expect(url).toContain('lng=123.8854');
  });

  it('omits lat and lng when the city is not in the centroid map', async () => {
    const unknownCityEvent = { ...makeEvent('no-coords-id'), city: 'Atlantis' };
    await render(<EventCard ev={unknownCityEvent} />);

    fireEvent.press(screen.getByText('View on map'));

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).not.toMatch(/[?&]lat=/);
    expect(url).not.toMatch(/[?&]lng=/);
  });

  it('still includes focusId alongside the city coords', async () => {
    await render(<EventCard ev={makeEvent('snap-id-42')} />);

    fireEvent.press(screen.getByText('View on map'));

    const url = mockPush.mock.calls[0][0] as string;
    // focusId must still be present so the map can snap to the entity once loaded.
    expect(url).toContain('focusId=');
    expect(decodeURIComponent(url)).toContain('snap-id-42');
    // And city coords must also be present for the immediate camera position.
    expect(url).toMatch(/[?&]lat=/);
    expect(url).toMatch(/[?&]lng=/);
  });

  it('appends zoom=12 alongside city coords so the map opens at city-street level', async () => {
    // zoom=12 keeps venue pins visible (city-street view).  Without an explicit
    // zoom the map screen defaults to 11 — close enough, but stating 12 here
    // makes the intent unambiguous and prevents a future default-change from
    // silently breaking the fallback experience.
    await render(<EventCard ev={makeEvent('zoom-check-id')} />);

    fireEvent.press(screen.getByText('View on map'));

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).toMatch(/[?&]zoom=12(&|$)/);
  });

  it('omits zoom when the city is not in the centroid map', async () => {
    // No city coords → no zoom override needed; the map falls back to its own
    // default and the user's GPS coords as normal.
    const unknownCityEvent = { ...makeEvent('no-zoom-id'), city: 'Atlantis' };
    await render(<EventCard ev={unknownCityEvent} />);

    fireEvent.press(screen.getByText('View on map'));

    const url = mockPush.mock.calls[0][0] as string;
    expect(url).not.toMatch(/[?&]zoom=/);
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

// ── 12. Camera snaps to the entity pin after entities load ─────────────────────
//
// EventCard pushes city-centroid coords (lat/lng) as the initial camera position
// AND a focusId so the map can snap to the event pin once useMapEntities resolves.
// The snap must WIN over the city centroid: after entities load, cameraRef.setCamera
// must be called with the entity's coords — not the URL's lat/lng.
//
// Approach: DiscoveryMapView mock captures the externalCameraRef and installs a
// setCamera spy on it during rendering, so the ref is populated before the
// useEffect([entities]) fires and calls cameraRef.current?.setCamera(...).

describe('FullScreenMapScreen — camera snaps to entity pin after entities load', () => {
  it('calls setCamera with the entity coords — not the city-centroid URL params — when focusId resolves', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    // Entity at a location deliberately different from the URL city centroid.
    const entityLat = 10.0;
    const entityLng = 124.5;
    (useMapEntities as jest.Mock).mockReturnValueOnce({
      entities: [
        {
          id: 'event:evt-snap-42',
          type: 'events',
          lat: entityLat,
          lng: entityLng,
          title: 'Snap Target Event',
          data: {},
        },
      ],
    });

    const mockSetCamera = jest.fn();

    // Capture the externalCameraRef and populate it so the focusId effect
    // can invoke setCamera after entities load.
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
      }
      return null;
    });

    // URL carries city-centroid coords (Cebu City) + focusId pointing at the entity.
    // The city centroid differs from the entity coords to make the assertion meaningful.
    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      lat: '10.3157',   // city centroid lat — must NOT be the final camera target
      lng: '123.8854',  // city centroid lng — must NOT be the final camera target
      focusId: 'event:evt-snap-42',
    });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // setCamera must have been called at least once (the focusId snap).
    expect(mockSetCamera).toHaveBeenCalled();

    // Find the call that snapped to the entity (there may also be a proximity
    // selection call; look for the one carrying the entity's coordinates).
    const snapCall = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - entityLng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - entityLat) < 0.001,
    );

    expect(snapCall).toBeDefined();
  });

  it('does NOT call setCamera with the city-centroid coords after a focusId snap', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    const entityLat = 9.8;
    const entityLng = 118.7;
    const cityLat   = 10.3157;
    const cityLng   = 123.8854;

    (useMapEntities as jest.Mock).mockReturnValueOnce({
      entities: [
        {
          id: 'event:evt-city-check',
          type: 'events',
          lat: entityLat,
          lng: entityLng,
          title: 'Different-City Event',
          data: {},
        },
      ],
    });

    const mockSetCamera = jest.fn();
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      lat: String(cityLat),
      lng: String(cityLng),
      focusId: 'event:evt-city-check',
    });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // No setCamera call must target the city centroid — once focusId snaps to the
    // entity, the camera must not be reset back to the URL coords.
    const citySnapCall = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - cityLng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - cityLat) < 0.001,
    );

    expect(citySnapCall).toBeUndefined();
  });

  it('still passes the city-centroid coords as fallbackLat/fallbackLng to DiscoveryMapView for the initial frame', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    (useMapEntities as jest.Mock).mockReturnValueOnce({
      entities: [
        {
          id: 'event:evt-initial-frame',
          type: 'events',
          lat: 9.8,
          lng: 118.7,
          title: 'Initial Frame Event',
          data: {},
        },
      ],
    });

    let capturedProps: Record<string, any> | null = null;
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      capturedProps = props;
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: jest.fn() };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      lat: '10.3157',
      lng: '123.8854',
      focusId: 'event:evt-initial-frame',
    });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // The initial camera position (fallbackLat/fallbackLng) must still be the
    // city centroid from the URL — this is what prevents a blank-ocean first frame
    // while useMapEntities is loading.
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.fallbackLat).toBeCloseTo(10.3157);
    expect(capturedProps!.fallbackLng).toBeCloseTo(123.8854);
  });
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

    // First render: hook is still loading — entities is empty.
    (useMapEntities as jest.Mock).mockReturnValueOnce({ entities: [] });
    // Second render (async data arrives): hook now returns the entity.
    (useMapEntities as jest.Mock).mockReturnValueOnce({ entities: [asyncEntity] });

    const mockSetCamera = jest.fn();

    // Install setCamera on the ref on every render so it persists across rerenders.
    (DiscoveryMapView as jest.Mock).mockImplementation((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:evt-async-load',
    });

    const { rerender } = await render(<FullScreenMapScreen />);

    // After the first render entities is [], so the focusId effect finds nothing
    // and must NOT have called setCamera yet.
    expect(mockSetCamera).not.toHaveBeenCalled();

    // Simulate the async load completing: trigger a re-render so the hook now
    // returns the entity list.
    await act(async () => {
      rerender(<FullScreenMapScreen />);
    });

    // The useEffect([entities]) must have fired with the new non-empty list and
    // called setCamera with the entity's coordinates.
    expect(mockSetCamera).toHaveBeenCalled();

    const snapCall = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - entityLng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - entityLat) < 0.001,
    );

    expect(snapCall).toBeDefined();
  });

  it('does not call setCamera on the first render when entities is still empty', async () => {
    const { useMapEntities } = require('../../hooks/useMapEntities.ts');
    const { DiscoveryMapView } = require('../../components/discovery/DiscoveryMapView');

    // Entities never arrive in this test — we only care about the first render.
    (useMapEntities as jest.Mock).mockReturnValue({ entities: [] });

    const mockSetCamera = jest.fn();
    (DiscoveryMapView as jest.Mock).mockImplementation((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:evt-not-yet-loaded',
    });

    await act(async () => { await render(<FullScreenMapScreen />); });

    // With an empty entity list the focusId effect bails early — no snap yet.
    expect(mockSetCamera).not.toHaveBeenCalled();
  });
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
    });

    const mockSetCamera = jest.fn();

    // Populate cameraRef during the initial render so the focusId useEffect
    // can call setCamera once the component mounts.
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
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
    const initialSnapCall = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - focusEntity.lng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - focusEntity.lat) < 0.001,
    );
    expect(initialSnapCall).toBeDefined();

    // Clear the spy so we can inspect only the calls made after the refresh.
    mockSetCamera.mockClear();

    // Simulate entities refresh: Compass override cleared, default entity list
    // restored — now includes both nearbyEntity (proximity winner) and focusEntity.
    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [nearbyEntity, focusEntity],
    });

    await act(async () => {
      rerender(<FullScreenMapScreen />);
    });

    // setCamera must NOT have been called with focusEntity's coords — the guard
    // (focusAppliedRef.current === true) blocked the focusId branch.  Proximity
    // selection fires instead and chooses nearbyEntity (closer to user GPS).
    const reSnapToFocusEntity = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - focusEntity.lng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - focusEntity.lat) < 0.001,
    );

    expect(reSnapToFocusEntity).toBeUndefined();
  });

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
    });

    const mockSetCamera = jest.fn();
    (DiscoveryMapView as jest.Mock).mockImplementationOnce((props: any) => {
      if (props.externalCameraRef) {
        props.externalCameraRef.current = { setCamera: mockSetCamera };
      }
      return null;
    });

    mockUseLocalSearchParams.mockReturnValue({
      entityTypes: 'events',
      focusId: 'event:focus-guard2-evt',
    });

    const { rerender } = await render(<FullScreenMapScreen />);
    await act(async () => {});

    mockSetCamera.mockClear();

    // Refresh: both entities, user near Paris → proximity picks nearbyEntity.
    (useMapEntities as jest.Mock).mockReturnValue({
      entities: [nearbyEntity, focusEntity],
    });

    await act(async () => {
      rerender(<FullScreenMapScreen />);
    });

    // Proximity selection must have called setCamera with nearbyEntity's coords —
    // confirming the effect ran via the proximity branch (not the focusId branch).
    const proximitySnapCall = mockSetCamera.mock.calls.find(
      ([arg]: [any]) =>
        Array.isArray(arg?.centerCoordinate) &&
        Math.abs(arg.centerCoordinate[0] - nearbyEntity.lng) < 0.001 &&
        Math.abs(arg.centerCoordinate[1] - nearbyEntity.lat) < 0.001,
    );

    expect(proximitySnapCall).toBeDefined();
  });
});
