/** Provider geometry stays transient and is rendered only on its licensed map surface. */
export interface ProviderRouteGeometry {
  provider: 'google_maps'; displayPolicy: 'google_map_only'; cachePolicy: 'no_store';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}
export function googleRouteGeometry(raw: unknown): ProviderRouteGeometry | null {
  const r = raw as { type?: unknown; coordinates?: unknown } | null;
  if (!r || r.type !== 'LineString' || !Array.isArray(r.coordinates) || r.coordinates.length < 2 || r.coordinates.length > 20_000) return null;
  if (!r.coordinates.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return null;
  return { provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', geometry: { type: 'LineString', coordinates: r.coordinates.map(p => [p[0], p[1]]) } };
}

/** Persistence projection: no provider geometry survives nested contracts, audit or replay payloads. */
export function withoutProviderMapContent<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if ((value as { cachePolicy?: unknown }).cachePolicy === 'no_store') return null as T;
  if (Array.isArray(value)) return value.map(withoutProviderMapContent) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutProviderMapContent(child)])) as T;
}
