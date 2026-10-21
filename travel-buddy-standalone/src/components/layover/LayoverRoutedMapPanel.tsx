import React, { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';
import { color, space, type as t } from '../../theme/tokens.ts';
import { projectRoutedPoint, routedMapState, routingTermsExist, type RoutedMapData, type RoutedReturnContract } from '../../lib/layoverRoutedMap.ts';
import type { AbortReturnRoute } from '../../services/layover.ts';
import { fmtClock } from './layoverFormat.ts';

const SIZE = 240;
export function LayoverRoutedMapPanel({ data, currentSnapshotId, selectedRecommendationIds = [], timezone, nowMs, offline = false, budgetActive = false, abortRoute }: {
  data: RoutedMapData | null; currentSnapshotId?: string | null; selectedRecommendationIds?: readonly string[];
  timezone: string; nowMs: number; offline?: boolean; budgetActive?: boolean; abortRoute?: AbortReturnRoute | null;
}) {
  const state = routedMapState(data, currentSnapshotId, nowMs);
  const envelope = data?.envelope;
  // Hold the geographic scale for this airport. Fresh server answers replace the outline at the same scale.
  const scaleRef = useRef<{ centre: string; value: number } | null>(null);
  const centreKey = envelope ? `${envelope.centre.lat},${envelope.centre.lng}` : '';
  if (envelope && scaleRef.current?.centre !== centreKey) scaleRef.current = { centre: centreKey, value: Math.max(20, (envelope.outerBound?.radiusMetres ?? Math.max(1000, ...envelope.members.map(m => m.distanceMetres))) / 110) };
  const scale = scaleRef.current?.value ?? 100;
  const draw = !!envelope && envelope.displayPolicy !== 'google_map_only' && (state === 'current' || state === 'stale') && !!data?.snapshotId && !budgetActive;
  const projection = (p: { lat: number; lng: number }) => projectRoutedPoint(p, envelope!.centre, scale, SIZE);
  const outline = draw ? [...envelope.polygon, ...(envelope.polygon.length > 2 ? [envelope.polygon[0]!] : [])].map(p => { const at = projection(p); return `${at.x},${at.y}`; }).join(' ') : '';
  const selected = [...selectedRecommendationIds].reverse().map(id => data?.cards.find(c => c.id === id)).find(Boolean);
  const route = !budgetActive && state !== 'superseded' && data?.snapshotId && selected && routingTermsExist(selected.routing) ? selected.routing.returnContract : null;
  const missingSectors = envelope?.sectors.filter(s => !s.measured).length ?? 0;
  return <View style={styles.box} testID="layover-routed-map-panel">
    <Text style={styles.heading}>Measured route area</Text>{envelope?.displayPolicy === 'google_map_only' ? <Text style={styles.note}>Google Maps route geometry appears on the Google map above when available.</Text> : null}
    {offline ? <Text style={styles.note}>OFFLINE — saved routes and deadlines; conditions may have changed.</Text> : null}
    {state === 'stale' ? <Text style={styles.warning}>STALE — these routes have expired. Refresh before relying on their timing.</Text> : null}
    {state === 'superseded' ? <Text style={styles.warning}>The plan has changed. Refresh to see routes for the current plan.</Text> : null}
    {budgetActive ? <Text style={styles.note}>The routed area has not been measured for this budget. The stop bands below are the server’s simulation.</Text>
      : state === 'unavailable' ? <Text style={styles.note}>The routed area could not be measured right now.</Text> : null}
    {draw ? <>
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} accessibilityLabel="Routed points around the airport; connected outline does not certify its interior">
        {envelope.outerBound ? <Circle cx={SIZE / 2} cy={SIZE / 2} r={envelope.outerBound.radiusMetres / scale} stroke={color.faint} strokeDasharray="2 5" fill="none" testID="layover-routed-outer-bound" /> : null}
        <Line x1={SIZE / 2} y1={6} x2={SIZE / 2} y2={SIZE - 6} stroke={color.haze} />
        <Line x1={6} y1={SIZE / 2} x2={SIZE - 6} y2={SIZE / 2} stroke={color.haze} />
        <Polyline points={outline} stroke={state === 'stale' ? color.mute : color.deep} strokeWidth={2} strokeDasharray="5 4" fill="none" testID="layover-routed-outline" />
        <Circle cx={SIZE / 2} cy={SIZE / 2} r={5} fill={color.ink} />
        {envelope.members.map(m => { const at = projection(m.point); return <Circle key={m.key} cx={at.x} cy={at.y} r={5} fill={state === 'stale' ? color.mute : m.band === 'SAFE' ? color.success : color.warn} testID={`layover-routed-point-${m.band}-${m.key}`} />; })}
        {envelope.excluded.map(m => { const at = projection(m.point); return <Circle key={m.key} cx={at.x} cy={at.y} r={5} stroke={m.band === 'BLOCKED' ? color.warn : color.mute} strokeWidth={2} fill="none" testID={`layover-routed-point-${m.band}-${m.key}`} />; })}
      </Svg>
      <Text style={styles.note}>North is up · airport at centre · {Math.round(scale * 10)} m per 10 px.</Text>
      <Text style={styles.note}>SAFE / TIGHT apply only to the measured points. Polygon interior has not been certified. {missingSectors} sectors have no measured point.</Text>
      {envelope.outerBound ? <Text style={styles.note}>Dotted circle: straight-line lower-bound exclusion limit. Being inside it does not establish a route.</Text> : null}
      {envelope.excluded.map(m => <Text key={m.key} style={styles.warning} testID={`layover-routed-exclusion-${m.key}`}>{m.band === 'BLOCKED' ? 'Unavailable' : 'Unmeasured'} — {m.reason ?? 'The route could not be measured right now.'}</Text>)}
    </> : null}
    {abortRoute ? <RoutedReturnItinerary contract={{ hardReturnBy: abortRoute.hardReturnBy, leaveBy: abortRoute.leaveBy, route: abortRoute }} timezone={timezone} expiresAt={abortRoute.expiresAt} nowMs={nowMs} late={!abortRoute.canMeetDeadline} />
      : route ? <RoutedReturnItinerary contract={route} timezone={timezone} expiresAt={selected!.routing.expiresAt} nowMs={nowMs} />
        : <Text style={styles.note} testID="layover-routed-return-unavailable">Return route could not be measured right now{envelope && state !== 'superseded' ? `. Be at the airport by ${fmtClock(envelope.hardReturnBy, timezone)}` : ''}.</Text>}
  </View>;
}

export function RoutedReturnItinerary({ contract, timezone, expiresAt, nowMs, late = false }: {
  contract: { hardReturnBy: string; leaveBy: string; route: Pick<RoutedReturnContract['route'], 'mode' | 'minutes' | 'conservativeMinutes' | 'departAt' | 'conveyances'> }; timezone: string; expiresAt: string | null; nowMs: number; late?: boolean;
}) {
  const route = contract.route;
  const stale = !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= nowMs;
  return <View style={styles.returnBox} testID="layover-routed-return-itinerary">
    <Text style={styles.heading}>Return to the airport</Text>
    <Text style={styles.note}>Allow {route.conservativeMinutes} min for the return ({route.minutes} min measured).</Text>
    <Text style={styles.note}>Leave by {fmtClock(contract.leaveBy, timezone)} · airport by {fmtClock(contract.hardReturnBy, timezone)}.</Text>
    <Text style={styles.note}>Route forecast for {fmtClock(route.departAt, timezone)}: {route.conveyances.map(l => `${l.mode} ${l.minutes} min`).join(' → ') || `${route.mode} ${route.minutes} min`} → airport.</Text>
    {stale ? <Text style={styles.warning}>Return timing is stale; this is the last saved route.</Text> : null}
    {late ? <Text style={styles.warning}>This route does not meet the return deadline.</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  box: { gap: space.sm, paddingVertical: space.sm }, heading: { ...t.small, fontWeight: '700', color: color.ink },
  note: { ...t.small, color: color.mute }, warning: { ...t.small, color: color.warn },
  returnBox: { borderTopWidth: 1, borderTopColor: color.haze, paddingTop: space.sm, gap: 4 },
});
