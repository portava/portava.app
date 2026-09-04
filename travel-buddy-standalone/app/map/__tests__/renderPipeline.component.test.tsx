/**
 * FullScreenMapScreen — the render pipeline's verdict actually reaches the map.
 *
 * ## The two defects
 *
 * 1. THE MARKER LAYER DREW THE WRONG ARRAY.
 *    The screen computes `renderResult = prepareForRender(...)` — §16 layers,
 *    §3's chip, §17 band culling and §31 collision, in that order — and then
 *    handed DiscoveryMapView the raw `entities` array instead of
 *    `renderResult.kept`. The whole stage was computed and thrown away. The
 *    visible consequence was not just clutter: the "+N more nearby" chip reads
 *    `renderResult.collisionDroppedCount`, so it advertised N hidden markers
 *    while all N were still on screen.
 *
 * 2. THE REAL CAMERA ZOOM NEVER LEFT DiscoveryMapView.
 *    That component has tracked its own camera zoom since the travelers layer
 *    landed, but DiscoveryMapViewProps exposed no camera callback, so this
 *    screen fell back to `cameraZoom ?? paramZoom` — a store value written only
 *    when the screen COMMANDS a move, defaulting to the `zoom` query param (11).
 *    §17 band culling therefore ran at a constant: "individual places only from
 *    district in" was evaluated at city zoom no matter where the camera was.
 *
 * The two are one behaviour. Fixing (1) alone would freeze the map at whatever
 * band the constant named; fixing (2) alone would compute a correct verdict
 * that nothing read.
 *
 * ## Why these assertions and not others
 *
 * The map stand-in below is NOT a spy. It writes the ids it is given into the
 * tree, so every assertion reads rendered output rather than recorded call
 * arguments — a props spy would pass against a component that received the
 * right list and drew nothing.
 *
 * The carousel stand-in does the same, because the interesting property is that
 * the two lists DIFFER: collision.ts is explicit that "a hidden object the user
 * cannot reach is a silent truncation", so a decluttered pin has to stay
 * reachable as a card.
 *
 * Run: pnpm test:component  (matches --testPathPattern='\.component\.test\.')
 */
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
// useFocusEffect fires synchronously (like useEffect) so mount settles without
// async timers.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap:    jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — `ok: false` keeps `places` empty, so every id the
// map reports below comes from the projection fixture rather than from a place
// pin the pipeline never judged.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      coords:           { lat: 14.5995, lng: 120.9842 },
      place:            { city: 'Manila', country: 'Philippines' },
      permissionStatus: 'granted',
    },
    resolvedLocation: {
      place:     { city: 'Manila', country: 'Philippines' },
      coords:    { lat: 14.5995, lng: 120.9842 },
      source:    'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/MapTopControls', () => ({
  MapTopControls: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/map/AskCompassBar', () => ({
  AskCompassBar: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/countryCentroids', () => ({
  COUNTRY_CENTROIDS: {},
}));

// ── DiscoveryMapView — renders the entity ids it is given ─────────────────────
// The real component pulls native MapLibre. This stand-in writes the ids into
// the tree and parks `onCameraChange` in a holder so a pinch can be simulated:
// under jest there is no MapLibre region event to ride in on.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const holder: {
    onCameraChange?: (c: { zoom: number; center: { lat: number; lng: number } }) => void;
    easeTo: jest.Mock;
  } = { easeTo: jest.fn() };
  const DiscoveryMapView = (props: {
    entities?: { id: string }[];
    onCameraChange?: (c: { zoom: number; center: { lat: number; lng: number } }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    externalCameraRef?: { current: any };
  }) => {
    holder.onCameraChange = props.onCameraChange;
    // The real Camera element lives inside this component and publishes its
    // imperative handle onto the forwarded ref. Standing one up here is what
    // lets the "+N more" chip's easeTo call be observed.
    if (props.externalCameraRef && !props.externalCameraRef.current) {
      props.externalCameraRef.current = { easeTo: holder.easeTo };
    }
    return (
      <View testID="map-view">
        <Text testID="map-entity-ids">
          {(props.entities ?? []).map((e) => e.id).join(',') || 'empty'}
        </Text>
      </View>
    );
  };
  return { DiscoveryMapView, __holder: holder };
});

// ── MapCarousel — renders the entity ids IT is given ──────────────────────────
// Separate from the map's list on purpose: the fix must narrow the pins without
// narrowing the cards.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const MapCarousel = React.forwardRef(
    (props: { entities?: { id: string }[] }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
      return (
        <View testID="map-carousel">
          <Text testID="carousel-entity-ids">
            {(props.entities ?? []).map((e) => e.id).join(',') || 'empty'}
          </Text>
        </View>
      );
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// NOTE: intentional stub — supplies a fixed projection so the pipeline's input
// is known exactly. `objects` and `entities` are the two envelopes over the SAME
// objects (mapObjectToEntity copies `obj.id` verbatim), which is what lets the
// screen match a MapObject verdict onto a MapEntity.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities:       MOCK_ENTITIES,
    objects:        MOCK_OBJECTS,
    liveEnrichment: null,
    loading:        false,
    error:          null,
    refresh:        () => {},
    source:         'legacy',
    stage:          'complete',
    staleness:      null,
  }),
}));

// ── Shared test data ──────────────────────────────────────────────────────────

const LAT = 14.5995;
const LNG = 120.9842;

/**
 * Three objects, chosen so each stage of the pipeline is separately observable:
 *
 *   event:aaa / event:bbb — IDENTICAL coordinates, so §31 collision must drop
 *     exactly one of them at every zoom. The comparator is (priority, distance,
 *     id), and these tie on the first two, so 'aaa' wins deterministically.
 *   place:zzz — kind `place`, which §17 introduces at the `district` band
 *     (zoom >= 12). At the screen's fallback zoom of 11 it is not legible; at a
 *     real camera zoom of 15 it is. It sits ~2.2 km away so it never collides
 *     with the events at the zooms used here.
 */
const MOCK_OBJECTS = [
  {
    id: 'event:aaa',
    kind: 'event',
    title: 'Rooftop set',
    geometry: { type: 'Point', coordinates: [LNG, LAT] },
    privacyClass: 'place_level',
    renderingPriority: 70,
  },
  {
    id: 'event:bbb',
    kind: 'event',
    title: 'Same corner, same minute',
    geometry: { type: 'Point', coordinates: [LNG, LAT] },
    privacyClass: 'place_level',
    renderingPriority: 70,
  },
  {
    id: 'place:zzz',
    kind: 'place',
    title: 'Corner noodle shop',
    geometry: { type: 'Point', coordinates: [LNG + 0.02, LAT + 0.02] },
    privacyClass: 'place_level',
    renderingPriority: 50,
  },
];

const MOCK_ENTITIES = [
  { id: 'event:aaa', type: 'events', lat: LAT,        lng: LNG,        payload: {} },
  { id: 'event:bbb', type: 'events', lat: LAT,        lng: LNG,        payload: {} },
  { id: 'place:zzz', type: 'places', lat: LAT + 0.02, lng: LNG + 0.02, payload: {} },
];

function idsOnMap(): string[] {
  const text = screen.getByTestId('map-entity-ids').props.children as string;
  return text === 'empty' ? [] : text.split(',');
}

function idsInCarousel(): string[] {
  const text = screen.getByTestId('carousel-entity-ids').props.children as string;
  return text === 'empty' ? [] : text.split(',');
}

/** Reports a settled camera, as DiscoveryMapView's onRegionDidChange would. */
async function cameraSettlesAt(zoom: number, lat = LAT, lng = LNG) {
  const { __holder } = jest.requireMock(
    '../../../src/components/discovery/DiscoveryMapView',
  ) as {
    __holder: {
      onCameraChange?: (c: { zoom: number; center: { lat: number; lng: number } }) => void;
    };
  };
  expect(typeof __holder.onCameraChange).toBe('function');
  await act(async () => {
    __holder.onCameraChange!({ zoom, center: { lat, lng } });
  });
}

function mapHolder() {
  return jest.requireMock('../../../src/components/discovery/DiscoveryMapView') as {
    __holder: {
      onCameraChange?: (c: { zoom: number; center: { lat: number; lng: number } }) => void;
      easeTo: jest.Mock;
    };
  };
}

async function mountMap() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

beforeEach(() => {
  mapHolder().__holder.easeTo.mockClear();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// The tests that asserted the marker layer is filtered to renderResult.kept
// were removed with the filter itself. They were not wrong — they collided
// with app/map/__tests__/layerFilteredMarkers.component.test.tsx, which is
// merged and rules the other way, and the collision turned out to be a real
// product question: §17 introduces hidden_gem at the district band (zoom 12),
// parseZoom defaults to 11, and the Gems tab's "View on map" passes no zoom —
// so culling honestly at the marker layer blanks that entry point. The owner
// ruled "cull, but never to empty"; those tests return with that work.
describe('FullScreenMapScreen — the render pipeline', () => {
  it('keeps the decluttered object reachable in the carousel', async () => {
    // §31 hides pins; it must never lose objects. A card is how the user
    // reaches the one whose pin lost the overlap.
    await mountMap();

    expect(idsInCarousel()).toEqual(['event:aaa', 'event:bbb', 'place:zzz']);
  });

});

describe('FullScreenMapScreen — the "+N more nearby" chip', () => {
  it('zooms IN from where the camera actually is', async () => {
    // Its promise is "zoom in to see them", and it stepped up from the store's
    // COMMANDED zoom. A user who had pinched to 16 was eased to 12.5 — a zoom
    // out, which hides more rather than less.
    await mountMap();
    await cameraSettlesAt(16);

    // The entities effect eases the camera to the proximity-selected entity on
    // mount; clear those so the only call left is the chip's own.
    const { __holder } = mapHolder();
    __holder.easeTo.mockClear();

    fireEvent.press(screen.getByLabelText('1 more nearby — zoom in to see them'));

    expect(__holder.easeTo).toHaveBeenCalledTimes(1);
    expect(__holder.easeTo.mock.calls[0][0].zoom).toBe(17.5);
  });
});

describe('FullScreenMapScreen — the real camera reaches the screen', () => {
  it('gives DiscoveryMapView a camera callback at all', async () => {
    // Pre-fix DiscoveryMapViewProps declared no camera prop, so the zoom the
    // component already tracked could not leave it.
    await mountMap();

    const { __holder } = jest.requireMock(
      '../../../src/components/discovery/DiscoveryMapView',
    ) as { __holder: { onCameraChange?: unknown } };
    expect(typeof __holder.onCameraChange).toBe('function');
  });

});
