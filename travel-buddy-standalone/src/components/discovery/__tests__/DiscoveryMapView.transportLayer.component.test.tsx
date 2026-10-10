/**
 * census-map M122 — DiscoveryMapView hands MapLibre the Transport base-map
 * style when, and only when, the Transport layer is on (lead ruling D-36a:
 * the layer is base-map styling). app/map/index.tsx resolves the layer
 * (`resolveLayers(...).transport.visible`) and passes it as `transportLayerOn`.
 *
 * Run: pnpm test:component  (matches --testPathPattern='\.component\.test\.')
 */
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const holder: { mapStyle?: unknown } = {};
  const Map = (props: { children?: React.ReactNode; mapStyle?: unknown }) => {
    holder.mapStyle = props.mapStyle;
    return <RN.View testID="map-container">{props.children}</RN.View>;
  };
  const Camera = (_props: unknown) => <RN.View testID="map-camera" />;
  const Marker = ({ children }: { children?: React.ReactNode }) => <RN.View testID="map-marker">{children}</RN.View>;
  return { Map, Camera, Marker, __holder: holder };
});
// NOTE: intentionally exhaustive — the real hook pulls Supabase and geolocation native modules.
jest.mock('../../../hooks/useMapTravelers', () => ({
  useMapTravelers: () => ({ travelers: [], loading: false }),
}));
// NOTE: intentionally exhaustive — native MapLibre marker internals.
jest.mock('../TravelerMapLayer', () => ({
  TravelerClusterMarkers: () => null,
}));
// NOTE: intentionally exhaustive — native components unsafe under jest.
jest.mock('../TravelerPreviewCard', () => ({
  TravelerPreviewCard: () => null,
}));
// NOTE: intentionally exhaustive — module-level cache mutates across tests.
jest.mock('../discoverMapFilterStorage', () => ({
  loadMapFilter: jest.fn().mockResolvedValue('all'),
  saveMapFilter: jest.fn(),
  removeMapFilter: jest.fn(),
  getCachedFilter: jest.fn().mockReturnValue(null),
  FILTER_STORAGE_KEY: 'discovery_map_filter',
}));

import { DiscoveryMapView } from '../DiscoveryMapView';
import { PORTAVA_DARK_MAP_STYLE, TRANSPORT_STYLE_LAYER_IDS } from '../../../constants/mapStyle.ts';

const noop = () => {};

async function styleFor(transportLayerOn: boolean | undefined) {
  await render(
    <DiscoveryMapView
      places={[]}
      onSelectPlace={noop}
      fallbackLat={14.5995}
      fallbackLng={120.9842}
      fallbackZoom={11}
      transportLayerOn={transportLayerOn}
    />,
  );
  const { __holder } = jest.requireMock('@maplibre/maplibre-react-native') as { __holder: { mapStyle?: any } };
  return __holder.mapStyle;
}

describe('DiscoveryMapView — the Transport layer restyles the base map', () => {
  it('off or absent: the base map exactly as before', async () => {
    expect(await styleFor(undefined)).toBe(PORTAVA_DARK_MAP_STYLE);
    expect(await styleFor(false)).toBe(PORTAVA_DARK_MAP_STYLE);
  });

  it('on: the same base map with the transit lines and stations drawn', async () => {
    const style = await styleFor(true);
    const ids = (style.layers as Array<{ id: string }>).map((l) => l.id);
    for (const id of TRANSPORT_STYLE_LAYER_IDS) expect(ids).toContain(id);
    expect(style.sources).toBe(PORTAVA_DARK_MAP_STYLE.sources);
  });
});
