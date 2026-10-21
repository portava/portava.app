/** Ordered, future-departure routing for a selected experience plan. No airport-place duration is reused for a different hop. */
import { haversineMeters, type GeoPoint, type TravelMode } from '../../domain/trips/contracts/TravelTimeProvider.js';
import type { RouteCorridorProvider } from '../../lib/providers/routeCorridorProvider.js';
import { worstTravelConfidence, type TravelConfidence } from '../../lib/travelEstimate.js';
import type { LayoverFeasibilityRecord } from './LayoverFeasibility.js';
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, routedLegOf, type RoutedLeg, type RoutedLegs } from './LayoverReturnCorridor.js';
import { conservativeReturnMinutes, LAYOVER_ROUTED_POLICY, robustnessOf } from './LayoverRoutedFeasibility.js';
import { layoverRoutesGuardedCorridor, withLayoverRoutesBudget, type LayoverRoutesSession } from './LayoverTravelTime.js';
import { logger } from '../../lib/logger.js';

export interface SelectedExperienceStop { key: string; point: GeoPoint | null; insideAirport?: boolean; activityTimeMin: number }
export interface ExperienceRouteHop {
  fromKey: string; toKey: string; departAt: string; arrivesAt: string; minutes: number; conservativeMinutes: number;
  mode: TravelMode; forecast: true; expiresAt: string; transferCount: number; conveyances: RoutedLeg['conveyances'];
}
export interface ExperienceReturnHop extends ExperienceRouteHop {
  hardReturnBy: string; leaveBy: string; expectedAirportReturnAt: string; confidence: TravelConfidence; independentRoutes: number;
}
export type SelectedExperienceRoute =
  | { ok: false; reason: string; atKey: string | null }
  | { ok: true; departAt: string; finishedAt: string; hardReturnBy: string; expiresAt: string | null; confidence: TravelConfidence;
      activities: Array<{ key: string; arrivesAt: string; leavesAt: string; activityTimeMin: number }>;
      hops: ExperienceRouteHop[]; returnLeg: ExperienceReturnHop | null };

const pointValid = (p: GeoPoint | null): p is GeoPoint => !!p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
const samePoint = (a: GeoPoint, b: GeoPoint) => a.lat === b.lat && a.lng === b.lng;
const iso = (ms: number) => new Date(ms).toISOString();

/** Caller owns snapshot/action authorization; the provider retains enablement, credentials, kill switch and all budget caps. */
export async function routeSelectedExperiences(args: {
  session: LayoverRoutesSession; record: LayoverFeasibilityRecord; airportPoint: GeoPoint | null;
  stops: readonly SelectedExperienceStop[]; nowMs: number; corridorProvider?: RouteCorridorProvider;
}): Promise<SelectedExperienceRoute> {
  const refuse = (reason: string, atKey: string | null = null): SelectedExperienceRoute => ({ ok: false, reason, atKey });
  const { record, nowMs, stops } = args;
  if (!Number.isFinite(nowMs) || !stops.length || stops.length > LAYOVER_ROUTED_POLICY.candidatesPerRead) return refuse('selection_unavailable');
  const arrivalMs = Date.parse(record.inputs.session.arrivalTime);
  if (!Number.isFinite(arrivalMs)) return refuse('arrival_time_unavailable');
  const startsAt = Math.max(nowMs, arrivalMs);
  const outside = stops.some(s => s.insideAirport !== true);
  const hardMs = outside ? record.deadline.hardReturnTime.getTime() : record.deadline.cutoffMs;
  const cutoffMs = Number.isFinite(record.deadline.cutoffMs) ? record.deadline.cutoffMs : hardMs;
  if (!Number.isFinite(hardMs) || hardMs <= nowMs) return refuse('return_deadline_exceeded');
  if (outside && !pointValid(args.airportPoint)) return refuse('airport_position_unavailable');
  let exited = false, reentered = false;
  for (const stop of stops) {
    if (!stop.key || !Number.isFinite(stop.activityTimeMin) || stop.activityTimeMin <= 0) return refuse('experience_unstated', stop.key);
    if (stop.insideAirport === true) { if (exited) reentered = true; }
    else {
      if (reentered) return refuse('mixed_airside_sequence_unverified', stop.key);
      if (!pointValid(stop.point)) return refuse('no_position', stop.key);
      exited = true;
    }
  }
  const provider = layoverRoutesGuardedCorridor(args.corridorProvider ?? LAYOVER_RETURN_CORRIDOR_PROVIDER);
  if (outside && !provider.routed) return refuse('PROVIDER_UNBOUND');
  return withLayoverRoutesBudget(args.session, async () => {
    const hops: ExperienceRouteHop[] = [];
    const activities: Array<{ key: string; arrivesAt: string; leavesAt: string; activityTimeMin: number }> = [];
    let cursor = startsAt, origin = args.airportPoint, fromKey = 'airport', atAirport = true;
    let confidence: TravelConfidence = ['HIGH', 'MEDIUM', 'LOW'].includes(record.confidence) ? record.confidence as TravelConfidence : 'INSUFFICIENT';
    let returnLeg: ExperienceReturnHop | null = null;
    let expiresMs = Infinity;
    const hop = async (toKey: string, destination: GeoPoint, returning: boolean): Promise<SelectedExperienceRoute | null> => {
      const mode: TravelMode = haversineMeters(origin!, destination) <= LAYOVER_ROUTED_POLICY.walkMaxMetres ? 'walk' : 'drive';
      let response;
      try { response = await provider.corridor({ from: origin!, to: destination, mode, departAt: new Date(cursor), wantAlternatives: true }); }
      catch (err) { logger.warn({ err, surface: 'layover.experience-routing', provider: provider.id }, 'selected experience route unavailable'); return refuse('PROVIDER_UNAVAILABLE', toKey); }
      if (!response.ok) return refuse(response.reason, toKey);
      const c = response.value;
      const expiry = Date.parse(c.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= nowMs) return refuse('route_stale', toKey);
      if (!samePoint(c.from, origin!) || !samePoint(c.to, destination) || Date.parse(c.departAt) !== cursor || !c.routes.length
        || c.routes.some(r => !Number.isFinite(r.totalMinutes) || r.totalMinutes < 0 || !r.legs.length || r.legs.some(l => !Number.isFinite(l.minutes) || l.minutes < 0))) return refuse('PROVIDER_MALFORMED', toKey);
      const leg = routedLegOf({ ...c, routes: [...c.routes].sort((a,b) => a.totalMinutes - b.totalMinutes) }, mode);
      if (!leg.forecast) return refuse('return_forecast_unavailable', toKey);
      confidence = worstTravelConfidence(confidence, leg.confidence);
      if (leg.transferCount >= LAYOVER_ROUTED_POLICY.complexTransferCount) confidence = worstTravelConfidence(confidence, 'LOW');
      const conservative = conservativeReturnMinutes(leg.minutes, confidence, robustnessOf({ returnLeg: leg } as RoutedLegs));
      if (!conservative) return refuse('confidence_insufficient', toKey);
      const arrival = cursor + conservative.minutes * 60000;
      if (arrival > hardMs) return refuse('return_deadline_exceeded', toKey);
      const value: ExperienceRouteHop = { fromKey, toKey, departAt: iso(cursor), arrivesAt: iso(arrival), minutes: leg.minutes,
        conservativeMinutes: conservative.minutes, mode, forecast: true, expiresAt: c.expiresAt, transferCount: leg.transferCount, conveyances: leg.conveyances };
      hops.push(value);
      if (returning) returnLeg = { ...value, hardReturnBy: iso(hardMs), leaveBy: iso(hardMs - conservative.minutes * 60000), expectedAirportReturnAt: iso(arrival), confidence, independentRoutes: leg.independentRoutes };
      cursor = arrival; expiresMs = Math.min(expiresMs, expiry);
      origin = destination; fromKey = toKey; atAirport = returning;
      return null;
    };
    for (const stop of stops) {
      if (stop.insideAirport === true) {
        if (!atAirport) { const failed = await hop('airport', args.airportPoint!, true); if (failed) return failed; }
      } else {
        if (atAirport) cursor = Math.max(cursor, record.envelope.earliestOutTime.getTime());
        const failed = await hop(stop.key, stop.point!, false); if (failed) return failed;
      }
      const arrival = cursor;
      cursor += stop.activityTimeMin * 60000;
      if (cursor > (atAirport ? cutoffMs : hardMs)) return refuse('return_deadline_exceeded', stop.key);
      activities.push({ key: stop.key, arrivesAt: iso(arrival), leavesAt: iso(cursor), activityTimeMin: stop.activityTimeMin });
    }
    if (!atAirport) { const failed = await hop('airport', args.airportPoint!, true); if (failed) return failed; }
    return { ok: true, departAt: iso(startsAt), finishedAt: iso(cursor), hardReturnBy: iso(hardMs),
      expiresAt: Number.isFinite(expiresMs) ? iso(expiresMs) : null, confidence, activities, hops, returnLeg };
  });
}
