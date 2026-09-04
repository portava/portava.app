/**
 * FullScreenMapScreen — the §16 layer decision reaches a DRAWN marker.
 *
 * ## The defect
 *
 * The screen ran the whole spec pipeline — §16 layers, §3 chip, §17 zoom band,
 * §15 temporal, §31 collision — into `renderResult`, and then read exactly one
 * field off it (`collisionDroppedCount`). The renderer was handed `entities`,
 * the unfiltered legacy list, so markers were filtered ONLY by the legacy
 * five-value `enabledLayers` set. `filterByLayers` was imported at the top of
 * the file and never called: every preference the §16 Layers sheet wrote landed
 * on nothing a user could see.
 *
 * ## Why this file leads with "markers still render"
 *
 * The obvious repair — hand the renderer `renderResult.kept` — would blank the
 * map. `kept` is `MapObject[]`; `entities` is `MapEntity[]` and carries three
 * populations the pipeline never evaluated at all: discovery places, passport
 * stamps, and raw Compass results (the Compass PICKS are re-keyed to bare ids,
 * so even those do not match). So the first and most important assertion here
 * is that a normal map still draws its markers, and the pass-through cases are
 * tested as carefully as the filtering case.
 *
 * ## Covered
 *
 *  1. Both markers render under the default layer state (the anti-blanking
 *     assertion — this is the one that fails loudest if the filter is wrong).
 *  2. An explicit §16 "off" removes that marker and leaves the others.
 *  3. An explicit §16 "off" for a layer the legacy sheet also has ON still
 *     wins — the sheet is not overridden by the legacy seed.
 *  4. Entities with no corresponding MapObject (passport stamps) pass through
 *     untouched, so a mode the pipeline knows nothing about cannot be emptied.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import FullScreenMapScreen from '../index.tsx';
import { point, type MapObject } from '../../../src/types/mapObjects.ts';
import { mapObjectsToEntities } from '../../../src/types/mapTypes.ts';

// ── Shared test data ──────────────────────────────────────────────────────────
// Real MapObjects, converted with the real `mapObjectsToEntities`, so the
// object↔entity id relationship the filter depends on is the production one
// rather than one this file invented.

const EVENT: MapObject = {
  id: 'event:e1',
  kind: 'event',
  geometry: point(14.5, 120.9),
  title: 'Rooftop set',
  privacyClass: 'place_level',
  renderingPriority: 60,
};

const GEM: MapObject = {
  id: 'gem:g1',
  kind: 'hidden_gem',
  geometry: point(14.6, 121.0),
  title: 'Back-alley noodles',
  privacyClass: 'place_level',
  renderingPriority: 40,
};

const OBJECTS: MapObject[] = [EVENT, GEM];
const ENTITIES = mapObjectsToEntities(OBJECTS);

/** Stamps exist only as entities — no MapObject anywhere describes them. */
const STAMP_ENTITIES = [
  { id: 'stamp:PH', type: 'stamps' as const, lat: 12.8, lng: 121.7, payload: {} },
];

// Mutable per-test knobs, read by the mock factories below.
const knobs: {
  params: Record<string, string>;
  layerPrefs: Record<string, 'on' | 'off'>;
  enabledLayers: string[];
  entities: unknown[];
  objects: MapObject[];
} = {
  params: {},
  layerPrefs: {},
  enabledLayers: ['buddies', 'events', 'gems', 'trips', 'friends'],
  entities: ENTITIES,
  objects: OBJECTS,
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
    DiscoveryMapView: (props: { entities?: { id: string }[] }) => (
      <View testID="map-view">
        <Text testID="map-marker-ids">
          {(props.entities ?? []).map((e) => e.id).join(',') || 'none'}
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function markerIds(): string[] {
  const raw = screen.getByTestId('map-marker-ids').props.children as string;
  return raw === 'none' ? [] : raw.split(',');
}

function cardIds(): string[] {
  const raw = screen.getByTestId('map-card-ids').props.children as string;
  return raw === 'none' ? [] : raw.split(',');
}

async function mount() {
  await render(<FullScreenMapScreen />);
  await waitFor(() => expect(screen.getByTestId('map-view')).toBeTruthy());
}

beforeEach(() => {
  knobs.params = {};
  knobs.layerPrefs = {};
  knobs.enabledLayers = ['buddies', 'events', 'gems', 'trips', 'friends'];
  knobs.entities = ENTITIES;
  knobs.objects = OBJECTS;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FullScreenMapScreen — the map still draws its markers', () => {
  it('renders every marker under the default layer state', async () => {
    // THE anti-blanking assertion. §16's own defaults have Hidden Gems OFF, so
    // a filter that ignored the legacy toggle would silently delete the gem pin
    // here — and, from the Gems tab's "View on map", every pin on the screen.
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['event:e1', 'gem:g1']));
  });

  it('gives the carousel the same list it gives the markers', async () => {
    // One list drives both, so a card can never advertise a pin that is not
    // drawn.
    await mount();

    await waitFor(() => expect(cardIds()).toEqual(markerIds()));
  });
});

describe('FullScreenMapScreen — §16 preferences reach a drawn marker', () => {
  it('removes the marker for a layer the user switched off', async () => {
    // Pre-fix this preference was written to storage, read into `layerPrefs`,
    // fed to a pipeline whose result was discarded, and changed nothing on
    // screen.
    knobs.layerPrefs = { hidden_gems: 'off' };
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['event:e1']));
  });

  it('lets an explicit sheet choice outrank the legacy toggle', async () => {
    // The legacy sheet has Events ON. The §16 sheet is the newer and more
    // specific control, and `layerPrefs` only ever holds keys the user actually
    // touched, so its explicit `off` must win.
    knobs.enabledLayers = ['buddies', 'events', 'gems', 'trips', 'friends'];
    knobs.layerPrefs = { events: 'off' };
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['gem:g1']));
  });

  it('keeps both markers when the sheet has no opinion', async () => {
    // Absence of a key is the automatic state, not an implicit "off".
    knobs.layerPrefs = {};
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['event:e1', 'gem:g1']));
  });
});

describe('FullScreenMapScreen — entities the pipeline never evaluated', () => {
  it('passes stamp markers through with no MapObject to judge them by', async () => {
    // Passport mode's entities are synthesised from getPassportMap; no
    // MapObject describes them. Filtering to the pipeline's KEPT set would
    // delete every one of them and blank the surface outright, which is exactly
    // why the filter drops by an explicit HIDDEN set instead.
    knobs.entities = STAMP_ENTITIES;
    knobs.objects = OBJECTS;
    knobs.layerPrefs = { hidden_gems: 'off', events: 'off' };
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['stamp:PH']));
  });

  it('draws nothing extra when there are no objects at all', async () => {
    // The legacy path (gateway off, per-layer fetches only) still supplies
    // entities. With no objects the filter must be a no-op, not a wipe.
    knobs.objects = [];
    knobs.layerPrefs = { hidden_gems: 'off', events: 'off' };
    await mount();

    await waitFor(() => expect(markerIds()).toEqual(['event:e1', 'gem:g1']));
  });
});
