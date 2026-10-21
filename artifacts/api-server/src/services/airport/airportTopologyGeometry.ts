import { haversineMeters, type GeoPoint } from '../../domain/trips/contracts/TravelTimeProvider.js';
import type { AirportProfile } from './AirportProfileService.js';

export interface AirportMapFeature {
  id: string; kind: 'terminal' | 'gate' | 'checkpoint' | 'walking_link'; label: string;
  terminalId: string | null; minutes: number | null;
  geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] };
}
export interface AirportTopologyGeometry {
  available: boolean; reason: 'not_curated' | 'topology_expired' | 'geometry_absent' | 'geometry_invalid' | null;
  factId: string | null; topologyVersion: number; expiresAt: string | null;
  source: 'published_airport_topology'; displayPolicy: 'independent_map'; cachePolicy: 'until_expiry'; features: AirportMapFeature[];
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const rows = (v: unknown): Obj[] => Array.isArray(v) ? v.filter(obj) : [];
export function topologyGeoPoint(v: unknown): GeoPoint | null {
  if (!obj(v) || Object.keys(v).some(k => k !== 'lat' && k !== 'lng') || typeof v.lat !== 'number' || typeof v.lng !== 'number' ||
    !Number.isFinite(v.lat) || !Number.isFinite(v.lng) || Math.abs(v.lat) > 90 || Math.abs(v.lng) > 180) return null;
  return { lat: v.lat, lng: v.lng };
}
export function topologyHasGeometry(value: unknown): boolean {
  return obj(value) && ['terminals', 'gates', 'checkpoints', 'walkingLinks'].some(k => rows(value[k]).some(r => r.point !== undefined || r.path !== undefined));
}
/** Geometry is optional, but every supplied point must be sourced, nearby and internally coherent. */
export function topologyGeometryIssues(value: unknown, airportPoint: GeoPoint | null, sourceKind: string): Array<{ path: string; problem: string }> {
  if (!topologyHasGeometry(value)) return [];
  const issues: Array<{ path: string; problem: string }> = [];
  const fail = (path: string, problem: string) => issues.push({ path, problem });
  if (!['official_airport', 'official_operator', 'official_government', 'curator_survey'].includes(sourceKind)) fail('source.kind', 'geometry needs an official source or an actual curator survey; judgment is not a coordinate source');
  if (!airportPoint) fail('value.geometry', 'the airport has no valid coordinate to validate geometry against');
  const terminals = new Map<string, GeoPoint>();
  const pointAt = (v: unknown, path: string): GeoPoint | null => {
    const point = topologyGeoPoint(v);
    if (!point) fail(path, 'must be a finite WGS84 {lat,lng} point');
    else if (airportPoint && haversineMeters(point, airportPoint) > 25_000) fail(path, 'is more than 25 km from this airport');
    return point;
  };
  for (const key of ['terminals', 'gates', 'checkpoints'] as const) rows((value as Obj)[key]).forEach((r, i) => {
    if (r.point === undefined) return;
    const p = pointAt(r.point, `value.${key}[${i}].point`);
    if (key === 'terminals' && p && typeof r.id === 'string') terminals.set(r.id, p);
  });
  rows((value as Obj).walkingLinks).forEach((r, i) => {
    if (r.path === undefined) return;
    const path = `value.walkingLinks[${i}].path`;
    if (!Array.isArray(r.path) || r.path.length < 2 || r.path.length > 500) { fail(path, 'must contain 2..500 sourced points'); return; }
    const points = r.path.map((p, j) => pointAt(p, `${path}[${j}]`));
    const from = terminals.get(String(r.fromTerminalId)), to = terminals.get(String(r.toTerminalId));
    if (!from || !to) fail(path, 'both terminal endpoints need sourced points');
    else if (points[0] && points.at(-1) && (haversineMeters(from, points[0]) > 500 || haversineMeters(to, points.at(-1)!) > 500)) fail(path, 'path endpoints must be within 500 m of their declared terminals');
  });
  return issues;
}

/** The published fact is the source. Expired/unvalidated geometry never becomes a fresh map layer. */
export function airportTopologyGeometry(airport: Pick<AirportProfile, 'lat' | 'lng' | 'terminalInfo' | 'curation'>, nowMs: number): AirportTopologyGeometry {
  const ref = airport.curation?.topology;
  const base: AirportTopologyGeometry = { available: false, reason: 'not_curated', factId: ref?.factId ?? null,
    topologyVersion: airport.curation?.topologyVersion ?? 0, expiresAt: ref?.expiresAt ?? null,
    source: 'published_airport_topology', displayPolicy: 'independent_map', cachePolicy: 'until_expiry', features: [] };
  if (!ref) return base;
  if (!Number.isFinite(Date.parse(ref.expiresAt)) || Date.parse(ref.expiresAt) <= nowMs) return { ...base, reason: 'topology_expired' };
  const v = airport.terminalInfo;
  if (!topologyHasGeometry(v)) return { ...base, reason: 'geometry_absent' };
  if (topologyGeometryIssues(v, topologyGeoPoint({ lat: airport.lat, lng: airport.lng }), 'official_airport').length) return { ...base, reason: 'geometry_invalid' };
  const features: AirportMapFeature[] = [];
  for (const [key, kind] of [['terminals', 'terminal'], ['gates', 'gate'], ['checkpoints', 'checkpoint']] as const) rows(v?.[key]).forEach((r, i) => {
    const p = topologyGeoPoint(r.point); if (!p) return;
    features.push({ id: `${kind}:${String(r.terminalId ?? '')}:${String(r.id ?? r.label ?? i)}`, kind, label: String(r.name ?? r.label ?? r.kind ?? r.id ?? kind),
      terminalId: kind === 'terminal' ? String(r.id) : typeof r.terminalId === 'string' ? r.terminalId : null, minutes: null,
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
  });
  rows(v?.walkingLinks).forEach((r, i) => {
    if (!Array.isArray(r.path)) return;
    const points = r.path.map(topologyGeoPoint); if (points.some(p => !p)) return;
    features.push({ id: `link:${i}`, kind: 'walking_link', label: `${r.fromTerminalId} → ${r.toTerminalId} (${r.mode})`, terminalId: null,
      minutes: typeof r.minutes === 'number' ? r.minutes : null, geometry: { type: 'LineString', coordinates: points.map(p => [p!.lng, p!.lat]) } });
  });
  return { ...base, available: features.length > 0, reason: features.length ? null : 'geometry_absent', features };
}
