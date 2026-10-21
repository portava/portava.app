export type Coordinate = [number, number];
export interface ProviderRouteGeometry {
  provider: 'google_maps'; displayPolicy: 'google_map_only'; cachePolicy: 'no_store';
  geometry: { type: 'LineString'; coordinates: Coordinate[] };
}
export interface ContinuousCoverage {
  state: 'available'; basis: 'bidirectional_walking_network'; provider: 'google_maps'; displayPolicy: 'google_map_only'; cachePolicy: 'no_store';
  mode: 'walk'; geometry: { type: 'MultiPolygon'; coordinates: Coordinate[][][] }; expiresAt: string;
  windowStartsAt: string; hardReturnBy: string; outboundBudgetMinutes: number; returnBudgetMinutes: number;
  conservativeReturnMinutes: number; dwellMinutes: number; usableMinutes: number; uncertaintyMinutes: number;
  scope: 'walking_network_with_dwell_floor';
}
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const coordinate = (v: unknown): v is Coordinate => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const policy = (v: Record<string, unknown>) => v.provider === 'google_maps' && v.displayPolicy === 'google_map_only' && v.cachePolicy === 'no_store';
export function providerRouteGeometryOf(raw: unknown): ProviderRouteGeometry | null {
  const r = obj(raw), g = obj(r?.geometry);
  if (!r || !policy(r) || g?.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2 || g.coordinates.length > 20_000 || !g.coordinates.every(coordinate)) return null;
  return { provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', geometry: { type: 'LineString', coordinates: g.coordinates.map(p => [...p]) } };
}
export function continuousCoverageOf(raw: unknown): ContinuousCoverage | { state: 'unavailable'; reason: string } | null {
  const r = obj(raw), g = obj(r?.geometry);
  if (r?.state === 'unavailable' && typeof r.reason === 'string') return { state: 'unavailable', reason: r.reason };
  if (!r || r.state !== 'available' || !policy(r) || r.basis !== 'bidirectional_walking_network' || r.mode !== 'walk' || r.scope !== 'walking_network_with_dwell_floor' || g?.type !== 'MultiPolygon' || !Array.isArray(g.coordinates) || !g.coordinates.length) return null;
  let count = 0;
  for (const p of g.coordinates) {
    if (!Array.isArray(p) || !p.length) return null;
    for (const ring of p) {
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(coordinate) || (count += ring.length) > 50_000 || ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1]) return null;
    }
  }
  const numeric = ['outboundBudgetMinutes', 'returnBudgetMinutes', 'conservativeReturnMinutes', 'dwellMinutes', 'usableMinutes', 'uncertaintyMinutes'] as const;
  if (!numeric.every(k => typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= 0) || !instant(r.expiresAt) || !instant(r.windowStartsAt) || !instant(r.hardReturnBy)) return null;
  return { state: 'available', basis: 'bidirectional_walking_network', provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', mode: 'walk', scope: 'walking_network_with_dwell_floor',
    geometry: { type: 'MultiPolygon', coordinates: (g.coordinates as Coordinate[][][]).map(p => p.map(ring => ring.map(p => [...p]))) },
    expiresAt: r.expiresAt, windowStartsAt: r.windowStartsAt, hardReturnBy: r.hardReturnBy,
    ...Object.fromEntries(numeric.map(k => [k, r[k]])) } as ContinuousCoverage;
}
