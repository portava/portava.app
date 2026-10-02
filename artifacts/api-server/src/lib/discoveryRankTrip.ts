/**
 * discoveryRankTrip — DV-18's missing leg: a `trip_match` producer on the
 * recommendation ranker. census-discovery §78 (lane W10-R2).
 *
 * §69.3 DV-18: "8 of 9 grounded … `trip_match` has none; a trip-fit term is
 * held." `01` §11 names `trip_match` as an internal reason; `01` §3 lists the
 * "current trip context: current city, upcoming destination, trip dates" as a
 * PDE input; `01` §9 Trip Planning favours "trip fit".
 *
 * WHERE THE TRIP COMES FROM (decision D-W10-R2-6)
 * ==============================================
 * NOT from a `tripId` request parameter. ranker-hold-designs §7 proposed one
 * and named its precondition — it must enter `authorizedContextKey` first —
 * and that is a route and cache-key change in files this lane does not own.
 * Instead the viewer's OWN trips are read through the Map's existing trip
 * reader, lib/mapProjectionTripRead.readTripStopLayer: the Trips projection
 * where its capability is ready, `trip_members` → `trips` otherwise, scoped to
 * trips the viewer is an ACCEPTED member of. That is the reader census A10
 * asks consumers to share rather than re-deriving Trip semantics, and it needs
 * no new request parameter, so there is no second trip to key a cache on:
 * Cache B's key is already per viewer.
 *
 * WHAT "FIT" MEANS HERE, EXACTLY
 * =============================
 *   timing     1 while the trip is under way; for an upcoming trip it falls
 *              linearly to 0.5 at TRIP_HORIZON_DAYS out; a trip that has ended,
 *              starts beyond the horizon, or is cancelled / completed /
 *              archived contributes nothing.
 *   proximity  from the trip's destination point to the place: 1/(1 + d/25)
 *              inside TRIP_RADIUS_KM, 0 beyond. City scale on purpose — a
 *              destination point is a city, not a hotel, and the kernel must
 *              not pretend to know the itinerary. With no coordinates on either
 *              side, a destination city equal to the request city counts 0.5.
 *   fit        max over the viewer's trips of timing × proximity, in [0,1].
 *
 * portavaRank scores it as `tripMatch` = TRIP_MATCH_WEIGHT × fit, and
 * lib/discoveryReasonCodes maps `tripMatch` → `trip_match`. The reason can
 * therefore only be emitted for a row that actually sits in the viewer's own
 * current or upcoming trip — which is what makes it a producer and not a label.
 *
 * WHAT IT CANNOT SEE: itinerary items and saved plan items. Trips publishes no
 * plan-item projection (census-discovery owner item E-7), and reading
 * `trip_saved_places` directly would be the duplication A10 forbids. When that
 * projection exists, "on your itinerary" becomes a second, stronger fit.
 */
import { readTripStopLayer } from "./mapProjectionTripRead.js";
import type { TripViewLike } from "./mapProjection.js";
import { normaliseGeoLabel } from "./portavaRank.js";

export const TRIP_HORIZON_DAYS = 90;
export const TRIP_RADIUS_KM = 50;
export const TRIP_PROXIMITY_SCALE_KM = 25;
const DAY = 86_400_000;
const CLOSED = new Set(["cancelled", "canceled", "completed", "archived"]);

export interface TripFitPlace { id: string; lat?: number | null; lng?: number | null }

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A trip's timing weight at `nowMs`, or 0 when the trip does not count. */
export function tripTiming(t: TripViewLike, nowMs: number): number {
  if (t.status && CLOSED.has(String(t.status).toLowerCase())) return 0;
  const start = t.startDate ? Date.parse(String(t.startDate)) : NaN;
  const endRaw = t.endDate ? Date.parse(String(t.endDate)) : NaN;
  // An end DATE names the last day of the trip, so it ends at the close of that day.
  const end = Number.isFinite(endRaw) ? endRaw + DAY : NaN;
  if (Number.isFinite(end) && end < nowMs) return 0;
  if (!Number.isFinite(start)) return 0;                       // no dates: not a trip "context" yet
  if (start <= nowMs) return 1;                                 // under way
  const ahead = (start - nowMs) / DAY;
  if (ahead > TRIP_HORIZON_DAYS) return 0;
  return 1 - 0.5 * (ahead / TRIP_HORIZON_DAYS);
}

/** place id → trip fit in [0,1]; an empty object when no trip counts. PURE. */
export function tripFitMap(
  places: readonly TripFitPlace[], trips: readonly TripViewLike[], opts: { city: string | null; nowMs: number },
): Record<string, number> {
  const live = trips.map((t) => ({ t, timing: tripTiming(t, opts.nowMs) })).filter((x) => x.timing > 0);
  const out: Record<string, number> = {};
  if (live.length === 0) return out;
  const city = normaliseGeoLabel(opts.city);
  for (const p of places) {
    let best = 0;
    for (const { t, timing } of live) {
      let prox = 0;
      const hasPlace = p.lat != null && p.lng != null && Number.isFinite(p.lat) && Number.isFinite(p.lng);
      const hasTrip = t.destinationLat != null && t.destinationLng != null && Number.isFinite(Number(t.destinationLat)) && Number.isFinite(Number(t.destinationLng));
      if (hasPlace && hasTrip) {
        const d = haversineKm(Number(t.destinationLat), Number(t.destinationLng), Number(p.lat), Number(p.lng));
        prox = d <= TRIP_RADIUS_KM ? 1 / (1 + d / TRIP_PROXIMITY_SCALE_KM) : 0;
      } else if (city && normaliseGeoLabel(t.destinationCity) === city) {
        prox = 0.5;
      }
      best = Math.max(best, timing * prox);
    }
    if (best > 0) out[p.id] = best;
  }
  return out;
}

export interface TripMatchRead {
  /** Null when no trip counts OR the trip layer could not be read — the term is then absent, never 0-by-failure. */
  tripMatch: Record<string, number> | null;
  degraded: boolean;
  /** Trips that counted (timing > 0). */
  trips: number;
}

export async function loadTripMatch(
  sc: any, viewerId: string, places: readonly TripFitPlace[], city: string | null, nowMs: number,
): Promise<TripMatchRead> {
  if (!sc || !viewerId || places.length === 0) return { tripMatch: null, degraded: !sc && !!viewerId, trips: 0 };
  try {
    const read = await readTripStopLayer(sc, viewerId);
    if (read.trips === null) return { tripMatch: null, degraded: true, trips: 0 };
    const counted = read.trips.filter((t) => tripTiming(t, nowMs) > 0);
    if (counted.length === 0) return { tripMatch: null, degraded: false, trips: 0 };
    return { tripMatch: tripFitMap(places, counted, { city, nowMs }), degraded: false, trips: counted.length };
  } catch {
    return { tripMatch: null, degraded: true, trips: 0 };
  }
}
