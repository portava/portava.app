/**
 * §6 "blue dot = current user", on the real map canvas (census-map M43).
 *
 * ## What this file proves that the marker's own suite cannot
 *
 * M43's criterion is "a component test mounts THE REAL MAP CANVAS with a viewer
 * position and finds a user-position node in the tree", with the second half
 * being that it is there when `entities.length === 0`. Both halves are about
 * the CANVAS, not the marker: the defect M43 names is a user-position node that
 * only mounts inside some other layer's non-empty branch, so a viewer with no
 * pins around them cannot see themselves.
 *
 * `DiscoveryMapView` is that canvas — `app/map/index.tsx` renders it, and its
 * own header calls it "the flagship map".
 *
 * ## A correction to the census's evidence for this row
 *
 * The census's stated evidence is
 * `grep -n "UserLocation\|showUserLocation" DiscoveryMapView.tsx` returning no
 * matches. That grep is accurate and the conclusion drawn from it is not: the
 * canvas HAS drawn a viewer dot, as a `<Marker key="me-marker">` carrying an
 * inline blue circle, which no grep for the SDK's puck would ever find. What
 * was genuinely missing was (a) any assertion that it mounts, (b) any identity
 * on the node, and (c) one source shared with `LayersSheet`'s `blue_dot` legend
 * row, whose colour had already drifted from the marker's.
 *
 * So this file asserts the property the row is actually about — the node is on
 * the canvas, at the viewer's coordinate, independent of every other layer —
 * rather than the spelling of the component that draws it.
 *
 * ## Anti-vacuity
 *
 * Three arms, and the second and third are what stop this passing against a
 * canvas that draws a Marker for everything:
 *   1. with a viewer position and NO entities and NO places -> exactly one
 *      marker, at the viewer's coordinate;
 *   2. with NO viewer position -> zero markers, so "a marker exists" cannot be
 *      satisfied by scenery;
 *   3. with a viewer position AND places -> the viewer marker is still there,
 *      and is distinguishable from the place pins by its coordinate.
 *
 * Run: pnpm --filter travel-buddy-standalone test:component
 *   or: npx jest --forceExit src/components/map/__tests__/DiscoveryMapView.userPosition.component.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { DiscoveryMapView } from '../../discovery/DiscoveryMapView';
import { USER_POSITION_TEST_ID } from '../UserPositionMarker.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

type MarkerRender = { lngLat: unknown };
const markers: MarkerRender[] = [];

// NOTE: intentional stub — @maplibre/maplibre-react-native needs native GL
// modules jest-expo does not provide, so requireActual crashes the suite. It is
// exhaustive on purpose and differs from the shared stub in the one way this
// measurement needs: it RECORDS every Marker's coordinate. The shared stub
// drops props, so "a marker at the viewer's position" would be unfalsifiable.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  const Pass = (name: string) => (props: { children?: unknown }) =>
    React_.createElement(RN.View, { testID: `ml:${name}` }, props.children);
  return {
    Map: Pass('map'),
    MapView: Pass('mapview'),
    Camera: React_.forwardRef((_p: unknown, _r: unknown) =>
      React_.createElement(RN.View, { testID: 'ml:camera' })),
    Marker: (props: { lngLat: unknown; children?: unknown }) => {
      markers.push({ lngLat: props.lngLat });
      return React_.createElement(RN.View, { testID: 'ml:marker' }, props.children);
    },
    UserLocation: (props: { testID?: string }) =>
      React_.createElement(RN.View, { testID: props.testID ?? 'ml:user-location' }),
    GeoJSONSource: Pass('geojson-source'),
    Layer: Pass('layer'),
    ShapeSource: Pass('shape-source'),
    SymbolLayer: Pass('symbol-layer'),
    CircleLayer: Pass('circle-layer'),
    FillLayer: Pass('fill-layer'),
    LineLayer: Pass('line-layer'),
    PointAnnotation: Pass('point-annotation'),
    MarkerView: Pass('marker-view'),
  };
});

/** Da Nang — the fixture city used across the map suites. */
const LAT = 16.0544;
const LNG = 108.2022;

const PLACE: DiscoveryPlace = {
  id: 'osm/node/1',
  name: 'An Thuong Coffee',
  category: 'cafe',
  lat: 16.04,
  lng: 108.24,
} as unknown as DiscoveryPlace;

beforeEach(() => {
  markers.length = 0;
});

/**
 * The DISTINCT coordinates any Marker was drawn at, over the whole mount.
 *
 * The canvas re-renders several times as it settles (the AsyncStorage filter
 * restore and the travelers toggle both resolve after the first paint), so the
 * raw capture holds one entry per marker per pass. What the row is about is
 * WHICH POINTS get a marker, not how many times React drew them, and a set is
 * the honest reading of that. It is also the conservative one: a canvas that
 * drew the viewer twice at the same point still reports one.
 */
function markedPoints(): string[] {
  return [...new Set(markers.map((m) => JSON.stringify(m.lngLat)))];
}

const VIEWER_POINT = JSON.stringify([LNG, LAT]);

describe('§6 blue dot — the real map canvas', () => {
  it('draws the viewer with no entities and no places on the map at all', async () => {
    // The whole point of the row: where the viewer is does not depend on how
    // many other objects the projection returned.
    await render(
      <DiscoveryMapView
        userLat={LAT}
        userLng={LNG}
        places={[]}
        entities={[]}
        onSelectPlace={() => {}}
      />,
    );
    expect(markedPoints()).toEqual([VIEWER_POINT]);
    // …and it is the §6 marker component, not an anonymous inline dot. This is
    // what makes the legend's `blue_dot` row and the thing on the map one
    // object rather than two literals that drifted apart.
    expect(screen.getByTestId(USER_POSITION_TEST_ID)).toBeTruthy();
  });

  it('draws nothing viewer-shaped when there is no viewer position', async () => {
    // Anti-vacuity: without this, "a marker exists" is satisfied by scenery.
    await render(
      <DiscoveryMapView places={[]} entities={[]} onSelectPlace={() => {}} />,
    );
    expect(markers).toHaveLength(0);
    expect(screen.queryByTestId(USER_POSITION_TEST_ID)).toBeNull();
  });

  it('keeps the viewer marker when place pins are also on the map', async () => {
    await render(
      <DiscoveryMapView
        userLat={LAT}
        userLng={LNG}
        places={[PLACE]}
        entities={[]}
        onSelectPlace={() => {}}
      />,
    );
    const points = markedPoints();
    expect(points).toContain(VIEWER_POINT);
    // And the place pin is a DIFFERENT point, so the assertion above is not
    // the place pin wearing the viewer's coordinate.
    expect(points).toContain(JSON.stringify([PLACE.lng, PLACE.lat]));
    expect(points.length).toBeGreaterThan(1);
  });
});
