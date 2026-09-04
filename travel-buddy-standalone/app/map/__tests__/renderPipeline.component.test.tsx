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
 * ## The ruling that made (1) safe to land
 *
 * Drawing `kept` honestly is what blanked the Gems entry point: §17 introduces
 * `hidden_gem` at the `district` band (zoom 12), `parseZoom` defaults to 11 and
 * `/map?entityTypes=gems` passes no zoom, so every gem pin vanished. The owner
 * ruled CULL, BUT NEVER TO EMPTY — band culling applies at the marker layer
 * except where it would leave a kind the user explicitly asked for with nothing
 * on screen, and there the band gate is waived for that kind alone.
 *
 * "Explicitly asked for" is the `entityTypes` deep link OR an explicit `on` in
 * the composed §16 layer preferences — never a `LAYER_DEFAULTS` value, which is
 * why `place` (`relevant_places` defaults to `on`) is still culled at city zoom
 * below and is drawn the moment the deep link names it.
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
  useLocalSearchParams: () => MOCK_PARAMS,
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

// The LEGACY layer toggle. Half of the composed §16 decision, so it is driven
// from a knob rather than stubbed to a constant — the "explicitly asked for"
// signal the emptiness guard reads is composed from it.
// NOTE: intentionally exhaustive — the real module reads AsyncStorage at
// import; only these two exports are used by the screen.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn(() => Promise.resolve(MOCK_LEGACY_LAYERS)),
}));

// The §16 sheet — the OTHER half of the composed layer decision.
// NOTE: intentionally exhaustive — same reason as MapFilterSheet above.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet:          () => null,
  loadLayerPreferences: jest.fn(() => Promise.resolve(MOCK_LAYER_PREFS)),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSelectEntity?: (e: any) => void;
    easeTo: jest.Mock;
  } = { easeTo: jest.fn() };
  const DiscoveryMapView = (props: {
    entities?: { id: string }[];
    onCameraChange?: (c: { zoom: number; center: { lat: number; lng: number } }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSelectEntity?: (e: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    externalCameraRef?: { current: any };
  }) => {
    holder.onCameraChange = props.onCameraChange;
    holder.onSelectEntity = props.onSelectEntity;
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
const BASE_OBJECTS = [
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
    // Only meaningful against PLACE_DUP below; see its note.
    distanceKm: 1,
  },
];

/**
 * A second `place` on the SAME pixel as `place:zzz`. Used only by the guard
 * tests: it is how a REQUESTED kind can lose an object to collision while still
 * having a survivor, which band culling — an all-or-nothing rule about a kind —
 * can never produce on its own.
 *
 * Which of the two wins is settled by `distanceKm`, not by `renderingPriority`:
 * `promoteAll` recomputes every priority from the object's KIND, so the field
 * on the fixture is discarded and two `place`s always tie there. The
 * comparator's next term is distance, so `place:zzz` (1 km) beats this one
 * (2 km) deterministically.
 */
const PLACE_DUP = {
  id: 'place:dup',
  kind: 'place',
  title: 'Stall next door',
  geometry: { type: 'Point', coordinates: [LNG + 0.02, LAT + 0.02] },
  privacyClass: 'place_level',
  renderingPriority: 40,
  distanceKm: 2,
};

/**
 * A passport stamp: an entity with NO MapObject anywhere. `renderResult` holds
 * no verdict about it, so it must survive every stage of the marker filter.
 */
const STAMP_ENTITY = { id: 'stamp:PH', type: 'stamps', lat: 12.8, lng: 121.7, payload: {} };

const BASE_ENTITIES = [
  { id: 'event:aaa', type: 'events', lat: LAT,        lng: LNG,        payload: {} },
  { id: 'event:bbb', type: 'events', lat: LAT,        lng: LNG,        payload: {} },
  { id: 'place:zzz', type: 'places', lat: LAT + 0.02, lng: LNG + 0.02, payload: {} },
  STAMP_ENTITY,
];

const DUP_ENTITY =
  { id: 'place:dup', type: 'places', lat: LAT + 0.02, lng: LNG + 0.02, payload: {} };

// Mutable per-test knobs, read by the mock factories above at CALL time (the
// factories themselves are hoisted; nothing reads these during hoisting).
let MOCK_OBJECTS: unknown[] = BASE_OBJECTS;
let MOCK_ENTITIES: unknown[] = BASE_ENTITIES;
let MOCK_PARAMS: Record<string, string> = {};
let MOCK_LEGACY_LAYERS: string[] = [];
let MOCK_LAYER_PREFS: Record<string, 'on' | 'off'> = {};

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSelectEntity?: (e: any) => void;
      easeTo: jest.Mock;
    };
  };
}

/** Taps a pin, exactly as EntityMapLayers' onPress does. */
async function tapMarker(id: string, lat = LAT, lng = LNG) {
  const { __holder } = mapHolder();
  expect(typeof __holder.onSelectEntity).toBe('function');
  await act(async () => {
    __holder.onSelectEntity!({ id, type: 'places', lat, lng, payload: {} });
  });
}

async function mountMap() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

beforeEach(() => {
  mapHolder().__holder.easeTo.mockClear();
  MOCK_OBJECTS = BASE_OBJECTS;
  MOCK_ENTITIES = BASE_ENTITIES;
  MOCK_PARAMS = {};
  MOCK_LEGACY_LAYERS = [];
  MOCK_LAYER_PREFS = {};
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — the marker layer draws renderResult.kept', () => {
  it('omits the marker §31 collision dropped', async () => {
    // THE DEFECT. Pre-fix the map was handed `entities` and drew both events,
    // so two pins sat on the same pixel while the screen simultaneously
    // rendered "+1 more nearby" for the one it believed it had hidden.
    await mountMap();

    expect(idsOnMap()).toContain('event:aaa');
    expect(idsOnMap()).not.toContain('event:bbb');
  });

  it('keeps the decluttered object reachable in the carousel', async () => {
    // §31 hides pins; it must never lose objects. A card is how the user
    // reaches the one whose pin lost the overlap.
    await mountMap();

    expect(idsInCarousel()).toEqual([
      'event:aaa', 'event:bbb', 'place:zzz', 'stamp:PH',
    ]);
  });

  it('passes through an entity the pipeline never judged', async () => {
    // Guard against over-correction: `kept` is a verdict on MapObjects, and an
    // entity with no MapObject projection (place pins, passport stamps, raw
    // Compass envelopes) must not be deleted merely for being absent from it.
    // `stamp:PH` is that entity, and it has to survive BOTH bands — the one
    // where the pipeline is culling hard and the one where it is not.
    await mountMap();
    expect(idsOnMap()).toEqual(['event:aaa', 'stamp:PH']);

    await cameraSettlesAt(15);

    expect(idsOnMap()).toEqual(['event:aaa', 'place:zzz', 'stamp:PH']);
  });
});

describe('FullScreenMapScreen — the "+N more nearby" chip', () => {
  it('counts a marker that is genuinely off the map', async () => {
    // The chip reads the collision drops. While the map drew the raw list,
    // that number described objects the user could already see — an affordance
    // offering to reveal what was never hidden.
    await mountMap();

    expect(screen.getByLabelText('1 more nearby — zoom in to see them')).toBeTruthy();
    expect(idsOnMap()).not.toContain('event:bbb');
  });

  it('does not count an object that has no marker to reveal', async () => {
    // `entities` is not always built from the pipeline's own objects: in
    // Compass mode the PICKS are judged while the RESULTS are drawn, re-keyed
    // to bare ids. A §31 verdict on such an object reaches no pin, so counting
    // it would promise a marker that zooming in cannot produce. Modelled here
    // by an object with no entity of its id at all.
    MOCK_ENTITIES = BASE_ENTITIES.filter((e) => e.id !== 'event:bbb');
    await mountMap();

    expect(idsOnMap()).toContain('event:aaa');
    expect(screen.queryByLabelText('1 more nearby — zoom in to see them')).toBeNull();
  });

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

describe('FullScreenMapScreen — the real camera zoom reaches §17 band culling', () => {
  it('gives DiscoveryMapView a camera callback at all', async () => {
    // Pre-fix DiscoveryMapViewProps declared no camera prop, so the zoom the
    // component already tracked could not leave it.
    await mountMap();

    const { __holder } = jest.requireMock(
      '../../../src/components/discovery/DiscoveryMapView',
    ) as { __holder: { onCameraChange?: unknown } };
    expect(typeof __holder.onCameraChange).toBe('function');
  });

  it('hides a district-band kind while the camera is at city zoom', async () => {
    // §17: "no POI pins at world zoom; individual places only from district
    // in." The screen opens at the fallback zoom of 11 — the `city` band — so
    // a `place` is not yet legible.
    //
    // Nothing here asks for places: `relevant_places` is on by DEFAULT, and a
    // default is not a request. The next describe block is the same object at
    // the same zoom with the deep link added.
    await mountMap();

    expect(idsOnMap()).not.toContain('place:zzz');
  });

  it('draws it once the camera reports a zoom that makes it legible', async () => {
    // THE DEFECT. With no camera callback the screen's zoom was pinned at the
    // query-param default forever, so this pin could never appear no matter how
    // far the user zoomed in.
    await mountMap();
    expect(idsOnMap()).not.toContain('place:zzz');

    await cameraSettlesAt(15);

    expect(idsOnMap()).toContain('place:zzz');
  });

  it('hides it again when the camera zooms back out', async () => {
    // The band is read from the live camera each time, not latched on the
    // first report — otherwise zooming out would leave POI pins stranded at
    // world scale, which is the clutter §17 exists to prevent.
    await mountMap();

    await cameraSettlesAt(15);
    expect(idsOnMap()).toContain('place:zzz');

    await cameraSettlesAt(9);
    expect(idsOnMap()).not.toContain('place:zzz');
  });
});

// ── The ruling: cull, but never to empty ──────────────────────────────────────
//
// Every test here is the SAME object at the SAME zoom as
// "hides a district-band kind while the camera is at city zoom" above. Only the
// request differs, which is the whole content of the ruling.
describe('FullScreenMapScreen — cull, but never to empty', () => {
  it('draws a deep-linked kind the band would otherwise have emptied', async () => {
    // `/map?entityTypes=places` is the Discovery "View on map" door, and it
    // passes no zoom — so it lands at 11, below the band where §17 introduces
    // `place`. Culling honestly there leaves the surface with nothing of the
    // one kind the link named. The band gate is waived for `place` alone.
    MOCK_PARAMS = { entityTypes: 'places' };
    await mountMap();

    expect(idsOnMap()).toContain('place:zzz');
    // The waiver is per KIND, not a blanket "draw everything": the collision
    // verdict on the two coincident events is untouched.
    expect(idsOnMap()).not.toContain('event:bbb');
  });

  it('treats an explicit §16 layer switch as the same request', async () => {
    // The deep link says "show me places now"; the Layers sheet says "show me
    // places always". Honouring only the first would blank this layer for a
    // user who switched it on and then opened the map from any other door.
    MOCK_LAYER_PREFS = { relevant_places: 'on' };
    await mountMap();

    expect(idsOnMap()).toContain('place:zzz');
  });

  it('leaves the band gate in force while that kind still has a survivor', async () => {
    // The escape hatch is emptiness relief, not an exemption. At zoom 15
    // `place` is in band and `place:dup` loses the overlap with `place:zzz` —
    // the kind has a survivor, so nothing is waived and the loser stays off the
    // map. Its card remains, which is how §31's losers stay reachable.
    MOCK_PARAMS  = { entityTypes: 'places' };
    MOCK_OBJECTS = [...BASE_OBJECTS, PLACE_DUP];
    MOCK_ENTITIES = [...BASE_ENTITIES, DUP_ENTITY];
    await mountMap();
    await cameraSettlesAt(15);

    expect(idsOnMap()).toContain('place:zzz');
    expect(idsOnMap()).not.toContain('place:dup');
    expect(idsInCarousel()).toContain('place:dup');
  });

  it('still judges a waived kind by §31, and counts what it drops', async () => {
    // Both places are re-admitted at city zoom because the band would have
    // emptied the kind — and then they collide, exactly as they would in band.
    // "Never to empty" is a floor of one, not a licence to stack pins.
    //
    // The chip is the honesty check: 2 = the event that lost its overlap plus
    // the place that lost its overlap AFTER the waiver put it back. Counted off
    // the second pass; the first pass never saw `place:dup` collide with
    // anything, because both had already been band-culled.
    MOCK_PARAMS  = { entityTypes: 'places' };
    MOCK_OBJECTS = [...BASE_OBJECTS, PLACE_DUP];
    MOCK_ENTITIES = [...BASE_ENTITIES, DUP_ENTITY];
    await mountMap();

    expect(idsOnMap()).toContain('place:zzz');
    expect(idsOnMap()).not.toContain('place:dup');
    expect(screen.getByLabelText('2 more nearby — zoom in to see them')).toBeTruthy();
  });

  it('makes a waived pin tappable, not a decoration', async () => {
    // The rest of the screen reads `objects`, its own §17-filtered view. If
    // that view is computed independently of the resolver's verdict, a waived
    // gem is DRAWN (it came from `renderResult.kept`) while `selectedObject`
    // resolves to null — so tapping the very pin the ruling exists to preserve
    // opens nothing. `objects` is therefore re-derived from `bandWaivedKinds`.
    MOCK_PARAMS = { entityTypes: 'places' };
    await mountMap();
    // Pin the camera at city zoom first: selecting a place commands zoom 15,
    // and the live camera is what the bands are read from.
    await cameraSettlesAt(11);
    expect(idsOnMap()).toContain('place:zzz');

    await tapMarker('place:zzz', LAT + 0.02, LNG + 0.02);

    expect(screen.getByTestId('map-bottom-actions')).toBeTruthy();
  });

  it('does not resurrect a kind emptied by collision rather than by the band', async () => {
    // `place:dup` is the ONLY place, sitting under the winning event pin at a
    // zoom where `place` is perfectly legible. The kind is empty, and the guard
    // must still not fire: §31's loser is not erased — a higher-priority pin
    // stands in the same spot, the chip counts it and the carousel carries it.
    // Waiving a band that did nothing would only stack two pins on one pixel.
    MOCK_PARAMS = { entityTypes: 'places' };
    MOCK_OBJECTS = [
      BASE_OBJECTS[0],
      { ...PLACE_DUP, geometry: { type: 'Point', coordinates: [LNG, LAT] } },
    ];
    MOCK_ENTITIES = [
      BASE_ENTITIES[0],
      { id: 'place:dup', type: 'places', lat: LAT, lng: LNG, payload: {} },
    ];
    await mountMap();
    await cameraSettlesAt(15);

    expect(idsOnMap()).toEqual(['event:aaa']);
    expect(idsInCarousel()).toContain('place:dup');
  });
});
