/**
 * proximityBuckets — Telegraph §4.3 / §15: "approximate proximity or controlled
 * distance buckets BY DEFAULT".
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE SHAPE IS THE POLICY: THE DEFAULT PATH CANNOT SEE A PRECISE COORDINATE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The usual way this requirement is built — and the way it leaks — is to compute
 * the true distance from two exact positions and then round the answer. Every
 * part of that pipeline holds a precise coordinate, so every log line, error
 * payload, sort comparator and future caller along it is one careless line away
 * from disclosing one.
 *
 * This module inverts it. `proximityBucketBetween` accepts only a `CoarsePoint`,
 * and a `CoarsePoint` can be obtained in exactly one way: by passing a raw
 * position through `coarsePointFor`, which is a thin wrapper over
 * `lib/mapTravelers.ts#coarsenPosition` — the existing, tested grid-snap +
 * deterministic-jitter coarsener the Discovery map already uses. There is no
 * second constructor, no `fromExact`, and no escape hatch. A caller therefore
 * cannot hand this module a precise coordinate even by mistake, and the raw
 * position it started from is unrecoverable from what it gets back.
 *
 * Two further absences are deliberate:
 *
 *   • NO DISTANCE IS EXPORTED. The haversine below is module-private and
 *     nothing returns kilometres. A `distanceKm()` export would immediately be
 *     used for a "just for sorting" comparator, and an order by true distance
 *     discloses distance just as surely as a number does (see
 *     `services/telegraph/reachablePeople.ts` for the ordering rule).
 *   • NO km → bucket EXPORT. `proximityBucketFromKm` is private for the same
 *     reason: a public one invites `bucket(exactDistance(a, b))`, which is
 *     precisely the coarsen-the-precise-default pattern T25 refuses.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THE NARROWEST BUCKET IS 5 km AND NOT 1 km
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A bucket edge is a statement about a position. If the edges were finer than
 * the cell a position was snapped into, then watching which side of an edge
 * someone falls on would resolve their location more precisely than the
 * coordinate the bucket was computed from — the coarsening would be decorative.
 *
 * So the narrowest edge is bounded below by twice the finest coarsening cell:
 * `AREA_GRID_DEG` (0.02°) is ~2.23 km at the equator, two of those is ~4.46 km,
 * and `MIN_BUCKET_EDGE_KM` is 5. `proximityBuckets.test.ts` asserts the relation
 * rather than trusting this comment, so shrinking the map grid fails a test
 * instead of silently sharpening every bucket in the product.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TRAVEL TIME AND OVERLAP ARE BANDED FOR THE SAME REASON
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * §4.3 lists travel time among the ranking inputs. A travel time in minutes is
 * a distance wearing different units — "you are 6 minutes away" is a tighter
 * disclosure than any bucket this file admits. `travelBandForBucket` therefore
 * derives the band FROM THE BUCKET and takes no position, no route and no
 * kilometres, so it cannot express anything the bucket did not already say.
 */
import {
  AREA_GRID_DEG,
  CITY_GRID_DEG,
  coarsenPosition,
  type MapPrecision,
} from "./mapTravelers.js";

// ── Coarse points ─────────────────────────────────────────────────────────────

/** Degrees of latitude per kilometre, the standard spherical approximation. */
const KM_PER_DEG_LAT = 111.32;

/** Earth radius used by the private haversine, in km. */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * A position that has already been through the map coarsener.
 *
 * The `coarsenedBy` tag is a structural claim: only `coarsePointFor` sets it,
 * and `assertCoarsePoint` re-checks the cell size at every use, so a hand-built
 * literal claiming to be coarse with a 0.1 km cell is refused at runtime rather
 * than trusted because it type-checked.
 */
export interface CoarsePoint {
  readonly lat: number;
  readonly lng: number;
  /** Width of the grid cell this point was snapped into, in km. */
  readonly cellKm: number;
  /** Which map precision rung produced it. */
  readonly precision: MapPrecision;
  readonly coarsenedBy: "proximityBuckets";
}

/** Cell width in km for each precision rung the coarsener can return. */
export function coarseCellKm(precision: MapPrecision): number {
  return (precision === "city" ? CITY_GRID_DEG : AREA_GRID_DEG) * KM_PER_DEG_LAT;
}

/** The finest cell any coarse point can have. The bucket floor is built on it. */
export function finestCoarseCellKm(): number {
  return coarseCellKm("area");
}

/**
 * The ONLY way to obtain a `CoarsePoint`.
 *
 * `visibility` is the subject's effective discovery visibility — exactly what
 * `lib/mapTravelers.ts#effectiveDiscoveryVisibility` returns — so the rung a
 * person chose for the map is the rung their proximity is computed at. There is
 * no parameter for asking for something finer.
 *
 * Returns null for a position that is not usable, so callers branch on data
 * rather than on an exception.
 */
export function coarsePointFor(
  subjectId: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  visibility: string,
): CoarsePoint | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const snapped = coarsenPosition(subjectId, lat, lng, visibility);
  return {
    lat: snapped.lat,
    lng: snapped.lng,
    cellKm: coarseCellKm(snapped.precision),
    precision: snapped.precision,
    coarsenedBy: "proximityBuckets",
  };
}

/**
 * Refuse anything that is not genuinely coarse.
 *
 * This THROWS, on purpose. A forged coarse point is a programming error in this
 * server, not a condition a traveller can cause, and the fail-closed answer to
 * a programming error that would disclose a coordinate is to stop — not to
 * return "unknown" and let the bug ship unnoticed.
 */
export function assertCoarsePoint(p: CoarsePoint): void {
  if (p == null || p.coarsenedBy !== "proximityBuckets") {
    throw new TypeError("proximityBuckets: position was not produced by coarsePointFor");
  }
  if (!(p.cellKm >= finestCoarseCellKm())) {
    throw new TypeError(
      `proximityBuckets: cellKm ${String(p.cellKm)} is finer than the coarsest ` +
        `precision the map serves (${finestCoarseCellKm().toFixed(2)} km)`,
    );
  }
}

// ── The bucket ladder ─────────────────────────────────────────────────────────

/**
 * Ordered nearest → farthest, with `unknown` last.
 *
 * `unknown` is a real rung and not an error case: it is what a viewer or a
 * subject without location consent, or with a stale position, is given. The
 * surface stays usable (availability, relationship and shared context still
 * project) while disclosing nothing.
 */
export const PROXIMITY_BUCKETS = [
  "same_area",
  "nearby",
  "same_city",
  "same_region",
  "far",
  "unknown",
] as const;
export type ProximityBucket = (typeof PROXIMITY_BUCKETS)[number];

/** Upper edge of each bucket in km, nearest first. */
const BUCKET_EDGES_KM: ReadonlyArray<readonly [ProximityBucket, number]> = [
  ["same_area", 5],
  ["nearby", 15],
  ["same_city", 50],
  ["same_region", 250],
  ["far", Number.POSITIVE_INFINITY],
];

/** The narrowest edge in the ladder. Bounded below by 2× the finest cell. */
export const MIN_BUCKET_EDGE_KM = 5;

/** Rank on the ladder; lower = closer. `unknown` ranks last. */
export function proximityBucketRank(bucket: ProximityBucket): number {
  const i = PROXIMITY_BUCKETS.indexOf(bucket);
  return i < 0 ? PROXIMITY_BUCKETS.length - 1 : i;
}

/** True when the bucket asserts a position at all. */
export function isKnownProximity(bucket: ProximityBucket): boolean {
  return bucket !== "unknown";
}

/** PRIVATE. See the header: a public km → bucket is how the leak gets written. */
function proximityBucketFromKm(km: number): ProximityBucket {
  if (!Number.isFinite(km) || km < 0) return "unknown";
  for (const [bucket, edge] of BUCKET_EDGES_KM) {
    if (km <= edge) return bucket;
  }
  return "far";
}

/** PRIVATE. Great-circle km between two ALREADY-COARSE points. */
function haversineKm(a: CoarsePoint, b: CoarsePoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The bucket between two people, from their coarse positions only.
 *
 * Either side missing → `unknown`. This is the reciprocity rule that makes the
 * surface symmetric: a viewer who publishes no position of their own receives
 * no proximity for anyone else, because there is no point to measure from.
 */
export function proximityBucketBetween(
  a: CoarsePoint | null,
  b: CoarsePoint | null,
): ProximityBucket {
  if (!a || !b) return "unknown";
  assertCoarsePoint(a);
  assertCoarsePoint(b);
  return proximityBucketFromKm(haversineKm(a, b));
}

// ── Travel time, banded from the bucket ───────────────────────────────────────

export const TRAVEL_BANDS = [
  "walkable",
  "short_ride",
  "long_ride",
  "out_of_range",
  "unknown",
] as const;
export type TravelBand = (typeof TRAVEL_BANDS)[number];

/**
 * Travel effort, derived FROM THE BUCKET and nothing else.
 *
 * A Map is used rather than an object literal because an object literal answers
 * for keys it never declared — `({} as any)["toString"]` is truthy — and a
 * lookup that answers for inherited keys is a gate that cannot be shown to
 * refuse anything. This repo has already deleted a real guard after concluding
 * from exactly that behaviour that it was redundant.
 */
const TRAVEL_BY_BUCKET = new Map<ProximityBucket, TravelBand>([
  ["same_area", "walkable"],
  ["nearby", "short_ride"],
  ["same_city", "short_ride"],
  ["same_region", "long_ride"],
  ["far", "out_of_range"],
  ["unknown", "unknown"],
]);

export function travelBandForBucket(bucket: ProximityBucket): TravelBand {
  return TRAVEL_BY_BUCKET.get(bucket) ?? "unknown";
}

/** Rank; lower = less travel. `unknown` ranks last. */
export function travelBandRank(band: TravelBand): number {
  const i = TRAVEL_BANDS.indexOf(band);
  return i < 0 ? TRAVEL_BANDS.length - 1 : i;
}

// ── Overlap window, banded ────────────────────────────────────────────────────

export const OVERLAP_BANDS = ["none", "brief", "hour_plus", "evening_plus", "unknown"] as const;
export type OverlapBand = (typeof OVERLAP_BANDS)[number];

/**
 * How long two availability windows overlap, in bands.
 *
 * Banded because the exact overlap of two windows is a timetable: minute-level
 * overlap published to a stranger says when someone stops being busy, which is
 * the temporal twin of the coordinate this file refuses to emit.
 */
export function overlapBandForMinutes(minutes: number | null | undefined): OverlapBand {
  if (minutes == null || !Number.isFinite(minutes)) return "unknown";
  if (minutes <= 0) return "none";
  if (minutes < 60) return "brief";
  if (minutes < 240) return "hour_plus";
  return "evening_plus";
}

/** Rank; lower = more overlap. `unknown` ranks last. */
export function overlapBandRank(band: OverlapBand): number {
  const order: OverlapBand[] = ["evening_plus", "hour_plus", "brief", "none", "unknown"];
  const i = order.indexOf(band);
  return i < 0 ? order.length - 1 : i;
}

/**
 * Minutes of overlap between two [start, end) intervals in epoch ms, or null
 * when either side is unbounded. Pure arithmetic — no clock of its own.
 */
export function overlapMinutes(
  a: { startMs: number; endMs: number } | null,
  b: { startMs: number; endMs: number } | null,
): number | null {
  if (!a || !b) return null;
  if (![a.startMs, a.endMs, b.startMs, b.endMs].every((n) => Number.isFinite(n))) return null;
  const start = Math.max(a.startMs, b.startMs);
  const end = Math.min(a.endMs, b.endMs);
  return end <= start ? 0 : Math.round((end - start) / 60_000);
}
