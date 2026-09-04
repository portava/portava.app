/**
 * DiscoveryMapView — the camera it tracks actually leaves the component.
 *
 * ## The defect
 *
 * DiscoveryMapView has tracked its own camera zoom since the travelers layer
 * landed — `const [zoom, setZoom] = useState<number | null>(null)`, written by
 * the throttled `onRegionDidChange` handler. Nothing could read it:
 * DiscoveryMapViewProps declared no camera callback, so the value was used for
 * cluster bucketing inside this file and went nowhere else.
 *
 * app/map/index.tsx needs it. Its §17 band culling and its §31 collision
 * viewport both take a zoom, and with no way to learn the real one it fell back
 * to `cameraZoom ?? paramZoom` — a store value written only when the SCREEN
 * commands a camera move, defaulting to the `zoom` query param, which is 11.
 * So "individual places only from district in" was evaluated at city zoom no
 * matter where the user had actually pinched to.
 *
 * ## Why this file exists alongside the screen test
 *
 * app/map/__tests__/renderPipeline.component.test.tsx mocks DiscoveryMapView,
 * so it proves the SCREEN acts on a camera report. It cannot prove one is ever
 * produced — a prop the real component accepts and never calls would satisfy it
 * completely. This file drives the real component and asserts the callback
 * fires, which is the other half.
 *
 * Run: pnpm test:component  (matches --testPathPattern='\.component\.test\.')
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

// ── Module mocks (declared before any import that pulls the real module) ──────

// MapLibre native modules are unavailable under jest. `Map` parks its props in
// a holder so onRegionDidChange can be fired directly: reaching it through a
// real gesture would test MapLibre's event plumbing, not this component's.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const holder: { onRegionDidChange?: (e: unknown) => void } = {};
  const Map = (props: { children?: React.ReactNode; onRegionDidChange?: (e: unknown) => void }) => {
    holder.onRegionDidChange = props.onRegionDidChange;
    return <RN.View testID="map-container">{props.children}</RN.View>;
  };
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { Map, Camera, Marker, __holder: holder };
});

// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation
// native modules that are unavailable under jest; a requireActual spread would
// crash before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));

// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals; spreading requireActual would import native
// modules unavailable in the jest-expo runner.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));

// NOTE: intentionally exhaustive — TravelerPreviewCard imports native
// components that are not safe under jest.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));

// NOTE: intentionally exhaustive — discoverMapFilterStorage's module-level
// memory cache mutates across tests; controlled return values avoid ordering
// dependencies between cases.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { DiscoveryMapView } from '../DiscoveryMapView';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noop = () => {};

/** Manila — matches the fallback coords passed in every case below. */
const AT: [number, number] = [14.5995, 120.9842];

type Camera = { zoom: number; center: { lat: number; lng: number } };

function renderMap(onCameraChange?: (c: Camera) => void) {
  return render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={AT[0]}
      fallbackLng={AT[1]}
      fallbackZoom={11}
      onCameraChange={onCameraChange}
    />,
  );
}

/**
 * Fires the map's real onRegionDidChange with a MapLibre-shaped event.
 *
 * The handler throttles to 250 ms off a monotonic `Date.now()`, so consecutive
 * calls in one test would be swallowed. Rather than fake timers (which the
 * jest-expo renderer does not enjoy), the clock is advanced explicitly.
 */
async function regionDidChange(zoom: number, lng: number, lat: number) {
  const { __holder } = jest.requireMock('@maplibre/maplibre-react-native') as {
    __holder: { onRegionDidChange?: (e: unknown) => void };
  };
  expect(typeof __holder.onRegionDidChange).toBe('function');
  await act(async () => {
    __holder.onRegionDidChange!({ nativeEvent: { zoom, center: [lng, lat] } });
  });
}

/** Pushes Date.now() past the handler's 250 ms throttle window. */
function advancePastThrottle() {
  const base = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(base + 10_000);
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryMapView — onCameraChange', () => {
  it('reports the camera the map opens at, without waiting for a gesture', async () => {
    // The parent's §17 band culling runs on first render. If the first report
    // only arrived on a pan, the map would open having decided which kinds are
    // legible at a zoom it is not at — visibly, POI pins missing until touched.
    const seen: Camera[] = [];
    await renderMap((c) => seen.push(c));

    expect(screen.getByTestId('map-container')).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ zoom: 11, center: { lat: AT[0], lng: AT[1] } });
  });

  it('reports the real zoom the camera settles at', async () => {
    // THE DEFECT. This value existed in component state all along and had no
    // way out, so the parent kept using the query-param default of 11.
    const seen: Camera[] = [];
    await renderMap((c) => seen.push(c));

    advancePastThrottle();
    await regionDidChange(16.25, 120.99, 14.6);

    expect(seen[seen.length - 1]).toEqual({
      zoom: 16.25,
      center: { lat: 14.6, lng: 120.99 },
    });
  });

  it('reports each settled camera, not only the first', async () => {
    // A latched report would be as bad as none: zooming back out would leave
    // the parent drawing venue-band pins at world scale.
    const seen: Camera[] = [];
    await renderMap((c) => seen.push(c));

    advancePastThrottle();
    await regionDidChange(16, 120.99, 14.6);
    advancePastThrottle();
    await regionDidChange(9.5, 121.5, 14.9);

    expect(seen.map((c) => c.zoom)).toEqual([11, 16, 9.5]);
  });

  it('does not throw when no camera callback is given', async () => {
    // ForYouTab, DiscoveryCategoryTab and LayoverMapCard render this component
    // as a plain place map and pass nothing. The prop is optional.
    await renderMap();

    advancePastThrottle();
    await regionDidChange(14, 120.99, 14.6);

    expect(screen.getByTestId('map-container')).toBeTruthy();
  });

  it('ignores a region event that carries no numeric zoom', async () => {
    // MapLibre's event payload is untyped at this boundary. A report of
    // `undefined` would poison the parent's zoom band, which fails closed to
    // `world` — the fewest kinds — and would blank most of the map.
    const seen: Camera[] = [];
    await renderMap((c) => seen.push(c));
    const before = seen.length;

    advancePastThrottle();
    const { __holder } = jest.requireMock('@maplibre/maplibre-react-native') as {
      __holder: { onRegionDidChange?: (e: unknown) => void };
    };
    await act(async () => {
      __holder.onRegionDidChange!({ nativeEvent: { center: [120.99, 14.6] } });
    });

    expect(seen).toHaveLength(before);
  });
});
