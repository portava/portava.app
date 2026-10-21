import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View, UIManager } from 'react-native';
import Constants from 'expo-constants';
import type MapViewType from 'react-native-maps';
import { googleMapContent, type LayoverGoogleMapProps } from '../../lib/layoverGoogleMap.ts';
import { color, space, type as t } from '../../theme/tokens.ts';
const maps: typeof import('react-native-maps') | null = (() => { try { return require('react-native-maps'); } catch { return null; } })();
const at = (p: [number, number]) => ({ latitude: p[1], longitude: p[0] });
function nativeMapAvailable(): boolean { try { return !!UIManager.getViewManagerConfig(Platform.OS === 'ios' ? 'AIRGoogleMap' : 'AIRMap'); } catch { return false; } }

export function LayoverGoogleRouteMap(props: LayoverGoogleMapProps) {
  const content = googleMapContent(props), map = useRef<MapViewType | null>(null);
  const [ready, setReady] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const configured = Constants.expoConfig?.extra?.layoverGoogleMap?.[Platform.OS] === true;
  const coordinateKey = JSON.stringify(content?.lines.map(l => l.value.geometry.coordinates));
  useEffect(() => {
    if (!ready || !content || props.airport.lat === null || props.airport.lng === null) return;
    const coordinates = [{ latitude: props.airport.lat, longitude: props.airport.lng }, ...content.lines.flatMap(l => l.value.geometry.coordinates.map(at)), ...(content.coverage?.geometry.coordinates.flatMap(p => p.flatMap(r => r.map(at))) ?? [])];
    if (coordinates.length > 1) map.current?.fitToCoordinates(coordinates, { edgePadding: { top: 35, right: 35, bottom: 45, left: 35 }, animated: false });
  }, [ready, coordinateKey, content?.coverage?.expiresAt, props.airport.lat, props.airport.lng]);
  if (!content || (!content.lines.length && !content.coverage)) return <Text style={{ ...t.small, color: color.mute }}>Street route geometry is unavailable. Your return timetable remains below.</Text>;
  if (!configured || !nativeMapAvailable() || !maps?.default || props.airport.lat === null || props.airport.lng === null) return <Text testID="layover-google-map-unavailable" style={{ ...t.small, color: color.mute }}>Google route map is unavailable in this app build. Your return timetable remains below.</Text>;
  const { default: MapView, Marker, Polyline, Polygon, PROVIDER_GOOGLE } = maps;
  return <View testID="layover-google-route-map" style={{ gap: space.sm }}>
    <Text style={{ ...t.bodyStrong, color: color.ink }}>{content.title ? `Routes for ${content.title}` : 'Walking area'}</Text>
    <View style={{ height: 260 }}><MapView ref={map} provider={PROVIDER_GOOGLE} style={{ flex: 1 }} initialRegion={{ latitude: props.airport.lat, longitude: props.airport.lng, latitudeDelta: 0.08, longitudeDelta: 0.08 }} onMapReady={() => setReady(true)} toolbarEnabled={false}>
      {content.coverage?.geometry.coordinates.map((polygon, i) => <Polygon key={`coverage:${i}`} coordinates={polygon[0]!.map(at)} holes={polygon.slice(1).map(ring => ring.map(at))} fillColor="rgba(46,125,91,0.15)" strokeColor={color.success} strokeWidth={1} tappable onPress={() => setSelected(`Walking network area with ${content.coverage!.dwellMinutes} min reserved for a visit.`)} />)}
      {content.lines.map(line => <Polyline key={line.id} coordinates={line.value.geometry.coordinates.map(at)} strokeColor={line.direction === 'return' ? color.signal : color.deep} strokeWidth={4} tappable onPress={() => setSelected(line.label)} />)}
      <Marker coordinate={{ latitude: props.airport.lat, longitude: props.airport.lng }} title={`${props.airport.iataCode} airport`} description="Return destination" />
    </MapView></View>
    <Text style={{ ...t.small, color: color.mute }}>Google Maps · orange line returns to the airport. {content.planRoute ? 'Blue lines follow the reviewed stop order.' : content.multiStop ? 'Between-stop navigation is not shown.' : 'Blue line is the outward route.'}</Text>
    {content.coverage ? <Text style={{ ...t.small, color: color.mute }}>Walking network estimate only · {content.coverage.dwellMinutes} min visit · return time includes {content.coverage.uncertaintyMinutes} min uncertainty. A place still needs its own available recommendation.</Text> : null}
    {selected ? <Text style={{ ...t.small, color: color.ink }}>{selected}</Text> : null}
  </View>;
}
