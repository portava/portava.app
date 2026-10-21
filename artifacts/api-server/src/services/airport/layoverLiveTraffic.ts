/**
 * layoverLiveTraffic — the TRAFFIC half of Layover's live intelligence
 * (spec Appendix B "Traffic spike → Return deadline moves earlier"; Appendix A
 * "TRAFFIC_DEGRADED — Future return travel worsened"; census L228, L287).
 * Lane B2-LIVE, Layover 165.
 *
 * It CONSUMES the routing lane (B1-R1) and owns none of it: the corridor is
 * asked through `layoverReturnRisk` (LayoverReturnCorridor.ts), inside the
 * session's Routes budget (`withLayoverRoutesBudget`) and behind the session
 * guard (`layoverRoutesGuardedCorridor`) — the same three calls the action
 * universe makes, so a traffic read is charged, capped and refused exactly as
 * a routed card is. Nothing here builds a request or reads Google's JSON.
 *
 * WHAT IS MEASURED. The return leg from the traveller's farthest PLANNED
 * landside stop back to the airport, by car, asked for the instant they would
 * set off back. `RoutedLeg` already carries the two numbers this needs: the
 * traffic-aware `minutes` (a forecast only when Google answered traffic-aware —
 * `forecast`) and the `freeFlowMinutes` bound. Their difference is the traffic
 * on that road at that hour.
 *
 * THE BASELINE IS WHAT THE STATIC BUFFER ALREADY BUDGETS FOR TRAFFIC — the
 * airport's own `traffic_extra_min` (airport_profiles, official information)
 * plus the time-of-day return ramp `computeBuffer` adds at the cutoff. Only
 * the traffic ABOVE that is a live term: a forecast at or under the budget
 * adds nothing and is not evidence the budget is too large. So this can move a
 * deadline earlier and can never move one later.
 *
 * ABSENCES, NAMED. No airport coordinate, no landside stop with a position, a
 * provider that refuses (Routes not enabled, no key, the session cap spent, a
 * Google fallback to traffic-unaware) — each is `signal: null` with the reason
 * in `detail`, never a zero-minute traffic term. Only an unreadable plan is a
 * failed read (`ok: false`), because then the absence is not known to be one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { computeReturnDeadline } from "./LayoverSafetyEngine.js";
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, layoverReturnRisk, type RouteCorridorProvider } from "./LayoverReturnCorridor.js";
import { airportPoint, layoverRoutesGuardedCorridor, withLayoverRoutesBudget } from "./LayoverTravelTime.js";

/** The forecast is asked for this long before the static hard-return instant: roughly when a traveller sets off back. */
export const TRAFFIC_RETURN_LEAD_MIN = 60;

export interface TrafficSignal {
  /** The return leg's traffic-aware duration (minutes). */
  trafficAwareMin: number;
  /** Its free-flow bound (minutes). */
  freeFlowMin: number;
  /** trafficAware − freeFlow: the traffic on that road at that hour. >= 0. */
  penaltyMin: number;
  /** What the static buffer already budgets for traffic (airport term + time-of-day return ramp). */
  baselineMin: number;
  /** max(0, penalty − baseline): the live term. */
  excessMin: number;
  /** When the forecast was asked FOR (the return instant), ISO. */
  forInstant: string;
  observedAt: string;
  expiresAt: string;
  confidence: "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH";
  sourceRefs: string[];
}

export type TrafficSignalRead =
  | { ok: true; signal: TrafficSignal | null; detail: string | null }
  | { ok: false; reason: "stops_unreadable"; detail: string };

function haversineMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The traffic term from a measured return leg. Pure, and the one place the
 * arithmetic lives, so the I/O wrapper below and its tests cannot disagree.
 * `null` when the leg is not a traffic-aware forecast — a free-flow figure
 * says nothing about traffic, and calling it "no traffic" would be the
 * fabricated freshness §2.1 forbids.
 */
export function trafficSignalFromLeg(
  leg: { minutes: number; freeFlowMinutes: number | null; forecast: boolean; confidence: TrafficSignal["confidence"]; departAt: string },
  baselineMin: number,
  meta: { nowMs: number; expiresAt: string; sourceRefs: string[] },
): TrafficSignal | null {
  if (!leg.forecast || leg.freeFlowMinutes === null) return null;
  if (!Number.isFinite(leg.minutes) || !Number.isFinite(leg.freeFlowMinutes) || leg.freeFlowMinutes < 0) return null;
  const penaltyMin = Math.max(0, leg.minutes - leg.freeFlowMinutes);
  const baseline = Number.isFinite(baselineMin) && baselineMin > 0 ? baselineMin : 0;
  return {
    trafficAwareMin: leg.minutes,
    freeFlowMin: leg.freeFlowMinutes,
    penaltyMin,
    baselineMin: baseline,
    excessMin: Math.max(0, penaltyMin - baseline),
    forInstant: leg.departAt,
    observedAt: new Date(meta.nowMs).toISOString(),
    expiresAt: meta.expiresAt,
    confidence: leg.confidence,
    sourceRefs: [...meta.sourceRefs],
  };
}

/** Read the session's plan, ask the return corridor, and fold the answer. See the header. */
export async function readReturnTrafficSignal(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs: number,
  opts: { provider?: RouteCorridorProvider } = {},
): Promise<TrafficSignalRead> {
  const centre = airportPoint(airport);
  if (!centre) return { ok: true, signal: null, detail: "no airport coordinate: no return route can be forecast" };

  const { data, error } = await db
    .from("layover_plan_stops")
    .select("id,lat,lng,inside_airport")
    .eq("session_id", session.id);
  if (error) return { ok: false, reason: "stops_unreadable", detail: String((error as { message?: string }).message ?? "layover_plan_stops unreadable") };

  let farthest: { lat: number; lng: number } | null = null;
  let farthestM = -1;
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (r.inside_airport === true) continue;
    const p = airportPoint({ lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng) });
    if (!p) continue;
    const m = haversineMetres(centre, p);
    if (m > farthestM) { farthestM = m; farthest = p; }
  }
  if (!farthest) return { ok: true, signal: null, detail: "no landside stop with a position is planned: there is no return route to forecast" };

  const statics = computeReturnDeadline(airport, session, null);
  const baselineMin = statics.breakdown.trafficExtra + statics.breakdown.returnTransportExtra;
  const returnDepartAt = new Date(Math.max(nowMs, statics.hardReturnTime.getTime() - TRAFFIC_RETURN_LEAD_MIN * 60_000));
  const provider = layoverRoutesGuardedCorridor(opts.provider ?? LAYOVER_RETURN_CORRIDOR_PROVIDER);
  const outcome = await withLayoverRoutesBudget(
    { userId: session.userId, tripId: session.tripId ?? null, id: session.id },
    () => layoverReturnRisk({ airport: centre, candidate: farthest, outboundDepartAt: new Date(nowMs), returnDepartAt, mode: "drive" }, nowMs, provider),
  );
  const legs = outcome.legs ?? null;
  if (!legs) return { ok: true, signal: null, detail: `no measured return leg: ${outcome.reason ?? "unknown"}${outcome.detail ? ` — ${outcome.detail}` : ""}` };
  const signal = trafficSignalFromLeg(legs.returnLeg, baselineMin, { nowMs, expiresAt: legs.expiresAt, sourceRefs: legs.sourceRefs });
  return signal
    ? { ok: true, signal, detail: null }
    : { ok: true, signal: null, detail: "the return leg is not a traffic-aware forecast (free-flow or fallback): it says nothing about traffic" };
}
