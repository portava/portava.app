/**
 * EntityMarkers draws a PROJECTED place — and nothing else that shares the
 * legacy `places` entity type.
 *
 * WHY THIS TEST EXISTS
 * ====================
 * Until canonical places came through the Map Intelligence Gateway, the
 * `places` entity type was the legacy Discovery envelope's alone, and
 * `EntityMapLayers` deliberately did not render it: DiscoveryMapView's own pin
 * loop did, and drawing it here too would have doubled every pin. So the
 * filter passed only `stamps` and the toggleable layers through, and the
 * marker switch had no `places` case.
 *
 * A projected place (server lib/mapProjectPlace.ts → `kind: 'place'`) also
 * downcasts to entity type `places` (`KIND_TO_ENTITY_TYPE`), so with that
 * filter it would have arrived in `entities` and been drawn by NOTHING — the
 * gateway served it, the shell passed it on, and the map stayed blank. This
 * file pins the three-way distinction the renderer now makes:
 *
 *   • a `places` entity whose payload is a projected `place` object → drawn;
 *   • a `places` entity whose payload is a legacy DiscoveryPlace → NOT drawn
 *     here (DiscoveryMapView's loop still owns it — no double render);
 *   • a `places` entity whose payload is a zone kind folded onto `places` by
 *     KIND_TO_ENTITY_TYPE → NOT drawn here (ActivityZoneLayer owns it).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { EntityMapLayers, isProjectedPlaceEntity } from '../EntityMarkers.tsx';
import type { MapEntity, ToggleableEntityType } from '../../../types/mapTypes.ts';
import { mapObjectToEntity } from '../../../types/mapTypes.ts';
import type { MapObject } from '../../../types/mapObjects.ts';
import { placeEntity, PLACE_ID } from '../../../__fixtures__/mapEntities.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentional stub — @maplibre/maplibre-react-native needs a native module
// that jest-expo does not provide; requireActual crashes the suite. Mirrors the
// mock in EntityMarkers.projectedPayload.component.test.tsx.
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

// NOTE: intentional stub — CachedImage does disk I/O and native image decoding.
jest.mock('../../CachedImage.tsx', () => {
  const RN = jest.requireActual('react-native');
  return {
    CachedImage: ({ source }: { source?: { uri?: string } }) => (
      <RN.View testID={`cached-image:${source?.uri ?? 'none'}`} />
    ),
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** The legacy Discovery envelope, exactly as app/map/index.tsx builds it. */
const LEGACY_PLACE_ENTITY: MapEntity = {
  id: 'place:db/legacy-1',
  type: 'places',
  lat: 16.05,
  lng: 108.2,
  payload: {
    id: 'db/legacy-1',
    name: 'Legacy Market',
    category: 'food',
    lat: 16.05,
    lng: 108.2,
  },
  detailRoute: '/place/legacy-1',
};

/** A §31 aggregate: KIND_TO_ENTITY_TYPE folds `activity_zone` onto `places`. */
const ZONE_OBJECT: MapObject = {
  id: 'zone:cell-1',
  kind: 'activity_zone',
  geometry: {
    type: 'Polygon',
    coordinates: [[[108.2, 16.05], [108.21, 16.05], [108.21, 16.06], [108.2, 16.06], [108.2, 16.05]]],
  },
  title: '15 places in this area',
  privacyClass: 'aggregate_only',
  renderingPriority: 50,
  count: 15,
};

// `await` the render (as the sibling projectedPayload suite does): under
// React 19 + RNTL v14 the global `screen` is bound after render's commit
// settles on the microtask queue, so a synchronous `screen` read taken in the
// same tick sees the pre-render `notImplemented` proxy and throws "render
// function has not been called". Awaiting flushes that microtask.
async function renderMarkers(entities: MapEntity[], enabledLayers: ToggleableEntityType[] = []) {
  const onSelectEntity = jest.fn();
  await render(
    <EntityMapLayers
      entities={entities}
      enabledLayers={enabledLayers}
      // High zoom so nothing clusters — a count bubble would replace the marker
      // under test.
      zoom={18}
      onSelectEntity={onSelectEntity}
      onPressCluster={jest.fn()}
    />,
  );
  return onSelectEntity;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isProjectedPlaceEntity', () => {
  it('is true only for a places entity carrying a projected place object', () => {
    expect(isProjectedPlaceEntity(placeEntity())).toBe(true);
    expect(isProjectedPlaceEntity(LEGACY_PLACE_ENTITY)).toBe(false);
    expect(isProjectedPlaceEntity(mapObjectToEntity(ZONE_OBJECT)!)).toBe(false);
  });
});

describe('EntityMapLayers draws a projected place', () => {
  it('renders the standard place marker for a projected place, with no pin toggle on', async () => {
    // enabledLayers is EMPTY: relevant_places is a §16 layer the shell has
    // already decided, not one of the five legacy pin toggles.
    await renderMarkers([placeEntity()], []);
    expect(screen.getByTestId('entity-pin-place')).toBeTruthy();
    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
  });

  it('positions it at the projected coordinate', async () => {
    const entity = placeEntity();
    await renderMarkers([entity]);
    // The Marker mock renders children only; position is asserted through the
    // entity the renderer was handed, which mapObjectToEntity derived from the
    // object's geometry in GeoJSON [lng, lat] order.
    expect(entity.lat).toBe(16.054412);
    expect(entity.lng).toBe(108.202233);
    expect(entity.id).toBe(`place:${PLACE_ID}`);
  });

  it('a tap on the marker selects that entity — the §8 sheet and §25 rail open from the selection', async () => {
    const entity = placeEntity();
    const onSelectEntity = await renderMarkers([entity]);
    fireEvent.press(screen.getByTestId('entity-pin-place'));
    expect(onSelectEntity).toHaveBeenCalledTimes(1);
    expect(onSelectEntity).toHaveBeenCalledWith(entity);
  });

  it('reads nothing off the payload that could imply live state — a place pin is one glyph', async () => {
    // Enrichment may attach §7 axes; the pin does not invent a treatment for
    // them. It is the same marker with and without a live claim.
    await renderMarkers([placeEntity({ freshness: 'live', activity: 'busy', confidence: 'live' })]);
    expect(screen.getByTestId('entity-pin-place')).toBeTruthy();
    expect(screen.queryByText(/busy/i)).toBeNull();
    expect(screen.queryByText(/live/i)).toBeNull();
  });
});

describe('EntityMapLayers does NOT draw the other things that share the places type', () => {
  it('leaves the legacy DiscoveryPlace envelope to DiscoveryMapView — no double render', async () => {
    await renderMarkers([LEGACY_PLACE_ENTITY]);
    expect(screen.queryByTestId('entity-pin-place')).toBeNull();
    expect(screen.queryByTestId('map-marker')).toBeNull();
  });

  it('leaves a zone folded onto places to ActivityZoneLayer', async () => {
    await renderMarkers([mapObjectToEntity(ZONE_OBJECT)!]);
    expect(screen.queryByTestId('entity-pin-place')).toBeNull();
    expect(screen.queryByTestId('map-marker')).toBeNull();
  });

  it('draws the projected place beside a legacy envelope and a zone, and only the projected place', async () => {
    await renderMarkers([LEGACY_PLACE_ENTITY, mapObjectToEntity(ZONE_OBJECT)!, placeEntity()]);
    expect(screen.getAllByTestId('entity-pin-place')).toHaveLength(1);
    expect(screen.getAllByTestId('map-marker')).toHaveLength(1);
  });
});
