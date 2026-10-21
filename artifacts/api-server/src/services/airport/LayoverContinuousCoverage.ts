import clipping from 'polygon-clipping';
import type { GeoPoint } from '../../domain/trips/contracts/TravelTimeProvider.js';
import { currentRoutesRequestBudget } from '../../domain/trips/contracts/RoutesRequestBudget.js';
import { routesReadTimeSpent, routesRequestTimeoutMs, markRoutesReadTimedOut } from '../../lib/providers/googleRoutesCorridorProvider.js';
import { logger } from '../../lib/logger.js';
import { layoverRoutesSpendGate, type LayoverRoutesSpendGate } from './layoverRoutesSpendGate.js';
import type { LayoverFeasibilityRecord } from './LayoverFeasibility.js';
import { certifiedPlanningInstant } from '../layover/layoverCanonicalValidity.js';
import { ENVELOPE_UNCERTAINTY_BUDGET } from './LayoverEnvelope.js';

type Position = [number, number];
export type CoverageGeometry = { type: 'MultiPolygon'; coordinates: Position[][][] };
export type ContinuousCoverage = {
  state: 'available'; basis: 'bidirectional_walking_network'; provider: 'google_maps';
  displayPolicy: 'google_map_only'; cachePolicy: 'no_store'; mode: 'walk';
  geometry: CoverageGeometry; expiresAt: string; windowStartsAt: string; hardReturnBy: string;
  outboundBudgetMinutes: number; returnBudgetMinutes: number; conservativeReturnMinutes: number;
  dwellMinutes: number; usableMinutes: number; uncertaintyMinutes: number;
  /** A network-model contour, not a guarantee about accessibility or a particular activity. */
  scope: 'walking_network_with_dwell_floor';
} | { state: 'unavailable'; reason: string };

const ENDPOINT = 'https://isochrones.googleapis.com/v1/isochrones:generate';
export function googleIsochronesConfigured(readEnv: (name: string) => string | undefined = n => process.env[n]): boolean {
  return readEnv('LAYOVER_GOOGLE_ISOCHRONES_ENABLED') === 'true' && !!readEnv('GOOGLE_ISOCHRONES_API_KEY')?.trim();
}

/** Preserve all rings and disconnected regions; malformed responses never become a filled hull. */
export function coverageGeometry(raw: unknown): CoverageGeometry | null {
  const r = raw as { type?: unknown; coordinates?: unknown } | null;
  if (!r || (r.type !== 'Polygon' && r.type !== 'MultiPolygon')) return null;
  const polys = r.type === 'Polygon' ? [r.coordinates] : r.coordinates;
  if (!Array.isArray(polys) || polys.length === 0 || polys.length > 500) return null;
  let count = 0;
  for (const poly of polys) {
    if (!Array.isArray(poly) || !poly.length) return null;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return null;
      for (const p of ring) {
        if (++count > 50_000 || !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return null;
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) return null;
    }
  }
  return { type: 'MultiPolygon', coordinates: structuredClone(polys) as Position[][][] };
}

/** Both one-way allocations AND return uncertainty fit beside dwell. Airport buffers were already deducted upstream. */
export function walkingCoverageBudget(usableMinutes: number, dwellMinutes: number, confidence: string): { outbound: number; back: number; conservativeBack: number } | null {
  const share = ENVELOPE_UNCERTAINTY_BUDGET[confidence as keyof typeof ENVELOPE_UNCERTAINTY_BUDGET];
  if (confidence === 'INSUFFICIENT' || !Number.isFinite(share) || !Number.isFinite(usableMinutes) || !Number.isFinite(dwellMinutes) || dwellMinutes < 1) return null;
  // Conservatively assume one fragile walking corridor. No independence is inferred from a polygon.
  for (let minutes = Math.min(120, Math.floor(usableMinutes / 2)); minutes >= 1; minutes--) {
    const conservativeBack = Math.ceil(minutes * (1 + share)) + Math.max(10, Math.ceil(minutes * 0.25));
    if (minutes + conservativeBack + dwellMinutes <= usableMinutes) return { outbound: minutes, back: minutes, conservativeBack };
  }
  return null;
}

export async function continuousWalkingCoverage(args: {
  record: LayoverFeasibilityRecord; airport: GeoPoint | null; landsideAllowed: boolean; dwellMinutes: number;
  mode?: 'walk' | 'drive'; readEnv?: (name: string) => string | undefined; fetchImpl?: typeof fetch;
  spendGate?: LayoverRoutesSpendGate; now?: () => Date;
}): Promise<ContinuousCoverage> {
  const absent = (reason: string): ContinuousCoverage => ({ state: 'unavailable', reason });
  const readEnv = args.readEnv ?? (n => process.env[n]);
  if (!googleIsochronesConfigured(readEnv)) return absent('isochrones_not_configured');
  if (args.mode === 'drive') return absent('future_driving_isochrone_unsupported');
  if (!args.landsideAllowed) return absent('landside_closed');
  if (!args.airport || !Number.isFinite(args.airport.lat) || !Number.isFinite(args.airport.lng) || Math.abs(args.airport.lat) > 90 || Math.abs(args.airport.lng) > 180) return absent('airport_position_missing');
  const now = args.now ?? (() => new Date());
  const starts = Math.max(certifiedPlanningInstant(args.record), args.record.envelope.earliestOutTime.getTime());
  const usable = Math.min(args.record.envelope.usableMinutes, (args.record.deadline.hardReturnTime.getTime() - starts) / 60_000);
  const allocation = walkingCoverageBudget(usable, args.dwellMinutes, args.record.confidence);
  if (!allocation) return absent('walking_roundtrip_budget_insufficient');
  const budget = currentRoutesRequestBudget();
  if (!budget?.userId || !budget.layoverSessionId) return absent('isochrone_budget_unscoped');
  if (budget.maxCalls - budget.counter.attempts < 2) return absent('isochrone_two_call_budget_unavailable');
  const fetchImpl = args.fetchImpl ?? fetch, gate = args.spendGate ?? layoverRoutesSpendGate();
  const contours: CoverageGeometry[] = [];
  for (const direction of ['FROM', 'TO'] as const) {
    if (budget.counter.attempts >= budget.maxCalls || routesReadTimeSpent(budget)) return absent('isochrone_request_budget_spent');
    budget.counter.attempts += 1;
    const verdict = await gate.decide({ userId: budget.userId, layoverSessionId: budget.layoverSessionId });
    if (verdict !== 'granted') return absent(`isochrone_spend_${verdict}`);
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': readEnv('GOOGLE_ISOCHRONES_API_KEY')! },
        body: JSON.stringify({ location: { latitude: args.airport.lat, longitude: args.airport.lng }, travelMode: 'WALK', travelDirection: direction,
          travelDuration: `${(direction === 'FROM' ? allocation.outbound : allocation.back) * 60}s`, routingPreference: 'TRAFFIC_UNAWARE', enableSmoothing: false, polygonFidelity: 'HIGH' }),
        signal: AbortSignal.timeout(routesRequestTimeoutMs(budget, now, 6000)) });
      if (!response.ok) return absent(`isochrone_provider_http_${response.status}`);
      const body = await response.json() as { isochrone?: { geoJson?: unknown } };
      const geometry = coverageGeometry(body?.isochrone?.geoJson);
      if (!geometry) return absent('isochrone_geometry_invalid');
      contours.push(geometry);
    } catch (err) { markRoutesReadTimedOut(err, budget, now); logger.warn({ err }, 'walking isochrone request failed'); return absent('isochrone_provider_unavailable'); }
  }
  try {
    const coordinates = clipping.intersection(contours[0]!.coordinates, contours[1]!.coordinates) as Position[][][];
    if (!coordinates.length) return absent('walking_roundtrip_intersection_empty');
    const geometry = coverageGeometry({ type: 'MultiPolygon', coordinates });
    if (!geometry) return absent('isochrone_intersection_invalid');
    return { state: 'available', basis: 'bidirectional_walking_network', provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', mode: 'walk',
      geometry, expiresAt: new Date(Math.min(now().getTime() + 300_000, args.record.deadline.hardReturnTime.getTime())).toISOString(),
      windowStartsAt: new Date(starts).toISOString(), hardReturnBy: args.record.deadline.hardReturnTime.toISOString(),
      outboundBudgetMinutes: allocation.outbound, returnBudgetMinutes: allocation.back, conservativeReturnMinutes: allocation.conservativeBack,
      dwellMinutes: args.dwellMinutes, usableMinutes: usable, uncertaintyMinutes: allocation.conservativeBack - allocation.back, scope: 'walking_network_with_dwell_floor' };
  } catch (err) { logger.warn({ err }, 'walking isochrone intersection failed'); return absent('isochrone_intersection_failed'); }
}
