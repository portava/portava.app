/**
 * DiscoveryMapView — the selected entity is visible on the map.
 *
 * ## The defect
 *
 * mapStore.tsx declares selectedEntityId and documents it as "which entity
 * marker / carousel card is active". app/map/index.tsx writes it on every
 * marker tap and reads it back for carousel restoration. Nothing on the map
 * ever read it: EntityMapLayersProps had no such field, so no marker could
 * know it was selected.
 *
 * Selection therefore existed as state and never as pixels. Tapping a pin moved
 * the camera and scrolled the carousel, and every pin on screen went on looking
 * exactly the same. The tab-switch handler in app/map/index.tsx even clears the
 * value "so the map doesn't open with a ghost highlight" — guarding against a
 * highlight that did not exist.
 *
 * ## Why these assertions read the rendered tree
 *
 * The store already holds the right value today, and a spy on setSelectedEntityId
 * already fires today — both would pass against the unfixed component, because
 * the bug is not a wrong value, it is a value that reaches nothing. The gap is
 * between state that exists and state that renders, so every assertion below
 * looks at what the tree actually shows for a selected pin versus an unselected
 * one, including the ring's colour rather than only its presence.
 *
 * Run: pnpm test:component
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// ── Module mocks (declared before any import that pulls the real module) ──────

// MapLibre native modules are unavailable under jest; stub the whole package.
// Marker renders children so the real markers stay in the tree.
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
// native modules unavailable under jest; a requireActual spread would crash
// before any test runs.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));

// NOTE: intentionally exhaustive — TravelerClusterMarkers depends on native
// MapLibre marker internals; null keeps the marker count equal to the
// entity-marker count.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));

// NOTE: intentionally exhaustive — TravelerPreviewCard imports native
// components that are not safe under jest.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));

// SectionErrorBoundary: transparent passthrough. Without it a throw inside the
// entity layer would be swallowed and read as "no highlight" instead of an error.
jest.mock('../SectionErrorBoundary', () => {
  const RN = jest.requireActual('react-native');
  return {
    SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => (
      <RN.View>{children}</RN.View>
    ),
  };
});

// NOTE: intentionally exhaustive — discoverMapFilterStorage keeps a
// module-level memory cache that mutates across tests; a full stub with
// controlled return values avoids ordering dependencies.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

// NOTE: intentionally exhaustive — CachedImage resolves signed media URLs
// through the network/media layer; a plain View keeps avatar-bearing markers
// renderable without pulling in the media stack.
jest.mock('../../CachedImage', () => {
  const RN = jest.requireActual('react-native');
  return { CachedImage: (_props: unknown) => <RN.View testID="cached-image" /> };
});

// ── Import under test (after mocks) ──────────────────────────────────────────

import { DiscoveryMapView } from '../DiscoveryMapView';
import { MAP_LAYER_CONFIG } from '../../../types/mapTypes.ts';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noop = () => {};
const ALL_LAYERS: ToggleableEntityType[] = ['buddies', 'events', 'gems', 'trips', 'friends'];

function entity(id: string, type: MapEntity['type'], lat: number, lng: number): MapEntity {
  return { id, type, lat, lng, payload: {} as never };
}

/** Three entities far enough apart that none of them cluster. */
const SPREAD = [
  entity('e1', 'events', 13.75, 100.50),
  entity('e2', 'events', 14.50, 101.50),
  entity('g1', 'gems', 15.50, 102.50),
];

function renderMap(props: Partial<React.ComponentProps<typeof DiscoveryMapView>> = {}) {
  return render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={13.75}
      fallbackLng={100.5}
      fallbackZoom={12}
      enabledEntityLayers={ALL_LAYERS}
      onSelectEntity={noop}
      {...props}
    />,
  );
}

/** Flattened style of the selection ring, or null when nothing is selected. */
function ringStyle(testID = 'entity-pin-selected') {
  const nodes = screen.queryAllByTestId(testID);
  if (nodes.length === 0) return null;
  return StyleSheet.flatten(nodes[0].props.style) as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryMapView — a selected pin looks different from an unselected one', () => {
  it('draws the selection ring on exactly the selected pin', async () => {
    // The regression. Pre-fix the tree was identical whatever selectedEntityId
    // held, because no marker received it.
    await renderMap({ entities: SPREAD, selectedEntityId: 'e1' });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(3);
    expect(screen.getAllByTestId('entity-pin-selected')).toHaveLength(1);
  });

  it('draws no ring at all when nothing is selected', async () => {
    // The state the map opens in, and the state the tab-switch clear restores.
    await renderMap({ entities: SPREAD, selectedEntityId: null });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(3);
    expect(screen.queryAllByTestId('entity-pin-selected')).toHaveLength(0);
  });

  it('draws no ring when the prop is omitted entirely', async () => {
    // Every other DiscoveryMapView consumer (ForYouTab, DiscoveryCategoryTab,
    // LayoverMapCard) omits it; absence must mean "nothing selected", not a crash.
    await renderMap({ entities: SPREAD });

    expect(screen.queryAllByTestId('entity-pin-selected')).toHaveLength(0);
  });

  it('draws no ring when the selected id matches no entity on the map', async () => {
    // A stale id survives an entity re-fetch — it must highlight nothing rather
    // than defaulting to the first pin.
    await renderMap({ entities: SPREAD, selectedEntityId: 'deleted-entity' });

    expect(screen.queryAllByTestId('entity-pin-selected')).toHaveLength(0);
  });

  it('moves the ring when the selection changes', async () => {
    // Selection is not a one-shot mount effect; it has to follow the store.
    const { rerender } = await renderMap({ entities: SPREAD, selectedEntityId: 'e1' });
    expect(ringStyle()?.borderColor).toBe(MAP_LAYER_CONFIG.events.color);

    await rerender(
      <DiscoveryMapView
        places={[]}
        onSelectPlace={noop}
        fallbackLat={13.75}
        fallbackLng={100.5}
        fallbackZoom={12}
        enabledEntityLayers={ALL_LAYERS}
        onSelectEntity={noop}
        entities={SPREAD}
        selectedEntityId="g1"
      />,
    );

    // Still exactly one ring, now carrying the gems accent instead of events —
    // proof it moved rather than a second one appearing.
    expect(screen.getAllByTestId('entity-pin-selected')).toHaveLength(1);
    expect(ringStyle()?.borderColor).toBe(MAP_LAYER_CONFIG.gems.color);
  });
});

describe('DiscoveryMapView — the ring is a real visual, in the layer colour', () => {
  it('borders the ring in the selected entity type accent colour', async () => {
    // Asserted on the flattened style rather than the testID alone: a testID
    // that renders no visible difference would satisfy a presence check while
    // leaving the pin indistinguishable on screen, which is the original bug.
    await renderMap({ entities: SPREAD, selectedEntityId: 'g1' });

    const style = ringStyle();
    expect(style?.borderColor).toBe(MAP_LAYER_CONFIG.gems.color);
    expect(style?.borderWidth).toBeGreaterThan(0);
  });

  it('uses each layer own colour rather than one shared highlight', async () => {
    await renderMap({ entities: SPREAD, selectedEntityId: 'e2' });

    expect(ringStyle()?.borderColor).toBe(MAP_LAYER_CONFIG.events.color);
    expect(MAP_LAYER_CONFIG.events.color).not.toBe(MAP_LAYER_CONFIG.gems.color);
  });
});

describe('DiscoveryMapView — selection survives clustering', () => {
  /** Three co-located events collapse to one cluster (MIN_CLUSTER is 3). */
  const CLUSTERED = [
    entity('c1', 'events', 13.75, 100.50),
    entity('c2', 'events', 13.75, 100.50),
    entity('c3', 'events', 13.75, 100.50),
    entity('far', 'gems', 15.50, 102.50),
  ];

  it('marks the cluster that contains the selected entity', async () => {
    // Without this the highlight would vanish exactly when three pins collapse
    // — the zoom level where picking the right pin matters most.
    await renderMap({ entities: CLUSTERED, selectedEntityId: 'c2' });

    expect(screen.getAllByTestId('map-marker')).toHaveLength(2); // 1 cluster + 1 gem
    expect(screen.getAllByTestId('entity-cluster-selected')).toHaveLength(1);
    // The single pin is not the selected one, so no single-pin ring.
    expect(screen.queryAllByTestId('entity-pin-selected')).toHaveLength(0);
  });

  it('leaves the cluster unmarked when the selected entity is outside it', async () => {
    await renderMap({ entities: CLUSTERED, selectedEntityId: 'far' });

    expect(screen.queryAllByTestId('entity-cluster-selected')).toHaveLength(0);
    expect(screen.getAllByTestId('entity-pin-selected')).toHaveLength(1);
  });

  it('borders the cluster ring in the cluster type colour', async () => {
    await renderMap({ entities: CLUSTERED, selectedEntityId: 'c3' });

    const style = ringStyle('entity-cluster-selected');
    expect(style?.borderColor).toBe(MAP_LAYER_CONFIG.events.color);
    expect(style?.borderWidth).toBeGreaterThan(0);
  });
});

describe('DiscoveryMapView — selection respects layer visibility', () => {
  it('shows no ring when the selected entity layer is switched off', async () => {
    // The pin is not on the map, so nothing should be highlighted — a ring
    // without a pin under it would be a floating artefact.
    await renderMap({
      entities: SPREAD,
      enabledEntityLayers: ['events'], // gems off
      selectedEntityId: 'g1',
    });

    expect(screen.queryAllByTestId('entity-pin-selected')).toHaveLength(0);
    expect(screen.getAllByTestId('map-marker')).toHaveLength(2);
  });
});
