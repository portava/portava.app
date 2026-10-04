/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW14): the Media Map says a map it could only read for part
 * of the area — near the antimeridian or a pole, where `bboxFromCenter` clamps the viewport box the gateway gets.
 *
 *   MV1  the centre ~5 km from the antimeridian, a whole answer → the partial notice
 *   MV2  the centre at 85°N → the same
 *   MV0  CONTROL: Da Nang, a whole answer → no partial notice
 *   VB1  viewportBoxClamped is true exactly when the real bboxFromCenter cut the box (a pin against drift)
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
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

describe('census-discovery §116 (SW14): the Media Map near the antimeridian or a pole', () => {
  it('MV0 CONTROL: Da Nang, a whole answer → no partial notice', async () => {
    mockFetchMapProjection.mockResolvedValue(whole());
    await render(<MediaMapScreen city="Da Nang" center={CENTER} />);
    await waitFor(() => expect(screen.getByTestId('media-map-canvas')).toBeTruthy());
    expect(screen.queryByTestId('media-map-partial')).toBeNull();
  });
  it('MV1 the centre ~5 km from the antimeridian → the partial notice', async () => {
    mockFetchMapProjection.mockResolvedValue(whole());
    await render(<MediaMapScreen city="Taveuni" center={{ lat: -16.82, lng: 179.95 }} />);
    await waitFor(() => expect(screen.getByTestId('media-map-partial')).toBeTruthy());
    expect(screen.getByText(PARTIAL)).toBeTruthy();
  });
  it('MV2 the centre at 85°N → the partial notice', async () => {
    mockFetchMapProjection.mockResolvedValue(whole());
    await render(<MediaMapScreen city="Svalbard" center={{ lat: 85, lng: 15 }} />);
    await waitFor(() => expect(screen.getByTestId('media-map-partial')).toBeTruthy());
  });
  it('VB1 viewportBoxClamped is true exactly when the real bboxFromCenter cut the box', () => {
    const { bboxFromCenter } = jest.requireActual('../../../services/mapProjection.ts');
    const { viewportBoxClamped } = jest.requireActual('../../map/layers/viewportBoxClamped.ts');
    let seenClamped = 0; let seenWhole = 0;
    for (const lat of [-89.95, -85, -78.4, -78.6, -16.82, 0, 16.05, 60, 78.4, 78.6, 85, 89.95]) {
      for (const lng of [-179.95, -179.5, -120, 0, 108.2, 179.5, 179.95]) {
        for (const r of [1, 10, 40, 120, 400]) {
          const latD = r / 111; const lngD = r / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
          const b = bboxFromCenter(lat, lng, r);
          const cut = b.west !== lng - lngD || b.east !== lng + lngD || b.south !== lat - latD || b.north !== lat + latD || Math.cos((lat * Math.PI) / 180) < 0.2;
          expect({ lat, lng, r, clamped: viewportBoxClamped(lat, lng, r) }).toEqual({ lat, lng, r, clamped: cut });
          if (cut) seenClamped += 1; else seenWhole += 1;
        }
      }
    }
    expect(seenClamped).toBeGreaterThan(50); expect(seenWhole).toBeGreaterThan(50);
  });
});
