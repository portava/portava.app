import React, { useMemo } from 'react';
import { routedMapFeatures } from '../../lib/layoverRoutedMapGeometry.ts';
import type { RoutedMapData } from '../../lib/layoverRoutedMap.ts';
import { color } from '../../theme/tokens.ts';
// Same guarded SDK load as DiscoveryMapView; unavailable native SDK leaves the labelled diagram available.
const sdk: typeof import('@maplibre/maplibre-react-native') | null = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return null; } })();

export function LayoverRoutedMapLayer({ data, currentSnapshotId, nowMs, budgetActive = false }: {
  data: RoutedMapData | null | undefined; currentSnapshotId?: string | null; nowMs: number; budgetActive?: boolean;
}) {
  const features = useMemo(() => routedMapFeatures(data, currentSnapshotId, nowMs, budgetActive), [data, currentSnapshotId, nowMs, budgetActive]);
  if (data?.envelope?.displayPolicy === 'google_map_only' || !features || !sdk?.GeoJSONSource || !sdk.Layer) return null;
  const { GeoJSONSource, Layer } = sdk;
  return <GeoJSONSource id="layover-routed-source" data={features}>
    <Layer id="layover-routed-boundaries" type="line" filter={['==', ['geometry-type'], 'LineString']} paint={{
      'line-color': ['case', ['==', ['get', 'stale'], true], color.mute, ['==', ['get', 'kind'], 'outer-bound'], color.faint, color.deep],
      'line-width': 2, 'line-dasharray': [3, 3],
    }} />
    <Layer id="layover-routed-bands" type="circle" filter={['==', ['geometry-type'], 'Point']} paint={{
      'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': color.paper,
      'circle-color': ['match', ['get', 'displayBand'], 'SAFE', color.success, 'TIGHT', color.warn, 'BLOCKED', color.warn, color.mute],
    }} />
  </GeoJSONSource>;
}
