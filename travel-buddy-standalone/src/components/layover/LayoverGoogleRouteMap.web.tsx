import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { googleMapContent, type LayoverGoogleMapProps } from '../../lib/layoverGoogleMap.ts';
import { color, space, type as t } from '../../theme/tokens.ts';
type GoogleApi = { maps: {
  Map: new (host: HTMLElement, options: Record<string, unknown>) => { fitBounds(b: unknown): void };
  Data: new (options: Record<string, unknown>) => { addGeoJson(v: unknown): void; setStyle(v: unknown): void; setMap(v: unknown): void };
  LatLngBounds: new () => { extend(v: { lat: number; lng: number }): void };
} };
let loading: Promise<GoogleApi> | null = null;
function googleMaps(key: string): Promise<GoogleApi> {
  const existing = (window as unknown as { google?: GoogleApi }).google;
  if (existing?.maps) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise<GoogleApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=quarterly`;
    script.async = true;
    script.onload = () => { const api = (window as unknown as { google?: GoogleApi }).google; api?.maps ? resolve(api) : reject(new Error('google_maps_unavailable')); };
    script.onerror = () => { script.remove(); reject(new Error('google_maps_load_failed')); };
    document.head.appendChild(script);
  }).catch(err => { loading = null; throw err; });
  return loading;
}
export function LayoverGoogleRouteMap(props: LayoverGoogleMapProps) {
  const content = googleMapContent(props), host = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(false);
  const key = process.env.EXPO_PUBLIC_GOOGLE_MAPS_WEB_API_KEY?.trim();
  const hasContent = !!content && (!!content.lines.length || !!content.coverage);
  const contentKey = JSON.stringify(content);
  useEffect(() => {
    if (!key || !hasContent || !host.current || props.airport.lat === null || props.airport.lng === null) return;
    let cancelled = false, layer: InstanceType<GoogleApi['maps']['Data']> | null = null;
    setError(false);
    googleMaps(key).then(api => {
      if (cancelled || !host.current || !content) return;
      const centre = { lat: props.airport.lat!, lng: props.airport.lng! };
      const map = new api.maps.Map(host.current, { center: centre, zoom: 12, streetViewControl: false, mapTypeControl: false, fullscreenControl: true });
      layer = new api.maps.Data({ map });
      const features: Array<Record<string, unknown>> = [{ type: 'Feature', properties: { kind: 'airport', title: `${props.airport.iataCode} airport` }, geometry: { type: 'Point', coordinates: [centre.lng, centre.lat] } }];
      for (const line of content.lines) features.push({ type: 'Feature', properties: { kind: line.direction, title: line.label }, geometry: line.value.geometry });
      if (content.coverage) features.push({ type: 'Feature', properties: { kind: 'coverage' }, geometry: content.coverage.geometry });
      layer.addGeoJson({ type: 'FeatureCollection', features });
      layer.setStyle((feature: { getProperty(k: string): unknown }) => ({ strokeColor: feature.getProperty('kind') === 'return' ? color.signal : color.deep, strokeWeight: 4, fillColor: color.success, fillOpacity: 0.15, title: feature.getProperty('title') }));
      const bounds = new api.maps.LatLngBounds(); bounds.extend(centre);
      for (const line of content.lines) for (const p of line.value.geometry.coordinates) bounds.extend({ lat: p[1], lng: p[0] });
      for (const poly of content.coverage?.geometry.coordinates ?? []) for (const ring of poly) for (const p of ring) bounds.extend({ lat: p[1], lng: p[0] });
      map.fitBounds(bounds);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; layer?.setMap(null); };
  }, [key, hasContent, contentKey, props.airport.lat, props.airport.lng, props.airport.iataCode]);
  if (!hasContent) return <Text style={{ ...t.small, color: color.mute }}>Street route geometry is unavailable. Your return timetable remains below.</Text>;
  if (!key || error) return <Text testID="layover-google-map-unavailable" style={{ ...t.small, color: color.mute }}>Google route map is unavailable. Your return timetable remains below.</Text>;
  return <View style={{ gap: space.sm }} testID="layover-google-route-map">
    <Text style={{ ...t.bodyStrong, color: color.ink }}>{content?.title ? `Routes for ${content.title}` : 'Walking area'}</Text>
    {React.createElement('div', { ref: host, style: { height: 260, width: '100%' }, 'aria-label': 'Google Maps route and airport return map' })}
    <Text style={{ ...t.small, color: color.mute }}>Google Maps · orange line returns to the airport. {content?.planRoute ? 'Blue lines follow the reviewed stop order.' : content?.multiStop ? 'Between-stop navigation is not shown.' : 'Blue line is the outward route.'}</Text>
    {content?.coverage ? <Text style={{ ...t.small, color: color.mute }}>Walking network estimate with {content.coverage.dwellMinutes} min for a visit. A place still needs its own available recommendation.</Text> : null}
  </View>;
}
