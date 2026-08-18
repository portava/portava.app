/**
 * DiscoveryMapView — entity layers actually reach the map.
 *
 * ## The defect
 *
 * app/map/index.tsx passed four props into DiscoveryMapView:
 *
 *     entities={entities}
 *     enabledEntityLayers={enabledLayers}
 *     onSelectEntity={handleSelectEntity}
 *     filterRowOffset={insets.top + 68}
 *
 * DiscoveryMapViewProps declared NONE of them, and the component's destructure
 * did not pull them either, so React dropped all four. EntityMarkers.tsx — 389
 * lines implementing every entity marker and the clustering for them — had zero
 * non-test importers. Buddies, events, gems, trips, friends and passport stamps
 * produced carousel cards and no pins at all.
 *
 * TypeScript could not catch it because the lazy require at app/map/index.tsx:51
 * was typed `React.ComponentType<any>`, and `any` accepts any prop.
 *
 * Nobody noticed because the code documents behaviour it does not have. The
 * comment above the render site said entity layers "are injected via
 * entities/enabledEntityLayers props" — so a reader checking whether pins were
 * wired came away satisfied.
 *
 * ## What is asserted here
 *
 * That REAL markers reach the map, not that the props are forwarded.
 * EntityMarkers is deliberately NOT mocked: a captured-props mock would assert
 * DiscoveryMapView passes something onward, which is a restatement of the fix
 * rather than a check of it, and would still pass if EntityMapLayers rendered
 * nothing.
 *
 * places is [] in every case so the only <Marker> elements in the tree are
 * entity markers, and a count is unambiguous.
 *
 * Run: pnpm test:component  (matches --testPathPattern='\.component\.test\.')
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// ── Module mocks (declared before any import that pulls the real module) ──────

// MapLibre native modules are unavailable under jest; stub the whole package.
// Marker renders its children so the real entity markers below stay in the tree
// and can be counted and pressed.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const Map = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-container">{children}</RN.View>
  );
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => (
    <RN.View testID="map-marker">{children}</RN.View>
  );
  return { Map, Camera, Marker };
});

// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation
// native modules that are unavailable under jest; a requireActual spread would
// crash before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));

// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals; spreading requireActual would import native modules
// unavailable in the jest-expo runner. Null keeps the marker count in these
// tests equal to the entity-marker count.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));

// NOTE: intentionally exhaustive — TravelerPreviewCard imports native
// components that are not safe under jest; a null stub keeps the test focused
// on the entity layer.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));

// SectionErrorBoundary: transparent passthrough so children render normally.
// Without this a throw inside the entity layer would be swallowed and the test
// would report "0 pins" instead of the real error.
jest.mock('../SectionErrorBoundary', () => {
  const RN = jest.requireActual('react-native');
  return {
    SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => (
      <RN.View>{children}</RN.View>
    ),
  };
});

// NOTE: intentionally exhaustive — discoverMapFilterStorage is a thin
// persistence module with no native deps, but its module-level memory cache
// mutates across tests; a full stub with controlled return values avoids
// ordering dependencies between test cases.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

// NOTE: intentionally exhaustive — CachedImage resolves signed media URLs
// through the network/media layer. Buddy and friend markers render it when the
// entity has a photo; a plain View keeps those markers renderable without
// pulling the media stack into this test.
jest.mock('../../CachedImage', () => {
  const RN = jest.requireActual('react-native');
  return { CachedImage: (_props: unknown) => <RN.View testID="cached-image" /> };
});

// ── Import under test (after mocks) ──────────────────────────────────────────

import { DiscoveryMapView } from '../DiscoveryMapView';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noop = () => {};

/** Bangkok — matches the fallback coords passed in every case below. */
const AT: [number, number] = [13.7563, 100.5018];

function entity(
  id: string,
  type: MapEntity['type'],
  lat = AT[0],
  lng = AT[1],
): MapEntity {
  // Payload shapes differ per type; the markers under test read only a couple
  // of optional fields (coverPhotoUrl, avatarUrl, stampCount), so an empty
  // object exercises the icon branch of each marker.
  return { id, type, lat, lng, payload: {} as never };
}

const ALL_LAYERS: ToggleableEntityType[] = ['buddies', 'events', 'gems', 'trips', 'friends'];

/** Renders with places=[] so every <Marker> in the tree is an entity marker. */
function renderMap(props: Partial<React.ComponentProps<typeof DiscoveryMapView>> = {}) {
  return render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={AT[0]}
      fallbackLng={AT[1]}
      fallbackZoom={12}
      {...props}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryMapView — entity pins reach the map', () => {
  it('renders a pin for each entity when the layer is enabled', async () => {
    // The regression itself. Pre-fix this rendered zero markers, because
    // `entities` was never a declared prop and never reached the component.
    await renderMap({
      entities: [
        entity('e1', 'events', 13.75, 100.50),
        entity('g1', 'gems', 13.90, 100.90),
        entity('t1', 'trips', 14.10, 101.20),
      ],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity: noop,
    });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(3);
  });

  it('renders no entity pins when entities is empty', async () => {
    await renderMap({
      entities: [],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity: noop,
    });

    expect(screen.queryAllByTestId('map-marker')).toHaveLength(0);
  });

  it('still renders the map when no entity props are passed at all', async () => {
    // ForYouTab, DiscoveryCategoryTab and LayoverMapCard render this component
    // as a plain place map. The new props are optional and their absence must
    // not throw — `enabledLayers` would be undefined inside EntityMapLayers.
    await renderMap();

    expect(screen.getByTestId('map-container')).toBeTruthy();
    expect(screen.queryAllByTestId('map-marker')).toHaveLength(0);
  });
});

describe('DiscoveryMapView — enabledEntityLayers is honoured', () => {
  it('hides a layer the user has switched off', async () => {
    await renderMap({
      entities: [
        entity('e1', 'events', 13.75, 100.50),
        entity('g1', 'gems', 13.90, 100.90),
      ],
      enabledEntityLayers: ['events'], // gems off
      onSelectEntity: noop,
    });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
  });

  it('renders nothing when every layer is switched off', async () => {
    await renderMap({
      entities: [entity('e1', 'events'), entity('g1', 'gems')],
      enabledEntityLayers: [],
      onSelectEntity: noop,
    });

    expect(screen.queryAllByTestId('map-marker')).toHaveLength(0);
  });

  it('renders passport stamps even though stamps is not a toggleable layer', async () => {
    // 'stamps' is excluded from ToggleableEntityType by design — passport mode
    // is a mode, not a user-toggled layer — so EntityMapLayers passes it
    // through unconditionally. app/map/index.tsx relies on this: in passport
    // mode it passes enabledLayers: [].
    await renderMap({
      entities: [entity('s1', 'stamps', 13.75, 100.50)],
      enabledEntityLayers: [],
      onSelectEntity: noop,
    });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
  });
});

describe('DiscoveryMapView — entity pins are interactive', () => {
  it('calls onSelectEntity with the tapped entity', async () => {
    const onSelectEntity = jest.fn();
    await renderMap({
      entities: [entity('e1', 'events', 13.75, 100.50)],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity,
    });

    // The Pressable is the marker's only child; RNTL resolves the handler by
    // walking UP from the pressed node, so the child must be pressed directly.
    const marker = screen.getAllByTestId('map-marker')[0];
    fireEvent.press(marker.children[0] as never);

    expect(onSelectEntity).toHaveBeenCalledTimes(1);
    expect(onSelectEntity.mock.calls[0][0]).toMatchObject({ id: 'e1', type: 'events' });
  });

  it('renders no pins when onSelectEntity is missing', async () => {
    // Deliberate: a pin the user cannot tap is worse than no pin, because the
    // preview card is the only way to act on an entity. The layer is gated on
    // the handler rather than rendering dead pins.
    await renderMap({
      entities: [entity('e1', 'events')],
      enabledEntityLayers: ALL_LAYERS,
    });

    expect(screen.queryAllByTestId('map-marker')).toHaveLength(0);
  });
});

describe('DiscoveryMapView — clustering', () => {
  it('collapses three co-located entities of one type into a single bubble', async () => {
    // MIN_CLUSTER is 3 in EntityMarkers. Identical coords guarantee one grid
    // cell at any zoom, so this does not depend on the cell-size maths.
    await renderMap({
      entities: [
        entity('e1', 'events'),
        entity('e2', 'events'),
        entity('e3', 'events'),
      ],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity: noop,
    });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
    // The bubble shows the collapsed count — proof it is a cluster and not one
    // surviving pin with the other two silently dropped.
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('does not cluster two co-located entities', async () => {
    await renderMap({
      entities: [entity('e1', 'events'), entity('e2', 'events')],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity: noop,
    });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
  });

  it('does not cluster co-located entities of different types', async () => {
    // Clustering is per-type: a buddy and an event in the same cell stay two
    // pins, because collapsing them would lose the type the colour encodes.
    await renderMap({
      entities: [
        entity('e1', 'events'),
        entity('e2', 'events'),
        entity('e3', 'events'),
        entity('g1', 'gems'),
        entity('g2', 'gems'),
      ],
      enabledEntityLayers: ALL_LAYERS,
      onSelectEntity: noop,
    });

    // 3 events → 1 cluster bubble; 2 gems → 2 individual pins.
    expect(screen.getAllByTestId('map-marker')).toHaveLength(3);
  });
});
