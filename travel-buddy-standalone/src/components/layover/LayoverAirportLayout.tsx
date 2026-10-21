import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DiscoveryMapView } from '../discovery/DiscoveryMapView';
import { airportTopologyOf, airportTopologyCurrent, type AirportMapFeature } from '../../lib/layoverAirportGeometry.ts';
import { color, space, type as t } from '../../theme/tokens.ts';
const sdk: typeof import('@maplibre/maplibre-react-native') | null = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return null; } })();

export function LayoverAirportLayout({ geometry, nowMs, offline = false }: { geometry: unknown; nowMs: number; offline?: boolean }) {
  const value = useMemo(() => airportTopologyOf(geometry), [geometry]);
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<AirportMapFeature | null>(null);
  const current = airportTopologyCurrent(value, nowMs);
  const first = value?.features.find(f => f.geometry.type === 'Point');
  if (!value?.available) return <Text style={{ ...t.small, color: color.mute }}>Airport layout coordinates have not been published.</Text>;
  const chosen = selected && value.features.find(f => f.id === selected.id);
  return <View style={{ gap: space.sm }} testID="layover-airport-layout">
    <Pressable onPress={() => setOpen(v => !v)} accessibilityRole="button" accessibilityLabel="Airport layout" accessibilityState={{ expanded: open }}><Text style={{ ...t.bodyStrong, color: color.ink }}>Airport layout {open ? '−' : '+'}</Text></Pressable>
    {!current ? <Text style={{ ...t.small, color: color.warn }}>The saved airport layout has expired. Refresh before using its paths.</Text> : null}
    {open ? <>
      <Text style={{ ...t.small, color: color.mute }}>{offline ? 'Saved published layout' : 'Published airport layout'} · version {value.topologyVersion}. Walking times are source estimates, not live checkpoint waits.</Text>
      {current && first?.geometry.type === 'Point' ? <View style={{ height: 220 }}><DiscoveryMapView places={[]} onSelectPlace={() => undefined} fallbackLat={first.geometry.coordinates[1]} fallbackLng={first.geometry.coordinates[0]} fallbackZoom={15}>
        <AirportLayoutLayer features={value.features} onSelect={setSelected} />
      </DiscoveryMapView></View> : null}
      {value.features.map(f => <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={f.label} onPress={() => setSelected(f)}><Text style={{ ...t.small, color: current ? color.ink : color.mute }}>{f.label}{f.minutes === null ? '' : ` · ${f.minutes} min`}</Text></Pressable>)}
      {chosen ? <Text testID="layover-airport-layout-selection" style={{ ...t.small, color: color.ink }}>{chosen.label} · {chosen.kind.replace('_', ' ')}{chosen.minutes === null ? ' · no walking time stated' : ` · ${chosen.minutes} min from the published source`}</Text> : null}
    </> : null}
  </View>;
}
function AirportLayoutLayer({ features, onSelect }: { features: AirportMapFeature[]; onSelect: (f: AirportMapFeature) => void }) {
  if (!sdk?.GeoJSONSource || !sdk.Layer) return null;
  const { GeoJSONSource, Layer } = sdk;
  const collection: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: features.map(f => ({ type: 'Feature', id: f.id, properties: { id: f.id, label: f.label, kind: f.kind }, geometry: f.geometry })) };
  return <GeoJSONSource id="layover-airport-topology" data={collection} onPress={event => { const id = event.nativeEvent.features[0]?.properties?.id; const feature = features.find(f => f.id === id); if (feature) onSelect(feature); }}>
    <Layer id="layover-airport-paths" type="line" filter={['==', ['geometry-type'], 'LineString']} paint={{ 'line-color': color.deep, 'line-width': 3 }} />
    <Layer id="layover-airport-points" type="circle" filter={['==', ['geometry-type'], 'Point']} paint={{ 'circle-color': color.ink, 'circle-radius': 6, 'circle-stroke-color': color.paper, 'circle-stroke-width': 2 }} />
    <Layer id="layover-airport-labels" type="symbol" filter={['==', ['geometry-type'], 'Point']} layout={{ 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' }} paint={{ 'text-color': color.ink, 'text-halo-color': color.paper, 'text-halo-width': 2 }} />
  </GeoJSONSource>;
}
