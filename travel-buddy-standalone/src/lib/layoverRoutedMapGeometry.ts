import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { circlePolygon } from '../features/map/render/collision.ts';
import { routedMapState, type RoutedMapData } from './layoverRoutedMap.ts';

/** Geographic projection only: no band is inferred and the sampled outline never becomes an interior fill. */
export function routedMapFeatures(data: RoutedMapData | null | undefined, currentSnapshotId: string | null | undefined, nowMs: number, budgetActive: boolean): FeatureCollection<Point | LineString> | null {
  const state = routedMapState(data, currentSnapshotId, nowMs);
  if (!data?.envelope || budgetActive || (state !== 'current' && state !== 'stale')) return null;
  const envelope = data.envelope;
  const features: Array<Feature<Point | LineString>> = [];
  const props = { snapshotId: data.snapshotId, stale: state === 'stale' };
  if (envelope.polygon.length >= 2) {
    const coordinates = envelope.polygon.map(p => [p.lng, p.lat]);
    if (coordinates.length > 2) coordinates.push([...coordinates[0]!]);
    features.push({ type: 'Feature', id: 'layover-sampled-outline', properties: { ...props, kind: 'outline', interiorCertified: false }, geometry: { type: 'LineString', coordinates } });
  }
  if (envelope.outerBound) features.push({ type: 'Feature', id: 'layover-outer-bound', properties: { ...props, kind: 'outer-bound', basis: envelope.outerBound.basis },
    geometry: { type: 'LineString', coordinates: circlePolygon(envelope.centre.lat, envelope.centre.lng, envelope.outerBound.radiusMetres).coordinates[0]! } });
  for (const item of [...envelope.members, ...envelope.excluded]) features.push({ type: 'Feature', id: item.key,
    properties: { ...props, kind: 'point', band: item.band, displayBand: state === 'stale' ? 'STALE' : item.band },
    geometry: { type: 'Point', coordinates: [item.point.lng, item.point.lat] } });
  return { type: 'FeatureCollection', features };
}
