/**
 * MediaMapScreen — the §4 / §21 Media Map, rendered (census-media §19: MD25 ·
 * MD329 · MD405 · MD416 · MD92, and the Map modes of MD30 / MD31 / MD32 / MD33 /
 * MD35).
 *
 * The MapLibre stub here RENDERS its children and records what it was handed,
 * so the assertions are about what is actually drawn:
 *   • a count bubble at each place the canonical Map positioned — and ONLY there;
 *   • a place the Map did not position is LISTED under "Not on this map view",
 *     never drawn;
 *   • an APPROXIMATE gem is a filled + contoured polygon and NOT a marker; a
 *     place-level gem is a contoured marker (§46.1);
 *   • no viewer location ⇒ the canonical Map is not even asked, and the screen
 *     says why nothing is placed;
 *   • opening a cluster hands it to the caller (the §14 Map entry context).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MediaMapScreen } from '../screens/MediaMapScreen.tsx';

const mockFetchMediaMap = jest.fn();
const mockFetchMapProjection = jest.fn();
const drawn: { sources: Array<{ id: string; data: any }>; layers: Array<{ id: string; type: string; paint: any }>; markers: number[][] } = {
  sources: [],
  layers: [],
  markers: [],
};

jest.mock('../services/mediaProjection.ts', () => ({
  ...jest.requireActual('../services/mediaProjection.ts'),
  fetchMediaMap: (...args: unknown[]) => mockFetchMediaMap(...args),
}));
jest.mock('../../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../../services/mapProjection.ts'),
  fetchMapProjection: (...args: unknown[]) => mockFetchMapProjection(...args),
}));
// NOTE: intentionally exhaustive — the global maplibre stub renders nothing
// for children; this one renders them and RECORDS every source, layer and
// marker, which is the only way to assert what the canvas draws.
jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Pass = ({ children }: any) => <View>{children}</View>;
  return {
    Map: ({ children }: any) => <View testID="maplibre-map">{children}</View>,
    Camera: () => null,
    Marker: ({ lngLat, children }: any) => {
      drawn.markers.push(lngLat);
      return <View>{children}</View>;
    },
    GeoJSONSource: ({ id, data, children }: any) => {
      drawn.sources.push({ id, data });
      return <Pass>{children}</Pass>;
    },
    Layer: ({ id, type, paint }: any) => {
      drawn.layers.push({ id, type, paint });
      return null;
    },
  };
});

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const CENTER = { lat: 16.05, lng: 108.22 };

function mapObjects(extra: unknown[] = []) {
  return {
    ok: true,
    data: {
      enabled: true,
      objects: [
        { id: `place:${P1}`, kind: 'place', title: 'An Thuong', privacyClass: 'place_level', renderingPriority: 1, geometry: { type: 'Point', coordinates: [108.24, 16.06] } },
        ...extra,
      ],
    },
  };
}

beforeEach(() => {
  mockFetchMediaMap.mockReset();
  mockFetchMapProjection.mockReset();
  drawn.sources = [];
  drawn.layers = [];
  drawn.markers = [];
  mockFetchMediaMap.mockResolvedValue({
    ok: true,
    data: {
      generatedAt: null,
      totalPerspectives: 11,
      clusters: [
        { placeId: P1, label: 'An Thuong', perspectiveCount: 8, freshness: 'fresh' },
        { placeId: P2, label: 'My Khe', perspectiveCount: 3, freshness: 'recent' },
      ],
    },
  });
});

describe('MediaMapScreen', () => {
  it('draws a bubble ONLY where the canonical Map positioned the place; the rest is listed, never placed', async () => {
    mockFetchMapProjection.mockResolvedValue(mapObjects());
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-canvas')).toBeTruthy());
    expect(mockFetchMediaMap).toHaveBeenCalledWith(expect.objectContaining({ city: 'Da Nang' }));
    expect(mockFetchMapProjection).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['place'] }));
    expect(screen.getByTestId(`media-map-cluster-${P1}`)).toBeTruthy();
    expect(screen.queryByTestId(`media-map-cluster-${P2}`)).toBeNull();
    expect(drawn.markers).toEqual([[108.24, 16.06]]);
    expect(screen.getByText('Not on this map view')).toBeTruthy();
    expect(screen.getByTestId(`media-map-row-${P2}`)).toBeTruthy();
    expect(screen.getByText('Da Nang · Media Map')).toBeTruthy();
  });

  it('§46.1: an APPROXIMATE gem is a filled, contoured AREA and never a marker; a place-level gem is a contoured marker', async () => {
    mockFetchMapProjection.mockResolvedValue(
      mapObjects([
        { id: 'gem:approx', kind: 'hidden_gem', title: 'Approx gem', privacyClass: 'approximate', renderingPriority: 2, geometry: { type: 'Point', coordinates: [108.3, 16.1] } },
        { id: 'gem:exact', kind: 'hidden_gem', title: 'Place gem', privacyClass: 'place_level', renderingPriority: 2, geometry: { type: 'Point', coordinates: [108.25, 16.07] } },
        { id: 'gem:hidden', kind: 'hidden_gem', title: 'Hidden gem', privacyClass: 'none', renderingPriority: 2, geometry: { type: 'Point', coordinates: [108.1, 16.0] } },
      ]),
    );
    await render(<MediaMapScreen city="Da Nang" center={CENTER} includeGems />);
    await waitFor(() => expect(screen.getByTestId('media-map-canvas')).toBeTruthy());
    const zoneSource = drawn.sources.find((s) => s.id === 'media-gem-zones');
    expect(zoneSource).toBeTruthy();
    expect(zoneSource!.data.features.map((f: any) => f.properties.gemId)).toEqual(['approx']);
    expect(zoneSource!.data.features[0].geometry.type).toBe('Polygon');
    expect(drawn.layers.map((l) => l.type).sort()).toEqual(['fill', 'line']);
    // The contour is SOLID: a dashed edge means a forecast in the map vocabulary.
    expect(drawn.layers.find((l) => l.type === 'line')!.paint['line-dasharray']).toBeUndefined();
    // No marker sits on the approximate centroid; the place-level gem has one.
    expect(drawn.markers).not.toContainEqual([108.3, 16.1]);
    expect(screen.queryByTestId('media-map-gem-approx')).toBeNull();
    expect(screen.getByTestId('media-map-gem-exact')).toBeTruthy();
    // A `none`-rung gem is not drawn and not listed.
    expect(screen.queryByTestId('media-map-gem-row-hidden')).toBeNull();
    expect(screen.getByText('Shaded areas are hidden gems shown only approximately — never a doorstep.')).toBeTruthy();
  });

  it('with no viewer location the canonical Map is NOT asked, nothing is placed, and the screen says why', async () => {
    await render(<MediaMapScreen city="Da Nang" center={null} />);
    await waitFor(() => expect(screen.getByTestId('media-map-positions-unavailable')).toBeTruthy());
    expect(mockFetchMapProjection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('media-map-canvas')).toBeNull();
    expect(screen.getByTestId(`media-map-row-${P1}`)).toBeTruthy();
  });

  it('a disabled Map gateway is said in words — the places are still listed, not blanked', async () => {
    mockFetchMapProjection.mockResolvedValue({ ok: true, data: { enabled: false, objects: [] } });
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-positions-unavailable')).toBeTruthy());
    expect(screen.getByText(/Map positions are not available right now/)).toBeTruthy();
    expect(screen.getByTestId(`media-map-row-${P2}`)).toBeTruthy();
  });

  it('an unreadable count is an ERROR, never "no one is out"', async () => {
    mockFetchMediaMap.mockResolvedValue({ ok: false, data: null, errorKind: 'server', message: 'HTTP 503' });
    mockFetchMapProjection.mockResolvedValue(mapObjects());
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByText('The Media Map could not load')).toBeTruthy());
  });

  it('selecting a cluster and opening it hands THAT cluster to the caller (the §14 Map entry context)', async () => {
    mockFetchMapProjection.mockResolvedValue(mapObjects());
    const onOpenCluster = jest.fn();
    await render(<MediaMapScreen city="Da Nang" center={CENTER} onOpenCluster={onOpenCluster} />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cluster-${P1}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`media-map-cluster-${P1}`));
    await waitFor(() => expect(screen.getByTestId('media-map-selected')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-map-open-cluster'));
    expect(onOpenCluster).toHaveBeenCalledWith(expect.objectContaining({ placeId: P1, perspectiveCount: 8 }));
  });

  it('a lens-supplied cluster source (My World\'s own places) is what gets positioned', async () => {
    mockFetchMapProjection.mockResolvedValue(mapObjects());
    const loadClusters = jest.fn().mockResolvedValue({
      ok: true,
      data: [{ placeId: P1, label: 'My rooftop', perspectiveCount: 2, freshness: 'recent' }],
    });
    await render(<MediaMapScreen center={CENTER} loadClusters={loadClusters} title="My World" />);
    await waitFor(() => expect(screen.getByTestId(`media-map-cluster-${P1}`)).toBeTruthy());
    expect(loadClusters).toHaveBeenCalled();
    expect(mockFetchMediaMap).not.toHaveBeenCalled();
    expect(screen.getByText('My rooftop')).toBeTruthy();
  });
});
