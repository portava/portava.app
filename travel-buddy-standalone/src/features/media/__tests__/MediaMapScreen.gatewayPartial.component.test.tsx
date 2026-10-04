/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW3): the Media Map says a canonical-Map answer that did
 * not read what it asked for, or is one page of several.
 *
 * useMediaMap asks the NOW gateway (GET /map/projection) for `place` objects — and `hidden_gem` ones on a gem map —
 * with `limit: 200`, and used only `enabled` and `objects`. A gateway that could not read its places or gems does not
 * name them in `sources`; a longer answer carries `nextCursor`. Both were dropped: a place whose position was not read
 * was listed as "Not on this map view", and a gem map whose gem read failed said it was EMPTY.
 *
 *   MP0  CONTROL: every requested layer named, no nextCursor → no partial notice (unchanged)
 *   MP1  the places read not named → "Some of this map could not be read…", the places still listed
 *   MP2  a gem-only map whose gem read is not named → the partial notice, never the empty state
 *   MP3  the answer is page one of several (nextCursor set) → the partial notice
 *   MP4  the rule: a requested kind whose source is not named, or a nextCursor, is partial; the flag off is not
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

const whole = (extra: unknown[] = [], sources = ['places', 'gems'], nextCursor: string | null = null) => {
  const r = mapObjects(extra) as any;
  r.data.sources = sources; r.data.nextCursor = nextCursor;
  return r;
};
const PARTIAL = 'Some of this map could not be read \u2014 places and gems here may be missing.';

describe('§114 SW3: the Media Map says a gateway answer that is not whole', () => {
  it('MP0 CONTROL: every requested layer named, no nextCursor → no partial notice', async () => {
    mockFetchMapProjection.mockResolvedValue(whole());
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-canvas')).toBeTruthy());
    expect(screen.queryByTestId('media-map-partial')).toBeNull();
  });

  it('MP1 the places read not named → the partial notice, the places still listed', async () => {
    mockFetchMapProjection.mockResolvedValue(whole([], []));
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-partial')).toBeTruthy());
    expect(screen.getByText(PARTIAL)).toBeTruthy();
    expect(screen.getByTestId(`media-map-row-${P2}`)).toBeTruthy();
  });

  it('MP2 a gem-only map whose gem read is not named → the partial notice, never the empty state', async () => {
    mockFetchMapProjection.mockResolvedValue(whole([], ['places']));
    const loadClusters = jest.fn().mockResolvedValue({ ok: true, data: [] });
    await render(<MediaMapScreen center={CENTER} loadClusters={loadClusters} includeGems emptyTitle="No hidden gems on the map yet" />);
    await waitFor(() => expect(screen.getByTestId('media-map-partial')).toBeTruthy());
    expect(screen.queryByText('No hidden gems on the map yet')).toBeNull();
  });

  it('MP3 the answer is page one of several → the partial notice', async () => {
    mockFetchMapProjection.mockResolvedValue(whole([], ['places'], '200'));
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-partial')).toBeTruthy());
  });

  it('MP4 the rule: a requested kind not named, or a nextCursor, is partial; a whole answer is not', () => {
    const { mediaMapGatewayPartial } = jest.requireActual('../state/mediaMapStore.ts');
    expect(mediaMapGatewayPartial({ sources: ['places'], nextCursor: null }, ['place'])).toBe(false);
    expect(mediaMapGatewayPartial({ sources: ['places', 'gems'], nextCursor: null }, ['place', 'hidden_gem'])).toBe(false);
    expect(mediaMapGatewayPartial({ sources: ['places'], nextCursor: null }, ['place', 'hidden_gem'])).toBe(true);
    expect(mediaMapGatewayPartial({ sources: ['places', 'gems'], nextCursor: '200' }, ['place', 'hidden_gem'])).toBe(true);
    expect(mediaMapGatewayPartial({ sources: [], nextCursor: null }, ['place'])).toBe(true);
  });
});
