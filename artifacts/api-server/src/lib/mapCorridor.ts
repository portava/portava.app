/**
 * mapCorridor — "Along My Way" (Map spec §36 Phase 6), as a FILTER on the
 * existing Map Intelligence Gateway.
 *
 * WHAT THIS IS, AND WHAT IT IS EXPLICITLY NOT
 * ===========================================
 * It is a bbox plus a distance-to-polyline predicate. Given the viewer's own
 * active route (the polyline they are already travelling) it keeps the objects
 * within `meters` of that line and drops the rest, then attaches a detour cost.
 *
 * IT IS ONLY NOT A NEW PRIVACY SURFACE BECAUSE OF WHERE IT IS CALLED. This
 * module is pure geometry over whatever MapObjects it is handed; it has no way
 * to tell a served coordinate from a withheld one. Everything below is
 * therefore a constraint on the CALLER as much as on this file, and the caller
 * that satisfies it is routes/mapProjection.ts — which invokes
 * `filterToCorridor` after `servableOnly`, after `withholdCoarsenableAggregates`,
 * after the §24 `applyProtection` gate and after §31 `aggregateForViewport`.
 * Nothing else may call it earlier.
 *
 *   * It never reads anything. It receives MapObjects and returns a SUBSET of
 *     them, unmodified.
 *   * EVERY NUMBER IT EMITS IS DERIVED FROM `obj.geometry` — the geometry the
 *     response is about to serialize. When §24 has coarsened an object to its
 *     zone anchor, `offsetMeters`, `alongMeters` and the detour minutes all
 *     describe THE ANCHOR. Called before that gate, they described the true
 *     coordinate the gate had just removed, and two requests with non-parallel
 *     polylines trilaterated it back — the reported cost was the disclosure.
 *     That is the defect this call-site rule exists to prevent, and
 *     src/test/mapCorridorRoute.test.ts pins it as a measured value.
 *   * ITS COUNTERS COUNT ONLY WHAT SURVIVED THE GATE. `kept` / `droppedOffRoute`
 *     / `droppedNoGeometry` are computed over the input, so an input containing
 *     suppressed objects would turn `kept` into a position oracle for things
 *     the viewer may not see. The caller passes post-gate objects; the counters
 *     are then honest by construction.
 *   * It can only ever REMOVE. There is no branch here that adds an object,
 *     sharpens a geometry, un-coarsens a zone or lowers a k-anonymity floor.
 *     The corridor's answer is a subset of the answer the same viewer would
 *     get by asking the same endpoint for the same bbox with no corridor at
 *     all — so it cannot reveal anything the gateway would have withheld.
 *   * IT MUST NOT DECIDE WHO IS IN A K-COHORT. Running after §31 means the
 *     aggregation cells are binned from a set that does not depend on the
 *     polyline, so a caller cannot re-partition one cohort by varying their
 *     route and read each partition's `count`. They can only drop whole cells
 *     that were already published.
 *   * The polyline is the VIEWER'S OWN. It arrives as a request parameter
 *     describing where the caller is going. It is never another person's
 *     route, and nothing here writes it down.
 *
 * THE DETOUR COST IS AN ESTIMATE, AND SAYS SO (§37)
 * ================================================
 * `detourMinutes` is straight-line geometry over an assumed walking speed —
 * out to the object and back to the line. It is not a routed path and it is
 * not an observation of anything: §37 forbids making a prediction look like an
 * observation, so `DetourCost.basis` is `"straight_line_estimate"` and the
 * rendered line is prefixed "Est." by `detourLine`. No caller may present it
 * as a measured travel time, and the type gives no field that would let them.
 *
 * PURE. No I/O, no clock, no privacy decisions, no ranking. The gateway ranks;
 * this filters, and `filterToCorridor` PRESERVES the input order so §31's
 * ladder survives untouched.
 */
import { centroidOf, type MapObject } from "./mapObjects.js";
import { KM_PER_DEGREE_LAT, type BBox } from "./mapAggregation.js";

// ── The flag ──────────────────────────────────────────────────────────────────

/**
 * The ONE capability flag for §36 Phase 6, seeded OFF (migration 2296).
 *
 * It lives here, in the phase's own pure lib, so that routes/mapProjection.ts
 * and routes/mapJourney.ts cannot spell it two different ways. Both keep a
 * literal at the `isFlagEnabled` call site — check:flag-polarity resolves flag
 * arguments statically and a constant defeats it — and both PIN that literal
 * against this constant, so a rename is a type error rather than a silently
 * divergent second spelling. Same pattern, same reason, as CROWD_FLOW_FLAG.
 */
export const JOURNEY_INTELLIGENCE_FLAG = "map_journey_intelligence_enabled";

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Minimum corridor half-width. Below this the corridor is noise, not a filter. */
export const CORRIDOR_MIN_METERS = 50;
/**
 * Maximum corridor half-width. 5 km is already wider than most city viewports;
 * beyond it "along my way" stops meaning anything and the client should just
 * ask for the bbox.
 */
export const CORRIDOR_MAX_METERS = 5_000;
/** Default half-width when the caller does not say. A comfortable short walk. */
export const CORRIDOR_DEFAULT_METERS = 400;
/**
 * Maximum polyline vertices accepted. A route plan's stop list is a handful of
 * points; this cap exists so a hostile caller cannot make the O(objects ×
 * vertices) scan expensive.
 */
export const CORRIDOR_MAX_POINTS = 200;

/** Assumed walking speed for the detour estimate, km/h. Mirrors Compass. */
export const CORRIDOR_WALKING_SPEED_KMH = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Corridor {
  /** The viewer's own route line, in order. At least two distinct points. */
  path: LatLng[];
  /** Half-width in metres; an object further than this from the line is out. */
  meters: number;
}

/**
 * The detour cost of leaving the route for one object and rejoining it.
 *
 * `basis` is not decoration. It is the machine-readable half of the §37
 * promise the text half makes: this is straight-line geometry, not a routed
 * measurement, and a renderer that wants to say otherwise has to lie about a
 * field rather than merely omit a caveat.
 */
export interface DetourCost {
  /** Perpendicular distance from the route line to the object, in metres. */
  offsetMeters: number;
  /** Out-and-back: 2 × offset, in metres. */
  extraMeters: number;
  /** `extraMeters` at CORRIDOR_WALKING_SPEED_KMH, rounded up to a minute. */
  extraMinutes: number;
  /** How far along the route the object is reached, in metres from the start. */
  alongMeters: number;
  /** The estimate's provenance. Never "measured", because it is not. */
  basis: "straight_line_estimate";
}

export interface CorridorMatch {
  /** The MapObject.id this cost belongs to. */
  objectId: string;
  detour: DetourCost;
  /** The rendered §37-safe line, e.g. "Est. +6 min detour · 240 m off route". */
  line: string;
}

export interface CorridorFilterResult {
  /** The surviving objects, IN THE INPUT ORDER (§31 rank is preserved). */
  objects: MapObject[];
  /** Per-surviving-object detour costs, in the same order as `objects`. */
  matches: CorridorMatch[];
  /** Objects whose centroid was outside the corridor. */
  droppedOffRoute: number;
  /** Objects with no resolvable centroid — kept out, never guessed onto the line. */
  droppedNoGeometry: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse `corridor=lat,lng;lat,lng;...` — the viewer's route polyline.
 *
 * Refuses rather than repairs: a malformed vertex, an out-of-range coordinate,
 * more than CORRIDOR_MAX_POINTS vertices, or fewer than two DISTINCT points all
 * return null. A one-point "line" is a location, not a corridor, and silently
 * treating it as one would turn Along My Way into a radius search around
 * wherever the caller said they were.
 */
export function parseCorridorPath(raw: unknown): LatLng[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split(";");
  if (parts.length > CORRIDOR_MAX_POINTS) return null;

  const path: LatLng[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (piece === "") continue;
    const nums = piece.split(",").map((n) => Number(n.trim()));
    if (nums.length !== 2) return null;
    const [lat, lng] = nums as [number, number];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    path.push({ lat, lng });
  }

  // Two DISTINCT points, not two entries: "10,10;10,10" is one place written
  // twice and defines no direction to travel along.
  const distinct = path.some((p) => p.lat !== path[0]!.lat || p.lng !== path[0]!.lng);
  if (path.length < 2 || !distinct) return null;
  return path;
}

/** Clamp `corridorMeters` into [MIN, MAX]; a missing or unusable value ⇒ default. */
export function parseCorridorMeters(raw: unknown): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return CORRIDOR_DEFAULT_METERS;
  return Math.min(CORRIDOR_MAX_METERS, Math.max(CORRIDOR_MIN_METERS, Math.round(n)));
}

/** Build a corridor from already-parsed pieces, or null when the path is unusable. */
export function buildCorridor(path: LatLng[] | null, meters: number): Corridor | null {
  if (!path || path.length < 2) return null;
  return { path, meters };
}

// ── Geometry ──────────────────────────────────────────────────────────────────

const KM_PER_DEGREE_LAT_LOCAL = KM_PER_DEGREE_LAT;
const METERS_PER_DEGREE_LAT = KM_PER_DEGREE_LAT_LOCAL * 1000;

/**
 * Metres per degree of longitude at this latitude. Floored at cos(80°) so a
 * near-polar corridor stays finite; the same 0.2-style guard bboxToCenterRadius
 * uses, for the same reason.
 */
function metersPerDegreeLng(lat: number): number {
  const cos = Math.cos((lat * Math.PI) / 180);
  return METERS_PER_DEGREE_LAT * Math.max(0.05, Math.abs(cos));
}

/**
 * Local equirectangular projection to metres, anchored at `originLat`.
 *
 * Legitimate over a corridor: the scan is bounded to a route the viewer is
 * actually travelling, where the distortion of treating lat/lng as a plane is
 * far below the corridor's own tolerance. Haversine per segment per object
 * would be measurably slower and no more correct at this scale.
 */
function toLocalMeters(p: LatLng, originLat: number): { x: number; y: number } {
  return { x: p.lng * metersPerDegreeLng(originLat), y: p.lat * METERS_PER_DEGREE_LAT };
}

/**
 * Perpendicular distance from `p` to the segment a→b, plus how far along that
 * segment the closest point lies. All metres, all in the local plane.
 */
function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { distance: number; along: number; segmentLength: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen = Math.sqrt(dx * dx + dy * dy);
  if (segLen === 0) {
    const d = Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
    return { distance: d, along: 0, segmentLength: 0 };
  }
  // Projection parameter, clamped to the segment: past an endpoint the nearest
  // point IS the endpoint, which is what keeps the corridor from extending
  // beyond the ends of the route.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (segLen * segLen)));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return {
    distance: Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2),
    along: t * segLen,
    segmentLength: segLen,
  };
}

export interface PolylineDistance {
  /** Perpendicular distance to the nearest point on the polyline, metres. */
  offsetMeters: number;
  /** Distance from the polyline's start to that nearest point, metres. */
  alongMeters: number;
}

/** Distance from a point to a polyline, and how far along the line it attaches. */
export function distanceToPolylineMeters(point: LatLng, path: readonly LatLng[]): PolylineDistance | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  if (!Array.isArray(path) || path.length < 2) return null;

  const originLat = path[0]!.lat;
  const p = toLocalMeters(point, originLat);

  let best: PolylineDistance | null = null;
  let travelled = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = toLocalMeters(path[i]!, originLat);
    const b = toLocalMeters(path[i + 1]!, originLat);
    const seg = distanceToSegment(p, a, b);
    if (best === null || seg.distance < best.offsetMeters) {
      best = { offsetMeters: seg.distance, alongMeters: travelled + seg.along };
    }
    travelled += seg.segmentLength;
  }
  return best;
}

/** The bbox that contains the corridor: the polyline's extent, padded by `meters`. */
export function corridorBBox(corridor: Corridor): BBox | null {
  const { path, meters } = corridor;
  if (!Array.isArray(path) || path.length < 2) return null;

  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const p of path) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }

  const padLat = meters / METERS_PER_DEGREE_LAT;
  // Pad longitude at the WIDEST latitude the box reaches, so the pad is never
  // narrower than the corridor at any point inside it.
  const worstLat = Math.max(Math.abs(south), Math.abs(north));
  const padLng = meters / metersPerDegreeLng(worstLat);

  return {
    south: Math.max(-90, south - padLat),
    north: Math.min(90, north + padLat),
    west: Math.max(-180, west - padLng),
    east: Math.min(180, east + padLng),
  };
}

// ── Detour cost ───────────────────────────────────────────────────────────────

/**
 * The cost of stepping off the route for this object and coming back: twice the
 * perpendicular offset, at walking pace, rounded UP to the minute (a rounded-
 * down detour is an under-promise the traveller pays for).
 */
export function detourCost(d: PolylineDistance): DetourCost {
  const offsetMeters = Math.round(d.offsetMeters);
  const extraMeters = offsetMeters * 2;
  const metersPerMinute = (CORRIDOR_WALKING_SPEED_KMH * 1000) / 60;
  return {
    offsetMeters,
    extraMeters,
    extraMinutes: Math.ceil(extraMeters / metersPerMinute),
    alongMeters: Math.round(d.alongMeters),
    basis: "straight_line_estimate",
  };
}

/**
 * The rendered detour line. "Est." is not politeness — §37 forbids dressing a
 * computation as an observation, and this string is the only part of the cost a
 * user ever sees. A zero-minute detour says "On your route" rather than
 * "Est. +0 min", because +0 reads as a measurement of nothing.
 */
export function detourLine(cost: DetourCost): string {
  const off = cost.offsetMeters < 1000
    ? `${cost.offsetMeters} m off route`
    : `${(cost.offsetMeters / 1000).toFixed(1)} km off route`;
  if (cost.extraMinutes <= 0) return `On your route · ${off}`;
  return `Est. +${cost.extraMinutes} min detour · ${off}`;
}

// ── The filter ────────────────────────────────────────────────────────────────

/**
 * Keep the objects within the corridor, preserving input order.
 *
 * ORDER IS THE CONTRACT. The gateway has already ranked by the §31 ladder; a
 * corridor that re-sorted by offset would quietly demote a safety notice below
 * a café because the café is nearer the line. So this only ever REMOVES, and
 * `matches[i]` belongs to `objects[i]`.
 *
 * An object whose geometry yields no centroid is DROPPED, not kept: without a
 * position there is no honest answer to "is it on my way", and keeping it would
 * mean showing an "Est. +0 min detour" for something we cannot place.
 */
export function filterToCorridor(
  objects: readonly MapObject[],
  corridor: Corridor,
): CorridorFilterResult {
  const kept: MapObject[] = [];
  const matches: CorridorMatch[] = [];
  let droppedOffRoute = 0;
  let droppedNoGeometry = 0;

  for (const obj of objects) {
    const c = centroidOf(obj.geometry);
    if (!c) {
      droppedNoGeometry += 1;
      continue;
    }
    const d = distanceToPolylineMeters(c, corridor.path);
    if (!d) {
      droppedNoGeometry += 1;
      continue;
    }
    if (d.offsetMeters > corridor.meters) {
      droppedOffRoute += 1;
      continue;
    }
    const cost = detourCost(d);
    kept.push(obj);
    matches.push({ objectId: obj.id, detour: cost, line: detourLine(cost) });
  }

  return { objects: kept, matches, droppedOffRoute, droppedNoGeometry };
}

/**
 * What the corridor did, for the response envelope.
 *
 * Counts only, deliberately. "Which objects were dropped" would describe the
 * shape of what is NEAR the viewer's route but not on it — a second, sharper
 * statement about the same viewport — and the gateway's other reports
 * (`protection`, `aggregation.suppressedForKAnonymity`) already settled that
 * question the same way: enough to prove filtering happened, never enough to
 * reconstruct what was filtered.
 */
export interface CorridorReport {
  /** Null when the corridor ran; otherwise why it did not. */
  refusal: "flag_off" | "invalid_corridor" | null;
  meters: number | null;
  points: number | null;
  considered: number;
  kept: number;
  droppedOffRoute: number;
  droppedNoGeometry: number;
}
