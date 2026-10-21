export interface AirportMapFeature {
  id: string; kind: 'terminal' | 'gate' | 'checkpoint' | 'walking_link'; label: string; terminalId: string | null; minutes: number | null;
  geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] };
}
export interface AirportTopologyGeometry {
  available: boolean; reason: string | null; factId: string | null; topologyVersion: number; expiresAt: string | null;
  source: 'published_airport_topology'; displayPolicy: 'independent_map'; cachePolicy: 'until_expiry'; features: AirportMapFeature[];
}
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const coordinate = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
export function airportTopologyOf(raw: unknown): AirportTopologyGeometry | null {
  const r = obj(raw);
  if (!r || r.source !== 'published_airport_topology' || r.displayPolicy !== 'independent_map' || r.cachePolicy !== 'until_expiry' || typeof r.available !== 'boolean' || !Number.isInteger(r.topologyVersion) || !Array.isArray(r.features) || r.features.length > 500) return null;
  const features: AirportMapFeature[] = [];
  for (const rawFeature of r.features) {
    const f = obj(rawFeature), g = obj(f?.geometry);
    if (!f || typeof f.id !== 'string' || typeof f.label !== 'string' || f.label.length > 300 || !['terminal', 'gate', 'checkpoint', 'walking_link'].includes(String(f.kind)) || !g) return null;
    let geometry: AirportMapFeature['geometry'];
    if (g.type === 'Point' && coordinate(g.coordinates)) geometry = { type: 'Point', coordinates: [...g.coordinates] };
    else if (g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2 && g.coordinates.length <= 500 && g.coordinates.every(coordinate)) geometry = { type: 'LineString', coordinates: g.coordinates.map(p => [...p]) };
    else return null;
    features.push({ id: f.id, kind: f.kind as AirportMapFeature['kind'], label: f.label, terminalId: typeof f.terminalId === 'string' ? f.terminalId : null,
      minutes: typeof f.minutes === 'number' && Number.isFinite(f.minutes) && f.minutes >= 0 ? f.minutes : null, geometry });
  }
  const expiresAt = typeof r.expiresAt === 'string' && Number.isFinite(Date.parse(r.expiresAt)) ? r.expiresAt : null;
  const factId = typeof r.factId === 'string' ? r.factId : null;
  if (r.available && (!expiresAt || !factId || features.length === 0)) return null;
  return { available: r.available, reason: typeof r.reason === 'string' ? r.reason : null, factId, topologyVersion: r.topologyVersion as number, expiresAt,
    source: 'published_airport_topology', displayPolicy: 'independent_map', cachePolicy: 'until_expiry', features };
}
export function airportTopologyCurrent(value: AirportTopologyGeometry | null, nowMs: number): boolean {
  return !!value?.available && !!value.expiresAt && Date.parse(value.expiresAt) > nowMs;
}
