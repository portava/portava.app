/**
 * FullScreenMapScreen — §15 Time Machine draws the OFFSET, not today.
 *
 * ## The defect
 *
 * Only one stage of the screen's pipeline knew about the §15 offset. The
 * `permittedObjects` memo swapped its base to `temporal.objects` at a non-NOW
 * offset — and everything upstream of it kept reading the NOW map: the §16
 * hidden-id set, and decisively the ENTITY list the marker layer and the
 * carousel are built from.
 *
 * The two halves then drew different instants. The marker filter passes through
 * "everything the pipeline never judged" (discovery places, passport stamps —
 * populations with no MapObject), and today's live entity ids are not among the
 * temporal payload's ids, so that escape hatch waved EVERY one of today's
 * markers onto the screen. Meanwhile the historical payload had no entity at
 * all and drew nothing.
 *
 * So scrubbing to Yesterday showed today's live map, labelled Yesterday. That
 * is §37's "predictions must not look like observations" failing in both
 * directions at once — and it is worse than a blank screen, because a blank
 * screen is not a false claim about the past.
 *
 * ## What this suite pins
 *
 *  1. NOW is unchanged — today's markers, the control that would catch an
 *     over-broad fix blanking the live map.
 *  2. A FUTURE offset draws the prediction payload and NONE of today's ids.
 *  3. A PAST offset draws the historical payload and NONE of today's ids.
 *  4. An offset the producer had nothing for draws NOTHING — the honest empty
 *     state, never a silent fallback to today.
 *  5. The carousel gets the same instant as the markers, so a card cannot
 *     advertise a pin from a different time.
 *  6. §37 — what reaches the renderer at a future offset is still kind
 *     'prediction' and carries no live freshness.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
// timeMachine BEFORE the screen: importing the screen first pulls the whole map
// graph in, and this module comes back undefined through that cycle.
import { NOW_OFFSET, type TimeOffset } from '../../../src/features/map/time/timeMachine.ts';
import { point, type MapObject } from '../../../src/types/mapObjects.ts';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';
import FullScreenMapScreen from '../index.tsx';

// ── Shared test data ──────────────────────────────────────────────────────────
// Today's live map, and two per-offset payloads whose ids share NOTHING with it
// — which is the whole point: the pre-fix marker filter let an unmatched id
// through, so overlapping ids would hide the defect.

const EVENT: MapObject = {
  id: 'event:e1',
  kind: 'event',
  geometry: point(14.5, 120.9),
  title: 'Rooftop set',
  privacyClass: 'place_level',
  renderingPriority: 60,
};

const LIVE_PLACE: MapObject = {
  id: 'place:p1',
  kind: 'place',
  geometry: point(14.6, 121.0),
  title: 'Noodle bar',
  freshness: 'live',
  privacyClass: 'place_level',
  renderingPriority: 55,
};

/** +60m: a forecast. Never observed, so it carries no observedAt (§37). */
const PREDICTION: MapObject = {
  id: 'prediction:event:tomorrow',
  kind: 'prediction',
  geometry: point(14.55, 120.95),
  title: 'Busier soon',
  confidence: 'provisional',
  privacyClass: 'aggregate_only',
  renderingPriority: 50,
};

/** Yesterday: READ from a snapshot, so it is observed and historical. */
const HISTORICAL: MapObject = {
  id: 'history:place:p9',
  kind: 'place',
  geometry: point(14.52, 120.93),
  title: 'It was busy here',
  freshness: 'historical',
  activity: 'busy',
  privacyClass: 'place_level',
  renderingPriority: 55,
};

const NOW_OBJECTS: MapObject[] = [EVENT, LIVE_PLACE];
const NOW_ENTITIES = mapObjectsToEntities(NOW_OBJECTS);

const PLUS_60: TimeOffset = { kind: 'relative', minutes: 60 };
const YESTERDAY: TimeOffset = { kind: 'relative', minutes: -1440 };

// Mutable per-test knobs, read by the mock factories below.
const knobs: {
  params: Record<string, string>;
  layerPrefs: Record<string, 'on' | 'off'>;
  enabledLayers: string[];
  entities: unknown[];
  objects: MapObject[];
  timeOffset: TimeOffset;
  temporalObjects: MapObject[];
} = {
  params: {},
  layerPrefs: {},
  enabledLayers: ['buddies', 'events', 'gems', 'trips', 'friends'],
  entities: NOW_ENTITIES,
  objects: NOW_OBJECTS,
  // A LITERAL, not `NOW_OFFSET`. `knobs` is referenced by the hoisted jest.mock
  // factories below, which puts its initializer ahead of the module's imports —
  // an imported binding read here is still undefined. Every test gets the real
  // constant from `beforeEach`, and the guard test below proves the two agree.
  timeOffset: { kind: 'now' },
  temporalObjects: [],
};

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router:               { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismiss: jest.fn() },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => knobs.params,
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
    navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/passportStamps', () => ({
  getPassportMap:    jest.fn().mockResolvedValue({ ok: false }),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryPlaces: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/livePulse', () => ({
  getLivePulseItems: jest.fn().mockResolvedValue({ ok: true, items: [] }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      coords: { lat: 14.5995, lng: 120.9842 },
      place: { city: 'Manila', country: 'Philippines' },
      permissionStatus: 'granted',
    },
    resolvedLocation: {
      place: { city: 'Manila', country: 'Philippines' },
      coords: { lat: 14.5995, lng: 120.9842 },
      source: 'home',
      freshness: 'live',
    },
    requireLocation: jest.fn(),
  }),
}));

// The LEGACY layer toggle. Its stored value is one half of the composed layer
// decision under test, so it is driven from `knobs` rather than stubbed empty.
// NOTE: intentionally exhaustive — MapFilterSheet's real module reads
// AsyncStorage at import; only these two exports are used by the screen.
jest.mock('../../../src/components/map/MapFilterSheet', () => ({
  MapFilterSheet:    () => null,
  loadEnabledLayers: jest.fn(() => Promise.resolve(knobs.enabledLayers)),
}));

// The §16 sheet. `loadLayerPreferences` is the OTHER half — the preferences
// that previously reached no drawn marker at all.
// NOTE: intentionally exhaustive — same reason as MapFilterSheet above.
jest.mock('../../../src/components/map/LayersSheet', () => ({
  LayersSheet:          () => null,
  loadLayerPreferences: jest.fn(() => Promise.resolve(knobs.layerPrefs)),
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
  COUNTRY_CENTROIDS: { PH: [12.8, 121.7] },
}));

// ── DiscoveryMapView — writes the marker ids it is handed into the tree ───────
// Not a spy: the assertions read rendered output, which is what "a marker was
// drawn" actually means for this screen. `entities` is the prop EntityMapLayers
// draws pins from.
jest.mock('../../../src/components/discovery/DiscoveryMapView', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    DiscoveryMapView: (props: {
      entities?: { id: string; payload?: { kind?: string; freshness?: string } }[];
    }) => (
      <View testID="map-view">
        <Text testID="map-marker-ids">
          {(props.entities ?? []).map((e) => e.id).join(',') || 'none'}
        </Text>
        <Text testID="map-marker-kinds">
          {(props.entities ?? [])
            .map((e) => `${e.payload?.kind ?? '?'}:${e.payload?.freshness ?? 'none'}`)
            .join(',') || 'none'}
        </Text>
      </View>
    ),
  };
});

// NOTE: intentional stub — the carousel's own behaviour is covered elsewhere.
jest.mock('../../../src/components/map/MapCarousel', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  const MapCarousel = React.forwardRef(
    (props: { entities?: { id: string }[] }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn() }));
      return (
        <View testID="map-carousel">
          <Text testID="map-card-ids">
            {(props.entities ?? []).map((e) => e.id).join(',') || 'none'}
          </Text>
        </View>
      );
    },
  );
  MapCarousel.displayName = 'MapCarousel';
  return { MapCarousel };
});

// NOTE: intentionally exhaustive — the hook is the object/entity SOURCE under
// test here; requireActual would fetch over the network.
jest.mock('../../../src/hooks/useMapEntities', () => ({
  useMapEntities: () => ({
    entities: knobs.entities,
    objects: knobs.objects,
    liveEnrichment: null,
    loading: false,
    error: null,
    refresh: () => {},
    source: 'gateway',
  }),
}));


// The §15 per-offset producer. Mocked at the hook rather than the transport so
// a case can hand the screen an exact payload for an exact offset — including
// the EMPTY payload, which is the case the pre-fix screen answered with today.
// NOTE: intentionally exhaustive — the screen uses only this export, and the
// real hook fetches over the network on mount.
jest.mock('../../../src/hooks/useTemporalEntities', () => ({
  useTemporalEntities: () => ({
    objects: knobs.temporalObjects,
    enabled: true,
    forecast: null,
    history: null,
    loading: false,
  }),
}));

// The map store, with ONLY `timeOffset` overridden — the §15 control's position
// is what this suite varies, and everything else must stay the real reducer so
// the screen runs its production pipeline.
jest.mock('../../../src/stores/mapStore.tsx', () => {
  // requireActual is called LAZILY, inside the accessors. Doing it in the
  // factory body runs while the module graph is still initialising (the factory
  // is hoisted above every import) and mapStore's own imports come back
  // undefined.
  const real = () => jest.requireActual('../../../src/stores/mapStore.tsx');
  return {
    get MapStoreProvider() { return real().MapStoreProvider; },
    get deriveMapCapabilities() { return real().deriveMapCapabilities; },
    useMapStore: () => ({ ...real().useMapStore(), timeOffset: knobs.timeOffset }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ids(testID: string): string[] {
  const raw = screen.getByTestId(testID).props.children as string;
  return raw === 'none' ? [] : raw.split(',');
}

const markerIds = () => ids('map-marker-ids');
const cardIds = () => ids('map-card-ids');

/** kind:freshness for each drawn marker — the §37 evidence. */
function markerKinds(): string[] {
  const raw = screen.getByTestId('map-marker-kinds').props.children as string;
  return raw === 'none' ? [] : raw.split(',');
}

async function mount() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

beforeEach(() => {
  // §17 district band (zoom >= 12): `place` — which both the live map and the
  // historical payload use — is only introduced there. At the default zoom the
  // band gate would eat it and every case below would pass vacuously.
  knobs.params = { zoom: '14' };
  knobs.layerPrefs = {};
  knobs.enabledLayers = ['buddies', 'events', 'gems', 'trips', 'friends'];
  knobs.entities = NOW_ENTITIES;
  knobs.objects = NOW_OBJECTS;
  knobs.timeOffset = NOW_OFFSET;
  knobs.temporalObjects = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — §15 NOW is unchanged', () => {
  it('the NOW literal this file falls back to IS the exported constant', async () => {
    // Guards the hoisting workaround above: if NOW_OFFSET ever gains a field,
    // the literal initializer must not quietly become a different offset.
    expect(NOW_OFFSET).toEqual({ kind: 'now' });
  });

  it('draws today\'s markers at the NOW offset', async () => {
    // The anti-blanking control. A fix that made the temporal payload the base
    // unconditionally would empty the live map, which is the failure mode worth
    // guarding against hardest.
    await mount();
    await waitFor(() => expect(markerIds()).toEqual(['event:e1', 'place:p1']));
  });

  it('ignores a temporal payload while the control sits at NOW', async () => {
    // The producer clears its payload when idle, but a stale one must never
    // leak under NOW either.
    knobs.temporalObjects = [PREDICTION];
    await mount();
    await waitFor(() => expect(markerIds()).toEqual(['event:e1', 'place:p1']));
  });
});

describe('FullScreenMapScreen — §15 a non-NOW offset draws the temporal payload', () => {
  it('a FUTURE offset draws the prediction and none of today\'s markers', async () => {
    knobs.timeOffset = PLUS_60;
    knobs.temporalObjects = [PREDICTION];
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['prediction:event:tomorrow']));
    // The load-bearing half: today's live objects are GONE, not merely
    // outranked. Pre-fix both of them were drawn beside the forecast.
    expect(markerIds()).not.toContain('event:e1');
    expect(markerIds()).not.toContain('place:p1');
  });

  it('a PAST offset draws the historical place and none of today\'s markers', async () => {
    knobs.timeOffset = YESTERDAY;
    knobs.temporalObjects = [HISTORICAL];
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['history:place:p9']));
    expect(markerIds()).not.toContain('event:e1');
    expect(markerIds()).not.toContain('place:p1');
  });

  it('§37 — the forecast reaches the renderer AS a prediction, with no live freshness', async () => {
    // A prediction relabelled from a live object would arrive with
    // freshness 'live'. Predictions stay labelled as predictions.
    knobs.timeOffset = PLUS_60;
    knobs.temporalObjects = [PREDICTION];
    await mount();

    await waitFor(() => expect(markerKinds()).toEqual(['prediction:none']));
  });
});

describe('FullScreenMapScreen — §15 an empty offset is honestly empty', () => {
  it('draws NOTHING when the producer had nothing for this offset', async () => {
    // The whole point of the fix. "No history yet" must read as no history —
    // never as today's map wearing yesterday's label.
    knobs.timeOffset = YESTERDAY;
    knobs.temporalObjects = [];
    await mount();

    await waitFor(() => expect(markerIds()).toEqual([]));
  });

  it('gives the carousel the same empty instant', async () => {
    knobs.timeOffset = YESTERDAY;
    knobs.temporalObjects = [];
    await mount();

    await waitFor(() => expect(cardIds()).toEqual([]));
  });
});

describe('FullScreenMapScreen — §15 the carousel and the markers share one instant', () => {
  it('a card can never advertise a pin from a different time', async () => {
    knobs.timeOffset = PLUS_60;
    knobs.temporalObjects = [PREDICTION, HISTORICAL];
    await mount();

    await waitFor(() => expect(cardIds().length).toBeGreaterThan(0));
    for (const id of cardIds()) {
      expect(id.startsWith('prediction:') || id.startsWith('history:')).toBe(true);
    }
    expect(cardIds()).not.toContain('event:e1');
    expect(cardIds()).not.toContain('place:p1');
  });
});
