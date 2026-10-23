/** Server answers for the routed map. The only arithmetic here projects coordinates onto a drawing. */
export interface RoutedPoint { lat: number; lng: number }
export type RoutedBand = 'SAFE' | 'TIGHT' | 'BLOCKED' | 'UNCERTIFIED';
export interface RoutedReturnContract {
  hardReturnBy: string; leaveBy: string;
  route: { mode: string; departAt: string; minutes: number; conservativeMinutes: number; forecast: boolean;
    independentRoutes: number; offeredRoutes: number; transferCount: number; interruptibility: string;
    conveyances: Array<{ mode: string; minutes: number; interruptibility: string; endsAt: string | null }> };
}
export interface RoutedCardContract { geometry?: { outbound: import('./layoverProviderGeometry.ts').ProviderRouteGeometry | null; returnLeg: import('./layoverProviderGeometry.ts').ProviderRouteGeometry | null };
  state: 'FEASIBLE' | 'INFEASIBLE' | 'UNMEASURED' | 'NOT_ROUTED'; band: RoutedBand; reason: string | null;
  absence: string | null; outboundMinutes: number | null; conservativeReturnMinutes: number | null;
  expiresAt: string | null; returnContract: RoutedReturnContract | null;
}
export interface RoutedSafeEnvelope { continuous?: ReturnType<typeof continuousCoverageOf>; displayPolicy?: 'google_map_only';
  centre: RoutedPoint; basis: 'routed_union'; certifiedInward: true; certifiedOutward: false; polygonInteriorCertified: false;
  outerBound: { radiusMetres: number; basis: 'straight_line_lower_bound' } | null;
  windowStartsAt: string; hardReturnBy: string; usableMinutes: number; dwellFloorMinutes: number; confidence: string;
  members: Array<{ key: string; point: RoutedPoint; band: 'SAFE' | 'TIGHT'; distanceMetres: number; bearingDeg: number }>;
  excluded: Array<{ key: string; point: RoutedPoint; band: RoutedBand; reason: string | null }>;
  sectors: Array<{ index: number; fromDeg: number; toDeg: number; reachMetres: number | null; vertexKey: string | null; measured: boolean }>;
  polygon: RoutedPoint[]; expiresAt: string | null;
}
export interface RoutedMapData {
  snapshotId: string | null; envelope: RoutedSafeEnvelope | null;
  cards: Array<{ id: string; title: string; routing: RoutedCardContract }>;
}
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const textOrNull = (v: unknown) => typeof v === 'string' ? v : null;
const nullableNumber = (v: unknown) => nonnegative(v) ? v : null;
const bands: readonly string[] = ['SAFE', 'TIGHT', 'BLOCKED', 'UNCERTIFIED'];
const point = (v: unknown): v is RoutedPoint => { const p = object(v); return !!p && finite(p.lat) && Math.abs(p.lat) <= 90 && finite(p.lng) && Math.abs(p.lng) <= 180; };
export const routedSnapshotOf = (v: unknown): string | null => typeof v === 'string' && /^snap:[0-9a-f]{32}$/.test(v) ? v : null;

export function routedCardOf(raw: unknown): RoutedCardContract | null {
  const r = object(raw);
  if (!r || !['FEASIBLE', 'INFEASIBLE', 'UNMEASURED', 'NOT_ROUTED'].includes(String(r.state)) || !bands.includes(String(r.band))) return null;
  let returnContract: RoutedReturnContract | null = null;
  const rc = object(r.returnContract), route = object(rc?.route);
  if (rc && route && instant(rc.hardReturnBy) && instant(rc.leaveBy) && instant(route.departAt) && typeof route.mode === 'string'
    && nonnegative(route.minutes) && nonnegative(route.conservativeMinutes) && route.conservativeMinutes >= route.minutes
    && typeof route.forecast === 'boolean' && nonnegative(route.independentRoutes) && nonnegative(route.offeredRoutes)
    && nonnegative(route.transferCount) && typeof route.interruptibility === 'string' && Array.isArray(route.conveyances)) {
    const legs = route.conveyances.map(object);
    if (legs.every(l => !!l && typeof l.mode === 'string' && nonnegative(l.minutes) && typeof l.interruptibility === 'string' && (l.endsAt === null || typeof l.endsAt === 'string'))) {
      returnContract = { hardReturnBy: rc.hardReturnBy, leaveBy: rc.leaveBy, route: {
        mode: route.mode, departAt: route.departAt, minutes: route.minutes, conservativeMinutes: route.conservativeMinutes,
        forecast: route.forecast, independentRoutes: route.independentRoutes, offeredRoutes: route.offeredRoutes, transferCount: route.transferCount,
        interruptibility: route.interruptibility, conveyances: legs.map(l => ({ mode: l!.mode as string, minutes: l!.minutes as number, interruptibility: l!.interruptibility as string, endsAt: l!.endsAt as string | null })) } };
    }
  }
  return { state: r.state as RoutedCardContract['state'], band: r.band as RoutedBand, reason: textOrNull(r.reason), absence: textOrNull(r.absence),
    outboundMinutes: nullableNumber(r.outboundMinutes), conservativeReturnMinutes: nullableNumber(r.conservativeReturnMinutes),
    expiresAt: instant(r.expiresAt) ? r.expiresAt : null, returnContract, geometry: { outbound: providerRouteGeometryOf(object(r.geometry)?.outbound), returnLeg: providerRouteGeometryOf(object(r.geometry)?.returnLeg) } };
}

export function routedEnvelopeOf(raw: unknown): RoutedSafeEnvelope | null {
  const r = object(raw);
  if (!r || r.basis !== 'routed_union' || r.certifiedInward !== true || r.certifiedOutward !== false || r.polygonInteriorCertified !== false
    || !point(r.centre) || !instant(r.windowStartsAt) || !instant(r.hardReturnBy) || !nonnegative(r.usableMinutes) || !nonnegative(r.dwellFloorMinutes)
    || !Array.isArray(r.members) || !Array.isArray(r.excluded) || !Array.isArray(r.sectors) || !Array.isArray(r.polygon) || !r.polygon.every(point)) return null;
  const members = r.members.map(object), excluded = r.excluded.map(object), sectors = r.sectors.map(object);
  if (!members.every(m => !!m && typeof m.key === 'string' && point(m.point) && (m.band === 'SAFE' || m.band === 'TIGHT') && nonnegative(m.distanceMetres) && finite(m.bearingDeg))
    || !excluded.every(m => !!m && typeof m.key === 'string' && point(m.point) && bands.includes(String(m.band)))
    || !sectors.every(s => !!s && nonnegative(s.index) && finite(s.fromDeg) && finite(s.toDeg) && typeof s.measured === 'boolean' && (s.reachMetres === null || nonnegative(s.reachMetres)))) return null;
  const bound = object(r.outerBound);
  return { centre: { ...r.centre }, basis: 'routed_union', certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
    outerBound: bound?.basis === 'straight_line_lower_bound' && nonnegative(bound.radiusMetres) ? { radiusMetres: bound.radiusMetres, basis: 'straight_line_lower_bound' } : null,
    windowStartsAt: r.windowStartsAt, hardReturnBy: r.hardReturnBy, usableMinutes: r.usableMinutes, dwellFloorMinutes: r.dwellFloorMinutes,
    confidence: String(r.confidence ?? 'INSUFFICIENT'), expiresAt: instant(r.expiresAt) ? r.expiresAt : null,
    members: members.map(m => ({ key: m!.key as string, point: { ...m!.point as RoutedPoint }, band: m!.band as 'SAFE' | 'TIGHT', distanceMetres: m!.distanceMetres as number, bearingDeg: m!.bearingDeg as number })),
    excluded: excluded.map(m => ({ key: m!.key as string, point: { ...m!.point as RoutedPoint }, band: m!.band as RoutedBand, reason: textOrNull(m!.reason) })),
    sectors: sectors.map(s => ({ index: s!.index as number, fromDeg: s!.fromDeg as number, toDeg: s!.toDeg as number, reachMetres: s!.reachMetres as number | null, vertexKey: textOrNull(s!.vertexKey), measured: s!.measured as boolean })),
    polygon: r.polygon.map(p => ({ ...p })), continuous: continuousCoverageOf(r.continuous), ...(r.displayPolicy === 'google_map_only' ? { displayPolicy: 'google_map_only' as const } : {}) };
}

export function buildRoutedMapData(snapshotId: unknown, envelope: unknown, recs: readonly { id?: string; title: string; routing?: unknown }[]): RoutedMapData {
  return { snapshotId: routedSnapshotOf(snapshotId), envelope: routedEnvelopeOf(envelope), cards: recs.flatMap(r => {
    const routing = routedCardOf(r.routing); return r.id && routing ? [{ id: r.id, title: r.title, routing }] : [];
  }) };
}
export function routedMapDataOf(raw: unknown): RoutedMapData | null {
  const r = object(raw);
  if (!r || !Array.isArray(r.cards)) return null;
  return buildRoutedMapData(r.snapshotId, r.envelope, r.cards.filter(v => object(v) && typeof v.id === 'string' && typeof v.title === 'string'));
}
export function routingTermsExist(r: RoutedCardContract | null | undefined): boolean {
  return !!r && (r.state === 'FEASIBLE' || r.state === 'INFEASIBLE' || (r.state === 'UNMEASURED' && r.absence === 'experience_unstated'))
    && nonnegative(r.outboundMinutes) && nonnegative(r.conservativeReturnMinutes);
}
export function routedMapExpiry(data: RoutedMapData | null | undefined): number | null {
  if (!data) return null;
  const expiries = [data.envelope?.expiresAt, data.envelope?.continuous?.state === 'available' ? data.envelope.continuous.expiresAt : null, ...data.cards.map(c => c.routing.expiresAt)].filter(instant).map(Date.parse);
  return expiries.length ? Math.min(...expiries) : null;
}
export function routedMapState(data: RoutedMapData | null | undefined, currentSnapshotId: string | null | undefined, nowMs: number): 'current' | 'stale' | 'superseded' | 'unavailable' {
  if (!data?.snapshotId) return 'unavailable';
  if (currentSnapshotId && currentSnapshotId !== data.snapshotId) return 'superseded';
  const expiry = routedMapExpiry(data);
  if (data.cards.some(c => c.routing.absence === 'route_stale') || (expiry !== null && expiry <= nowMs)) return 'stale';
  return data.envelope && expiry !== null ? 'current' : 'unavailable';
}
/** Equirectangular projection only. Scale is held by the component, so a smaller server polygon actually draws smaller. */
export function projectRoutedPoint(p: RoutedPoint, centre: RoutedPoint, metresPerPx: number, size: number): { x: number; y: number } {
  return { x: size / 2 + (p.lng - centre.lng) * 111320 * Math.cos(centre.lat * Math.PI / 180) / metresPerPx,
    y: size / 2 - (p.lat - centre.lat) * 111320 / metresPerPx };
}
/** Cache only selected return itineraries, in plan order; retain the server's whole sampled area. */
export function routedMapForPlan(data: RoutedMapData | null, recommendationIds: readonly (string | null | undefined)[]): RoutedMapData | null {
  return data ? { ...data, cards: recommendationIds.flatMap(id => { const c = data.cards.find(x => x.id === id); return c ? [c] : []; }) } : null;
}

import { continuousCoverageOf, providerRouteGeometryOf } from './layoverProviderGeometry.ts';
/** User timetable data survives offline; provider map content is never persisted. */
export function routedMapForStorage(raw: unknown): RoutedMapData | null {
  const data = routedMapDataOf(raw);
  if (!data) return null;
  const envelope = null; // Legacy contours have no licensing provenance either. Keep the separate owned straight-line bound.
  return { ...data, envelope, cards: data.cards.map(c => ({ ...c, routing: { ...c.routing, geometry: { outbound: null, returnLeg: null } } })) };
}

/**
 * The overview snapshot id the routed map may be compared with, or null for "do not compare".
 *
 * Only a CANONICAL snapshot is the same across reads. With layover_canonical_snapshot_enabled off (production,
 * 2026-10-22) the overview certifies a new snapshot on every GET and the recommendations GET regenerates with Date.now()
 * in its input hash, so the two ids never match: the routed map was dropped, then shown as "The plan has changed.
 * Refresh to see routes…" with the return route hidden, permanently. The server says whether its snapshot is canonical
 * (`snapshotComparable`); an older server that does not say is treated as "not comparable".
 */
export function comparableOverviewSnapshotId(overview: { snapshotId?: string | null; snapshotComparable?: boolean } | null | undefined): string | null {
  return overview?.snapshotComparable === true && overview.snapshotId ? overview.snapshotId : null;
}
