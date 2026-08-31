/**
 * mapAggregation — the SERVER half of Map spec §31's
 * "viewport queries, server aggregation, client clustering and render thresholds".
 *
 * Before this module the server had no spatial index and no aggregation at all:
 * routes/mapSearch.ts did ad-hoc degree-delta bbox arithmetic inline and every
 * collapse happened client-side at render time. That is exactly backwards for
 * §23 — a client that receives a field of individual presence pins has already
 * been told where each stranger is, whatever it chooses to draw. Aggregation
 * has to happen before serialization, so it happens here.
 *
 * WHERE THIS SITS (spec §19):
 *
 *     Canonical Systems → Map Projection Service → Map Objects → Map Ranking
 *       → Privacy / Eligibility → **Viewport Aggregation** → Mobile Renderer
 *
 * Privacy / Eligibility runs BEFORE this stage. That ordering is a one-way
 * constraint and every function here honours it: aggregation may only ever
 * REDUCE precision. It never re-derives an exact coordinate, never widens a
 * privacyClass (only `narrowestPrivacyClass`), never upgrades a confidence band
 * or a freshness state, and never re-attaches contributor identifiers. The same
 * contract note that governs lib/mapSearch.ts applies verbatim: this module
 * never sharpens what a source already decided to expose.
 *
 * PURE. No DB, no I/O, no clock of its own (`now` is always injectable), no
 * privacy DECISIONS beyond suppression — it can withhold, never permit.
 *
 * The k floor is not invented here. It is
 * `PRIVACY_THRESHOLD_V1.minUniqueActors` from lib/intelContracts.ts (the value
 * lib/privacyGate.ts and lib/intelProjectionAggregator.ts already gate on), so
 * the map cannot become a second, looser publisher of the same cohorts — the
 * mistake privacyGate.ts's own header records about CompassGraphEngine.
 */
import {
  bboxPolygon,
  centroidOf,
  compareByRenderingPriority,
  isServable,
  narrowestPrivacyClass,
  ACTIVITY_LEVELS,
  CONFIDENCE_STATES,
  FRESHNESS_STATES,
  KIND_DEFAULT_PRIORITY,
  TREND_STATES,
  mayRenderAsLive,
  deriveFreshness,
  type ActivityLevel,
  type ConfidenceState,
  type FreshnessState,
  type MapObject,
  type MapObjectKind,
  type PolygonGeometry,
  type PrivacyClass,
  type TrendState,
} from "./mapObjects.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";
import { evaluatePrivacy, type PrivacyThreshold, type SuppressionReason } from "./privacyGate.js";
import { meetsKAnonymity } from "./kAnonymity.js";

// ── Geodesy primitives ────────────────────────────────────────────────────────

/** Axis-aligned viewport rectangle. `west > east` means it crosses the antimeridian. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Mean km per degree of latitude (WGS84 mean meridian degree). */
export const KM_PER_DEGREE_LAT = 111.32;

/** The Web Mercator latitude limit; beyond it the projection is undefined. */
export const MERCATOR_MAX_LAT = 85.05112878;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Fold any longitude into [-180, 180). 180 normalizes to -180 so cells never double-count the seam. */
export function normalizeLng(lng: number): number {
  if (!finite(lng)) return Number.NaN;
  // Already in range: return it UNCHANGED. The modular form below is only exact
  // for a handful of values (108.2 comes back as 108.20000000000005), and a
  // normalizer that perturbs a coordinate it did not need to touch would put
  // float noise into every emitted geometry.
  if (lng >= -180 && lng < 180) return lng;
  return (((lng + 180) % 360) + 360) % 360 - 180;
}

/** Clamp a latitude into [-90, 90]. */
export function clampLat(lat: number): number {
  if (!finite(lat)) return Number.NaN;
  return lat < -90 ? -90 : lat > 90 ? 90 : lat;
}

/**
 * Is (lat, lng) inside `bbox`? Fail-closed: a malformed bbox or coordinate is
 * NOT contained, so a broken viewport shows nothing rather than everything.
 *
 * Antimeridian: a bbox whose `west` is greater than its `east` is understood to
 * WRAP through ±180 (e.g. Fiji, or a Pacific-centred viewport), and longitude
 * containment becomes a union rather than an interval.
 */
export function bboxContains(bbox: BBox | null | undefined, lat: number, lng: number): boolean {
  if (!bbox) return false;
  if (!finite(bbox.west) || !finite(bbox.east) || !finite(bbox.south) || !finite(bbox.north)) return false;
  if (!finite(lat) || !finite(lng)) return false;
  if (bbox.south > bbox.north) return false;
  if (lat < bbox.south || lat > bbox.north) return false;

  const w = normalizeLng(bbox.west);
  const e = normalizeLng(bbox.east);
  const p = normalizeLng(lng);
  // A bbox that spans the whole planet in longitude (west === east after
  // normalization only happens for a full turn) contains every longitude.
  if (bbox.east - bbox.west >= 360) return true;
  return w <= e ? p >= w && p <= e : p >= w || p <= e;
}

/**
 * A bbox around a centre point. Longitude degrees shrink with latitude, so the
 * east/west delta is divided by cos(lat); near the poles that blows up, and
 * rather than emit a nonsense rectangle we widen to the FULL longitude range —
 * coarser, never sharper.
 *
 * Latitude is clamped at the poles (no wrap-over-the-top), longitudes are
 * normalized, and a span that has grown to a full turn is returned as
 * -180..180 rather than as a wrapping bbox.
 */
export function bboxFromCenterRadius(lat: number, lng: number, radiusKm: number): BBox | null {
  if (!finite(lat) || !finite(lng) || !finite(radiusKm) || radiusKm < 0) return null;
  if (lat < -90 || lat > 90) return null;

  const dLat = radiusKm / KM_PER_DEGREE_LAT;
  const south = clampLat(lat - dLat);
  const north = clampLat(lat + dLat);

  const cos = Math.cos((lat * Math.PI) / 180);
  // cos(±90°) is ~6e-17, not 0 — treat anything below this as "no usable
  // longitude scale" and take the whole parallel.
  const dLng = Math.abs(cos) < 1e-6 ? 180 : radiusKm / (KM_PER_DEGREE_LAT * Math.abs(cos));
  if (!Number.isFinite(dLng) || dLng >= 180) {
    return { west: -180, south, east: 180, north };
  }
  return {
    west: normalizeLng(lng - dLng),
    south,
    east: normalizeLng(lng + dLng),
    north,
  };
}

/** Integer Web Mercator (slippy-map) tile containing a coordinate. */
export interface TileRef {
  x: number;
  y: number;
  zoom: number;
}

/**
 * lat/lng → Web Mercator tile at `zoom`. Latitude is clamped to the Mercator
 * limit (±85.05112878) so a pole-adjacent coordinate lands in the top/bottom
 * tile row instead of producing Infinity. Fail-closed: invalid input → null.
 */
export function lngLatToTile(lat: number, lng: number, zoom: number): TileRef | null {
  if (!finite(lat) || !finite(lng) || !finite(zoom)) return null;
  if (zoom < 0 || zoom > 24) return null;
  const z = Math.floor(zoom);
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((normalizeLng(lng) + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)), zoom: z };
}

/** Web Mercator tile → its NORTH-WEST corner in lat/lng. Inverse of `lngLatToTile`. */
export function tileToLngLat(x: number, y: number, zoom: number): { lat: number; lng: number } | null {
  if (!finite(x) || !finite(y) || !finite(zoom)) return null;
  if (zoom < 0 || zoom > 24) return null;
  const z = Math.floor(zoom);
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;
  const lng = (Math.floor(x) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * Math.floor(y)) / n)));
  return { lat: (latRad * 180) / Math.PI, lng };
}

// ── The zoom model (spec §17) ─────────────────────────────────────────────────

/**
 * Spec §17's five render bands.
 *
 *   world     Countries visited, upcoming Trips, Passport, major destinations;
 *             NO POI pins.
 *   city      Neighborhoods, activity zones, major events, major flow.
 *   district  Live places, events, gems, social opportunities, Trip objects.
 *   street    Individual places, entrances, authorized crew, meeting points.
 *   venue     Stages, entrances, checkpoints, group members, meeting zones.
 */
export const ZOOM_BANDS = ["world", "city", "district", "street", "venue"] as const;
export type ZoomBand = (typeof ZOOM_BANDS)[number];

/** Inclusive integer zoom ranges per band (standard slippy-map zoom 0..22). */
export const ZOOM_BAND_RANGES: Record<ZoomBand, { minZoom: number; maxZoom: number }> = {
  world: { minZoom: 0, maxZoom: 5 },
  city: { minZoom: 6, maxZoom: 11 },
  district: { minZoom: 12, maxZoom: 14 },
  street: { minZoom: 15, maxZoom: 17 },
  venue: { minZoom: 18, maxZoom: 22 },
};

/**
 * §17 + §31: "At wide zoom, many places should collapse into an area summary or
 * activity zone." Only `world` and `city` aggregate; `district` and below return
 * individual objects.
 */
export const AGGREGATING_BANDS: readonly ZoomBand[] = ["world", "city"];

/**
 * Which band a zoom belongs to. FAIL-CLOSED: a missing, non-finite or negative
 * zoom is treated as `world` — the widest band, therefore the most aggregation
 * and the least precision. A broken zoom must never buy individual pins.
 */
export function zoomBandFor(zoom: number | null | undefined): ZoomBand {
  if (!finite(zoom)) return "world";
  const z = Math.floor(zoom);
  if (z < 0) return "world";
  for (const band of ZOOM_BANDS) {
    const range = ZOOM_BAND_RANGES[band];
    if (z >= range.minZoom && z <= range.maxZoom) return band;
  }
  // Above the table (z > 22) is the most zoomed-in state there is.
  return "venue";
}

export function bandAggregates(band: ZoomBand): boolean {
  return AGGREGATING_BANDS.includes(band);
}

/**
 * THE ZOOM → CELL-SIZE TABLE.
 *
 * The aggregation grid is a plain lat/lng degree grid anchored at (-180, -90),
 * with the cell edge halving at each zoom step. The sizes are exactly
 * `360 / 2^zoom` — one Web Mercator tile column wide — which makes every value
 * an exact binary fraction (no float drift, so a cell key computed twice is
 * always the same string, and paging stays stable).
 *
 *   zoom   cell edge (deg)        band       ~edge at the equator
 *   ────   ────────────────────   ────────   ────────────────────
 *     0    360                    world      whole planet, 1 cell
 *     1    180                    world      ~20 000 km
 *     2     90                    world      ~10 000 km
 *     3     45                    world      ~5 000 km
 *     4     22.5                  world      ~2 500 km
 *     5     11.25                 world      ~1 250 km
 *     6      5.625                city       ~626 km
 *     7      2.8125               city       ~313 km
 *     8      1.40625              city       ~156 km
 *     9      0.703125             city       ~78 km
 *    10      0.3515625            city       ~39 km
 *    11      0.17578125           city       ~19.5 km
 *   ≥12      null                 district+  no aggregation — individual objects
 *
 * A degree grid (rather than a Mercator tile grid) keeps cell polygons valid at
 * every latitude, and it errs the safe way near the poles: the same degree cell
 * covers less ground there, so it holds fewer contributors and is more likely to
 * fall under the k floor and be suppressed.
 */
export const CELL_SIZE_DEGREES_BY_ZOOM: readonly (number | null)[] = [
  360, 180, 90, 45, 22.5, 11.25, 5.625, 2.8125, 1.40625, 0.703125, 0.3515625, 0.17578125,
  null, null, null, null, null, null, null, null, null, null, null,
];

/**
 * Cell edge in degrees for a zoom, or null when that zoom does not aggregate.
 * FAIL-CLOSED: an invalid zoom falls back to the coarsest cell (zoom 0), which
 * aggregates the hardest.
 */
export function cellSizeDegreesFor(zoom: number | null | undefined): number | null {
  if (!finite(zoom)) return CELL_SIZE_DEGREES_BY_ZOOM[0] as number;
  const z = Math.floor(zoom);
  if (z < 0) return CELL_SIZE_DEGREES_BY_ZOOM[0] as number;
  if (z >= CELL_SIZE_DEGREES_BY_ZOOM.length) return null;
  return CELL_SIZE_DEGREES_BY_ZOOM[z] ?? null;
}

/** A grid cell: its integer index pair, its size, and its rectangle. */
export interface GridCell {
  key: string;
  x: number;
  y: number;
  sizeDegrees: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The grid cell containing a coordinate at `zoom`. Returns null when that zoom
 * does not aggregate or the coordinate is unusable.
 *
 * The cell is snapped to the grid, so it is always a SUPERSET of the point it
 * contains — snapping can only ever coarsen, never localize.
 */
export function cellFor(lat: number, lng: number, zoom: number): GridCell | null {
  const size = cellSizeDegreesFor(zoom);
  if (size == null || !finite(lat) || !finite(lng)) return null;
  if (lat < -90 || lat > 90) return null;

  const nl = normalizeLng(lng);
  // Nudge the north pole off the grid boundary so lat 90 lands in the top row
  // rather than in a zero-height cell above it.
  const latForIndex = Math.min(lat, 90 - 1e-9);
  const x = Math.floor((nl + 180) / size);
  const y = Math.floor((latForIndex + 90) / size);
  const west = -180 + x * size;
  const south = -90 + y * size;
  return {
    key: `${Math.floor(zoom)}/${x}/${y}`,
    x,
    y,
    sizeDegrees: size,
    west,
    south,
    east: Math.min(180, west + size),
    north: Math.min(90, south + size),
  };
}

/** The cell rectangle as a closed GeoJSON polygon ring. */
export function cellPolygon(cell: GridCell): PolygonGeometry {
  return bboxPolygon(cell.west, cell.south, cell.east, cell.north);
}

// ── The k floor ───────────────────────────────────────────────────────────────

/**
 * THE COHORT MINIMUM for anything this module publishes.
 *
 * NOT a new number: it is `PRIVACY_THRESHOLD_V1.minUniqueActors` (15) from
 * lib/intelContracts.ts — the same k that lib/privacyGate.ts enforces and that
 * lib/intelProjectionAggregator.ts counts `distinctActors` for. Deriving it
 * rather than restating it means a change to the product threshold reaches the
 * map automatically, and the map can never become the loosest publisher of a
 * cohort the intel pipeline already refuses to publish.
 */
export const MIN_ZONE_COHORT: number = PRIVACY_THRESHOLD_V1.minUniqueActors;

/**
 * Resolve the k to enforce. An override may only ever TIGHTEN (`max`), because
 * a stage that runs after Privacy / Eligibility must not be able to relax it.
 * An invalid override returns NaN, which `meetsKAnonymity` fail-closes on.
 */
export function resolveCohortFloor(k?: number | null): number {
  if (k == null) return MIN_ZONE_COHORT;
  if (!finite(k) || k < 1) return Number.NaN;
  return Math.max(MIN_ZONE_COHORT, k);
}

/**
 * How many distinct subjects one object stands for.
 *
 * `count` present and a positive integer → that many. `count` absent → 1 (the
 * object itself). `count` present but unusable (NaN, negative, fractional,
 * Infinity) → `null`, meaning UNKNOWN — and an unknown poisons its whole cell,
 * which is then suppressed. "Fail closed when contributor counts are unknown"
 * is not a rounding decision; a wrong count is a k=1 leak.
 */
export function cohortWeightOf(obj: MapObject): number | null {
  if (obj.count === undefined || obj.count === null) return 1;
  if (!finite(obj.count)) return null;
  if (!Number.isInteger(obj.count) || obj.count < 1) return null;
  return obj.count;
}

/** Total cohort a set of contributors stands for, or null if any count is unknown. */
export function cohortSizeOf(objects: readonly MapObject[]): number | null {
  let total = 0;
  for (const obj of objects) {
    const w = cohortWeightOf(obj);
    if (w == null) return null;
    total += w;
  }
  return total;
}

// ── Kinds that are never collapsed ────────────────────────────────────────────

/**
 * §31 puts Safety and Trip Crew at the top of the priority ladder and §5 says
 * "Safety and active navigation always take visual precedence over popularity
 * or activity". Folding a safety notice into an activity zone would DELETE it,
 * so these kinds pass through individually at every zoom.
 *
 * `crowd_flow` is excluded because it is already an aggregate with its own §10
 * gates — re-aggregating it into an area summary would destroy the observed /
 * inferred separation those gates exist to preserve.
 */
export const NEVER_AGGREGATED_KINDS: readonly MapObjectKind[] = [
  "safety_notice",
  "crew_member",
  "meeting_point",
  "crowd_flow",
];

export function isNeverAggregated(kind: MapObjectKind): boolean {
  return NEVER_AGGREGATED_KINDS.includes(kind);
}

// ── Weakest-wins folds ────────────────────────────────────────────────────────

/** CONFIDENCE_STATES is ordered weakest → strongest, so index is the band rank. */
function confidenceRank(c: ConfidenceState): number {
  const i = CONFIDENCE_STATES.indexOf(c);
  return i < 0 ? 0 : i;
}

/**
 * The WEAKEST contributing band. An aggregate is never more certain than its
 * evidence, so this takes the minimum, and a contributor carrying NO band at
 * all counts as the weakest band there is — silence must not be read as
 * agreement. If no contributor carries a band, the aggregate asserts nothing
 * (undefined) rather than claiming the floor as a finding.
 */
export function weakestConfidence(objects: readonly MapObject[]): ConfidenceState | undefined {
  let sawAny = false;
  let worst: ConfidenceState | undefined;
  for (const obj of objects) {
    const c = obj.confidence;
    if (c !== undefined && CONFIDENCE_STATES.includes(c)) {
      sawAny = true;
      if (worst === undefined || confidenceRank(c) < confidenceRank(worst)) worst = c;
    } else {
      // Unknown confidence is treated as the weakest band, but only counts once
      // at least one real band exists to be dragged down.
      worst = CONFIDENCE_STATES[0] as ConfidenceState;
    }
  }
  return sawAny ? worst : undefined;
}

/**
 * Staleness rank — higher is older/less trustworthy. `unknown` ranks ABOVE
 * `historical`: not knowing when something was observed is the weakest possible
 * position, and §37 forbids letting a stale claim read as live.
 */
export const FRESHNESS_STALENESS_RANK: Record<FreshnessState, number> = {
  live: 0,
  recent: 1,
  aging: 2,
  stale: 3,
  historical: 4,
  unknown: 5,
};

/**
 * The OLDEST contributing freshness state. A contributor with no freshness at
 * all contributes `unknown`, which dominates everything — an aggregate whose
 * inputs cannot be dated is never rendered live.
 */
export function oldestFreshness(objects: readonly MapObject[]): FreshnessState {
  let worst: FreshnessState = "live";
  let sawAny = false;
  for (const obj of objects) {
    sawAny = true;
    const f = obj.freshness;
    const state: FreshnessState =
      f !== undefined && FRESHNESS_STATES.includes(f) ? f : "unknown";
    if (FRESHNESS_STALENESS_RANK[state] > FRESHNESS_STALENESS_RANK[worst]) worst = state;
  }
  return sawAny ? worst : "unknown";
}

/**
 * Fold `narrowestPrivacyClass` across contributors. Combining can only tighten;
 * a contributor with a missing or unrecognized class contributes `none`, which
 * makes the whole aggregate unservable — the fail-closed answer.
 */
export function foldPrivacyClass(objects: readonly MapObject[]): PrivacyClass {
  if (objects.length === 0) return "none";
  let cls: PrivacyClass = "precise_temporary";
  for (const obj of objects) {
    const c = obj.privacyClass;
    const safe: PrivacyClass =
      c === "aggregate_only" ||
      c === "approximate" ||
      c === "place_level" ||
      c === "precise_temporary" ||
      c === "none"
        ? c
        : "none";
    cls = narrowestPrivacyClass(cls, safe);
  }
  return cls;
}

// ── Activity + trend derivation ───────────────────────────────────────────────

/**
 * Density ladder, expressed as MULTIPLES OF THE K FLOOR rather than as absolute
 * headcounts, so the labels move with the privacy threshold instead of drifting
 * away from it. At k = 15 that reads: 15 → Quiet, 30 → Moderate, 60 → Busy,
 * 120 → Very Busy, 240 → Peak. A barely-publishable cell says "quiet", which is
 * the honest thing for a cohort that only just cleared suppression.
 */
export const ACTIVITY_COHORT_MULTIPLES: readonly { atLeast: number; level: ActivityLevel }[] = [
  { atLeast: 16, level: "peak" },
  { atLeast: 8, level: "very_busy" },
  { atLeast: 4, level: "busy" },
  { atLeast: 2, level: "moderate" },
  { atLeast: 1, level: "quiet" },
];

/** Activity level for a cohort of `cohort` subjects against floor `k`. */
export function activityForCohort(cohort: number, k: number = MIN_ZONE_COHORT): ActivityLevel {
  if (!finite(cohort) || !finite(k) || k < 1 || cohort < 0) return "very_quiet";
  const ratio = cohort / k;
  for (const step of ACTIVITY_COHORT_MULTIPLES) {
    if (ratio >= step.atLeast) return step.level;
  }
  return ACTIVITY_LEVELS[0] as ActivityLevel;
}

/**
 * The aggregate trend, or undefined.
 *
 * A trend is only asserted when the INPUTS ACTUALLY CARRY ONE, and when the
 * contributors that carry one are themselves a publishable cohort — a "getting
 * busier" derived from three people is both a weak claim and a privacy leak
 * about those three. Ties resolve toward `stable` (the least eventful reading)
 * and then by TREND_STATES order, so the result is fully deterministic.
 */
export function aggregateTrend(
  objects: readonly MapObject[],
  k: number = MIN_ZONE_COHORT,
): TrendState | undefined {
  const carriers = objects.filter(
    (o) => o.trend !== undefined && TREND_STATES.includes(o.trend),
  );
  if (carriers.length === 0) return undefined;

  const carrierCohort = cohortSizeOf(carriers);
  if (carrierCohort == null || !meetsKAnonymity(carrierCohort, k)) return undefined;

  const tally = new Map<TrendState, number>();
  for (const o of carriers) {
    const t = o.trend as TrendState;
    tally.set(t, (tally.get(t) ?? 0) + (cohortWeightOf(o) ?? 0));
  }
  let best: TrendState | undefined;
  let bestN = -1;
  for (const t of TREND_STATES) {
    const n = tally.get(t) ?? 0;
    if (n === 0) continue;
    if (n > bestN) {
      best = t;
      bestN = n;
    } else if (n === bestN && best !== undefined && best !== "stable" && t === "stable") {
      best = "stable";
    }
  }
  return best;
}

// ── Cell summarization ────────────────────────────────────────────────────────

/** Nouns for the aggregate headline, chosen from the dominant contributing kind. */
const KIND_NOUNS: Partial<Record<MapObjectKind, string>> = {
  social_zone: "travelers",
  buddy_zone: "travelers",
  crew_member: "travelers",
  activity_zone: "travelers",
  place: "places",
  hidden_gem: "places",
  trip_stop: "places",
  memory: "places",
  event: "events",
  prediction: "signals",
};

function dominantNoun(objects: readonly MapObject[]): string {
  const tally = new Map<string, number>();
  for (const o of objects) {
    const noun = KIND_NOUNS[o.kind] ?? "signals";
    tally.set(noun, (tally.get(noun) ?? 0) + (cohortWeightOf(o) ?? 0));
  }
  let best = "signals";
  let bestN = -1;
  // Deterministic: highest weight wins, alphabetical id break.
  for (const noun of [...tally.keys()].sort()) {
    const n = tally.get(noun) as number;
    if (n > bestN) {
      best = noun;
      bestN = n;
    }
  }
  return best;
}

export interface SummarizeCellOptions {
  /** The grid cell this summary stands for. Preferred — it is already snapped. */
  cell?: GridCell;
  /** Used to derive the cell when `cell` is not supplied. */
  zoom?: number;
  /** Cohort floor override. May only tighten (see `resolveCohortFloor`). */
  k?: number;
  /** Prefix for the synthesized id; ids stay stable across calls. */
  idPrefix?: string;
}

/**
 * Collapse the contributors of ONE cell into a single `activity_zone`.
 *
 * Returns `null` — suppression, not a smaller zone — whenever the cell cannot
 * be published: cohort below k, an unknown contributor count, an unusable
 * privacy class, no derivable cell, or no contributors. §23's whole point is
 * that the default public rendering is "18 travelers active around this area";
 * a zone drawn around fewer people than the floor is a pin with extra steps.
 *
 * Every derived field takes the conservative side: weakest confidence, oldest
 * freshness, narrowest privacy class, trend only when the inputs carry one.
 * No contributor id ever reaches `sourceRefs` or `provenance`.
 */
export function summarizeCell(
  objects: readonly MapObject[],
  options: SummarizeCellOptions = {},
): MapObject | null {
  const contributors = objects.filter((o) => isServable(o));
  if (contributors.length === 0) return null;

  const k = resolveCohortFloor(options.k);
  const cohort = cohortSizeOf(contributors);
  // Unknown cohort → suppress. Never guess a headcount.
  if (cohort == null) return null;
  if (!meetsKAnonymity(cohort, k)) return null;

  const cell = options.cell ?? deriveCellFromContributors(contributors, options.zoom);
  if (!cell) return null;

  const privacyClass = foldPrivacyClass(contributors);
  if (privacyClass === "none") return null;

  const confidence = weakestConfidence(contributors);
  const freshness = oldestFreshness(contributors);
  const trend = aggregateTrend(contributors, k);
  const activity = activityForCohort(cohort, k);
  const noun = dominantNoun(contributors);

  const observedAt = oldestTimestamp(contributors.map((o) => o.observedAt));
  const expiresAt = earliestTimestamp(contributors.map((o) => o.expiresAt));

  const zone: MapObject = {
    id: `${options.idPrefix ?? "az"}:${cell.key}`,
    kind: "activity_zone",
    geometry: cellPolygon(cell),
    title:
      noun === "travelers"
        ? `${cohort} travelers active around this area`
        : `${cohort} ${noun} in this area`,
    subtitle: humanizeActivity(activity),
    freshness,
    activity,
    privacyClass,
    renderingPriority: KIND_DEFAULT_PRIORITY.activity_zone,
    count: cohort,
    interaction: { actions: ["ask_compass", "view"], opensSheet: true },
    // Deliberately NO sourceRefs: a reference list on an aggregate is a
    // re-identification handle back onto the contributors.
    provenance: {
      lines: [{ text: `Aggregated from ${contributors.length} nearby signals` }],
      confidence: confidence ?? (CONFIDENCE_STATES[0] as ConfidenceState),
    },
  };
  if (confidence !== undefined) zone.confidence = confidence;
  if (trend !== undefined) zone.trend = trend;
  if (observedAt) zone.observedAt = observedAt;
  if (expiresAt) zone.expiresAt = expiresAt;
  return zone;
}

/**
 * Derive a cell when the caller did not supply one: the UNION of the snapped
 * grid cells the contributors fall in. Never a tight bounding box of the
 * contributors — that would be sharper than the grid and would leak position.
 */
function deriveCellFromContributors(
  contributors: readonly MapObject[],
  zoom: number | undefined,
): GridCell | null {
  const size = cellSizeDegreesFor(zoom);
  if (size == null) return null;
  const z = finite(zoom) ? Math.floor(zoom as number) : 0;

  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let firstKey: string | null = null;
  let count = 0;

  for (const o of contributors) {
    const c = centroidOf(o.geometry);
    if (!c) continue;
    const cell = cellFor(c.lat, c.lng, z);
    if (!cell) continue;
    if (firstKey === null) firstKey = cell.key;
    west = Math.min(west, cell.west);
    south = Math.min(south, cell.south);
    east = Math.max(east, cell.east);
    north = Math.max(north, cell.north);
    count += 1;
  }
  if (count === 0 || firstKey === null) return null;
  return {
    key: firstKey,
    x: Math.round((west + 180) / size),
    y: Math.round((south + 90) / size),
    sizeDegrees: size,
    west,
    south,
    east,
    north,
  };
}

function humanizeActivity(a: ActivityLevel): string {
  return a
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function tsMs(t: string | undefined): number | null {
  if (!t) return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function oldestTimestamp(values: (string | undefined)[]): string | undefined {
  let best: number | null = null;
  for (const v of values) {
    const ms = tsMs(v);
    if (ms == null) continue;
    if (best === null || ms < best) best = ms;
  }
  return best === null ? undefined : new Date(best).toISOString();
}

function earliestTimestamp(values: (string | undefined)[]): string | undefined {
  return oldestTimestamp(values);
}

// ── Viewport aggregation ──────────────────────────────────────────────────────

export interface ViewportRequest {
  bbox: BBox;
  zoom: number;
  /** Cohort floor override; may only tighten. */
  k?: number;
}

export interface ViewportAggregation {
  /** What the renderer receives, in stable rendering-priority order. */
  objects: MapObject[];
  /** INPUT objects that were collapsed into an emitted activity_zone. */
  aggregated: number;
  /** INPUT objects returned as themselves. */
  individual: number;
  /**
   * INPUT objects that reached no output at all — outside the viewport,
   * unservable, or withheld by the k floor. NEVER a silent truncation: the
   * route can report this, and `suppressedForKAnonymity` says how much of it
   * was a privacy decision rather than a viewport miss.
   */
  dropped: number;
  /** Subset of `dropped` withheld because a cell fell below the cohort floor. */
  suppressedForKAnonymity: number;
  /** Number of activity_zone summaries emitted. */
  zones: number;
  /** Cells that produced no zone, with a machine-readable reason. */
  suppressedCells: { key: string; contributors: number; reason: "below_cohort_floor" }[];
  band: ZoomBand;
  cellSizeDegrees: number | null;
}

/**
 * §31: viewport query + server aggregation.
 *
 * At `world` and `city` the bulk of the objects collapse into `activity_zone`
 * summaries on a deterministic degree grid; at `district` and below the
 * individual objects are returned. Safety, crew, meeting points and existing
 * crowd flows pass through individually at every zoom
 * (`NEVER_AGGREGATED_KINDS`).
 *
 * Nothing is ever silently truncated: every input object is accounted for
 * exactly once as `aggregated`, `individual` or `dropped`, and that invariant
 * is what the caller can report.
 *
 * FAIL-CLOSED: an invalid zoom is treated as `world` (maximum aggregation), and
 * an invalid bbox contains nothing, so a malformed request returns an empty map
 * rather than the planet.
 */
export function aggregateForViewport(
  objects: readonly MapObject[],
  request: ViewportRequest,
): ViewportAggregation {
  const band = zoomBandFor(request?.zoom);
  const zoom = finite(request?.zoom) ? Math.floor(request.zoom) : 0;
  const cellSizeDegrees = bandAggregates(band) ? cellSizeDegreesFor(zoom) : null;
  const k = request?.k;

  const empty: ViewportAggregation = {
    objects: [],
    aggregated: 0,
    individual: 0,
    dropped: Array.isArray(objects) ? objects.length : 0,
    suppressedForKAnonymity: 0,
    zones: 0,
    suppressedCells: [],
    band,
    cellSizeDegrees,
  };
  if (!Array.isArray(objects) || objects.length === 0) {
    return { ...empty, dropped: Array.isArray(objects) ? objects.length : 0 };
  }

  // 1. Viewport + servability filter. Anything that fails is DROPPED, counted.
  const inView: MapObject[] = [];
  let dropped = 0;
  for (const obj of objects) {
    if (!isServable(obj)) {
      dropped += 1;
      continue;
    }
    const c = centroidOf(obj.geometry);
    if (!c || !bboxContains(request?.bbox, c.lat, c.lng)) {
      dropped += 1;
      continue;
    }
    inView.push(obj);
  }

  // 2. Below the aggregating bands, individual objects are the answer (§17).
  if (!bandAggregates(band)) {
    const sorted = [...inView].sort(compareByRenderingPriority);
    return {
      objects: sorted,
      aggregated: 0,
      individual: sorted.length,
      dropped,
      suppressedForKAnonymity: 0,
      zones: 0,
      suppressedCells: [],
      band,
      cellSizeDegrees,
    };
  }

  // 3. Split off the kinds that must never be collapsed.
  const passthrough: MapObject[] = [];
  const collapsible: MapObject[] = [];
  for (const obj of inView) {
    (isNeverAggregated(obj.kind) ? passthrough : collapsible).push(obj);
  }

  // 4. Bin the rest onto the grid. Map preserves insertion order; cell keys are
  //    sorted before summarizing so ids and ordering are input-order independent.
  const bins = new Map<string, { cell: GridCell; members: MapObject[] }>();
  for (const obj of collapsible) {
    const c = centroidOf(obj.geometry);
    const cell = c ? cellFor(c.lat, c.lng, zoom) : null;
    if (!cell) {
      dropped += 1;
      continue;
    }
    const bin = bins.get(cell.key);
    if (bin) bin.members.push(obj);
    else bins.set(cell.key, { cell, members: [obj] });
  }

  const zones: MapObject[] = [];
  const suppressedCells: ViewportAggregation["suppressedCells"] = [];
  let aggregated = 0;
  let suppressedForKAnonymity = 0;

  for (const key of [...bins.keys()].sort()) {
    const bin = bins.get(key) as { cell: GridCell; members: MapObject[] };
    const zone = summarizeCell(bin.members, { cell: bin.cell, k });
    if (zone) {
      zones.push(zone);
      aggregated += bin.members.length;
    } else {
      suppressedForKAnonymity += bin.members.length;
      dropped += bin.members.length;
      suppressedCells.push({
        key,
        contributors: bin.members.length,
        reason: "below_cohort_floor",
      });
    }
  }

  const out = [...passthrough, ...zones].sort(compareByRenderingPriority);
  return {
    objects: out,
    aggregated,
    individual: passthrough.length,
    dropped,
    suppressedForKAnonymity,
    zones: zones.length,
    suppressedCells,
    band,
    cellSizeDegrees,
  };
}

// ── Crowd flow (spec §10) ─────────────────────────────────────────────────────

/**
 * §10's input families. "Inputs may include anonymous coarse transitions,
 * arrivals, accepted plans, navigation starts, event context, aggregate presence
 * and explicit next-stop contributions."
 *
 * An unrecognized family string counts for NOTHING — it can never help satisfy
 * the multiple-families gate.
 */
export const CROWD_FLOW_SIGNAL_FAMILIES = [
  "coarse_transition",
  "arrival",
  "accepted_plan",
  "navigation_start",
  "event_context",
  "aggregate_presence",
  "next_stop_contribution",
] as const;
export type CrowdFlowSignalFamily = (typeof CROWD_FLOW_SIGNAL_FAMILIES)[number];

/** §10: "multiple signal families" — one family is a single point of failure. */
export const MIN_SIGNAL_FAMILIES = 2;

/**
 * §10 minimum cohort DENSITY, normalized to the privacy threshold's own time
 * bucket (30 minutes). This is deliberately NOT the same test as the k floor:
 * 20 travellers spread across a whole day is a publishable cohort but not a
 * flow, and the difference is exactly what "density" means here.
 */
export const MIN_FLOW_COHORT_PER_BUCKET: number = PRIVACY_THRESHOLD_V1.minUniqueActors;
export const FLOW_DENSITY_BUCKET_MINUTES: number = PRIVACY_THRESHOLD_V1.timeBucketMinutes;

/** §10 flow states. */
export const CROWD_FLOW_STATES = [
  "strong_movement",
  "moderate_movement",
  "emerging_movement",
  "dispersing",
  "unusual_movement",
] as const;
export type CrowdFlowState = (typeof CROWD_FLOW_STATES)[number];

/**
 * One zone→zone transition, already anonymized and coarsened upstream. There is
 * deliberately NO per-person field and no route geometry: §10 forbids exposing
 * individual routes or implying continuous tracking of specific people.
 */
export interface ZoneTransition {
  fromZoneId: string;
  toZoneId: string;
  /** Zone CENTROIDS — never a person's position. */
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  /** Distinct PEOPLE who made this transition. The caller must count truthfully. */
  distinctActors: number;
  /** Distinct independent groups/parties among them. */
  distinctGroups?: number;
  /** Largest single group's share of the cohort, 0..1. */
  maxGroupShare?: number;
  /** The §10 signal families that evidenced this movement. */
  signalFamilies: string[];
  /** Length of the observation window, in minutes. Defaults to the privacy time bucket. */
  windowMinutes?: number;
  observedAt: string | number | Date;
  expiresAt?: string | number | Date;
  confidence?: ConfidenceState;
  privacyClass?: PrivacyClass;
  sensitiveSubject?: boolean;
  /** Explicitly-flagged dispersal / anomaly; never inferred here. */
  dispersing?: boolean;
  unusual?: boolean;
  /** §10: the INFERRED cause, kept separate from the observation. */
  inferredCause?: { text: string; confidence?: ConfidenceState; basis?: string[] };
}

/**
 * §10: "Observed movement and inferred cause must be separately represented."
 * They are two fields, never merged into one sentence, and `inferred` is null
 * whenever no cause was supplied.
 */
export interface CrowdFlowPayload {
  observed: {
    flowState: CrowdFlowState;
    fromZoneId: string;
    toZoneId: string;
    /** Distinct people. Already past the k floor. */
    cohortSize: number;
    /** Recognized families only, sorted. */
    signalFamilies: CrowdFlowSignalFamily[];
    windowMinutes: number;
    observedAt: string;
  };
  inferred: { cause: string; confidence: ConfidenceState; basis: string[] } | null;
}

export type CrowdFlowRejectionReason =
  | SuppressionReason
  | "below_cohort_density"
  | "insufficient_signal_families"
  | "not_fresh"
  | "invalid_geometry"
  | "privacy_class_none"
  | "invalid_input";

export interface CrowdFlowRejection {
  fromZoneId: string;
  toZoneId: string;
  reason: CrowdFlowRejectionReason;
}

export interface DeriveCrowdFlowOptions {
  now?: string | number | Date;
  threshold?: PrivacyThreshold;
  minSignalFamilies?: number;
  minCohortPerBucket?: number;
}

export interface CrowdFlowResult {
  flows: MapObject<CrowdFlowPayload>[];
  /** Why each rejected transition produced nothing. Never a silent drop. */
  rejected: CrowdFlowRejection[];
}

function flowStateFor(t: ZoneTransition, k: number): CrowdFlowState {
  if (t.unusual === true) return "unusual_movement";
  if (t.dispersing === true) return "dispersing";
  const ratio = t.distinctActors / Math.max(1, k);
  if (ratio >= 4) return "strong_movement";
  if (ratio >= 2) return "moderate_movement";
  return "emerging_movement";
}

function humanizeFlowState(s: CrowdFlowState): string {
  return s
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * §10 Crowd Flow: aggregate movement between ZONE CENTROIDS.
 *
 * All four of §10's gates are enforced explicitly and each blocks on its own:
 *
 *   1. PRIVACY GATE      lib/privacyGate.evaluatePrivacy — k distinct actors,
 *                        independent groups, no dominant group, publication
 *                        delay, sensitive-subject refusal.
 *   2. FRESHNESS         must read live/recent via mapObjects.deriveFreshness.
 *   3. SIGNAL FAMILIES   at least MIN_SIGNAL_FAMILIES *recognized* families.
 *   4. COHORT DENSITY    actors normalized to the 30-minute privacy bucket.
 *
 * Note the deliberate interaction between (1) and (2): PRIVACY_THRESHOLD_V1
 * holds publication back for 10 minutes, and `live` only covers the first 5, so
 * a publishable flow is in practice a `recent` one — roughly 10 to 30 minutes
 * old. That is the intended shape. A flow that is publishable the instant it
 * forms would be a live tracker.
 *
 * Returns NOTHING for a weak flow — never a hedged or downgraded one — and
 * records the reason so a route can report the refusal.
 */
export function deriveCrowdFlow(
  transitions: readonly ZoneTransition[],
  opts: DeriveCrowdFlowOptions = {},
): CrowdFlowResult {
  const flows: MapObject<CrowdFlowPayload>[] = [];
  const rejected: CrowdFlowRejection[] = [];
  if (!Array.isArray(transitions) || transitions.length === 0) return { flows, rejected };

  const threshold = opts.threshold ?? PRIVACY_THRESHOLD_V1;
  const now = opts.now ?? Date.now();
  const minFamilies = finite(opts.minSignalFamilies)
    ? Math.max(MIN_SIGNAL_FAMILIES, opts.minSignalFamilies as number)
    : MIN_SIGNAL_FAMILIES;
  const minDensity = finite(opts.minCohortPerBucket)
    ? Math.max(MIN_FLOW_COHORT_PER_BUCKET, opts.minCohortPerBucket as number)
    : MIN_FLOW_COHORT_PER_BUCKET;

  // Deterministic order regardless of input order, so paging is stable.
  const ordered = [...transitions].sort((a, b) => {
    const ka = `${a?.fromZoneId ?? ""}→${a?.toZoneId ?? ""}`;
    const kb = `${b?.fromZoneId ?? ""}→${b?.toZoneId ?? ""}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  for (const t of ordered) {
    const id = { fromZoneId: t?.fromZoneId ?? "", toZoneId: t?.toZoneId ?? "" };
    if (!t || !t.fromZoneId || !t.toZoneId) {
      rejected.push({ ...id, reason: "invalid_input" });
      continue;
    }

    // GATE 1 — privacy (covers sensitive subjects, k, groups, publication delay).
    const decision = evaluatePrivacy(
      {
        distinctActors: t.distinctActors,
        distinctGroups: t.distinctGroups,
        maxGroupShare: t.maxGroupShare,
        observedAt: t.observedAt,
        now,
        sensitiveSubject: t.sensitiveSubject,
      },
      threshold,
    );
    if (!decision.publishable) {
      rejected.push({ ...id, reason: decision.reason ?? "invalid_input" });
      continue;
    }

    // GATE 2 — freshness. A flow that cannot be dated, or that has aged out, is
    // not a flow. §37: "Do not let stale claims remain visually live."
    const freshness = deriveFreshness(
      t.observedAt as string | number | Date,
      t.expiresAt ?? null,
      now,
    );
    if (!mayRenderAsLive(freshness)) {
      rejected.push({ ...id, reason: "not_fresh" });
      continue;
    }

    // GATE 3 — multiple signal families (recognized ones only).
    const families = normalizeFamilies(t.signalFamilies);
    if (families.length < minFamilies) {
      rejected.push({ ...id, reason: "insufficient_signal_families" });
      continue;
    }

    // GATE 4 — cohort density, normalized to the privacy time bucket.
    const windowMinutes = finite(t.windowMinutes) && (t.windowMinutes as number) > 0
      ? (t.windowMinutes as number)
      : FLOW_DENSITY_BUCKET_MINUTES;
    const density = t.distinctActors * (FLOW_DENSITY_BUCKET_MINUTES / windowMinutes);
    if (!(density >= minDensity)) {
      rejected.push({ ...id, reason: "below_cohort_density" });
      continue;
    }

    // Geometry: a LineString between two ZONE CENTROIDS. Nothing here is a
    // person's path; both endpoints are already-aggregated zone anchors.
    if (
      !t.from || !t.to ||
      !finite(t.from.lat) || !finite(t.from.lng) ||
      !finite(t.to.lat) || !finite(t.to.lng) ||
      Math.abs(t.from.lat) > 90 || Math.abs(t.to.lat) > 90
    ) {
      rejected.push({ ...id, reason: "invalid_geometry" });
      continue;
    }

    const flowState = flowStateFor(t, threshold.minUniqueActors);
    // Aggregation can only tighten: a flow is aggregate_only at best.
    const privacyClass = narrowestPrivacyClass(t.privacyClass ?? "aggregate_only", "aggregate_only");
    // `none` is the "not visible to this viewer" rung; it must never be
    // serialized, so refuse the flow rather than emit an unservable object.
    if (privacyClass === "none") {
      rejected.push({ ...id, reason: "privacy_class_none" });
      continue;
    }
    const observedMs = toEpochMs(t.observedAt);
    if (observedMs === null) {
      rejected.push({ ...id, reason: "invalid_input" });
      continue;
    }
    const observedIso = new Date(observedMs).toISOString();

    const inferred =
      t.inferredCause && typeof t.inferredCause.text === "string" && t.inferredCause.text.trim() !== ""
        ? {
            cause: t.inferredCause.text,
            confidence:
              t.inferredCause.confidence && CONFIDENCE_STATES.includes(t.inferredCause.confidence)
                ? t.inferredCause.confidence
                : (CONFIDENCE_STATES[0] as ConfidenceState),
            basis: Array.isArray(t.inferredCause.basis) ? [...t.inferredCause.basis] : [],
          }
        : null;

    const obj: MapObject<CrowdFlowPayload> = {
      id: `flow:${t.fromZoneId}:${t.toZoneId}`,
      kind: "crowd_flow",
      geometry: {
        type: "LineString",
        coordinates: [
          [normalizeLng(t.from.lng), t.from.lat],
          [normalizeLng(t.to.lng), t.to.lat],
        ],
      },
      title: humanizeFlowState(flowState),
      subtitle: `${t.distinctActors} travelers moving`,
      observedAt: observedIso,
      freshness,
      confidence: t.confidence ?? (CONFIDENCE_STATES[0] as ConfidenceState),
      privacyClass,
      renderingPriority: KIND_DEFAULT_PRIORITY.crowd_flow,
      count: t.distinctActors,
      interaction: { actions: ["ask_compass", "view"], opensSheet: true },
      payload: {
        observed: {
          flowState,
          fromZoneId: t.fromZoneId,
          toZoneId: t.toZoneId,
          cohortSize: t.distinctActors,
          signalFamilies: families,
          windowMinutes,
          observedAt: observedIso,
        },
        inferred,
      },
    };
    const expiresMs = t.expiresAt === undefined || t.expiresAt === null ? null : toEpochMs(t.expiresAt);
    if (expiresMs !== null) obj.expiresAt = new Date(expiresMs).toISOString();
    flows.push(obj);
  }

  return { flows, rejected };
}

/** Epoch ms for any accepted timestamp shape, or null when unparseable. */
function toEpochMs(t: string | number | Date): number | null {
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Recognized, de-duplicated, sorted signal families. Unknown strings are discarded. */
function normalizeFamilies(input: unknown): CrowdFlowSignalFamily[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<CrowdFlowSignalFamily>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const f = raw as CrowdFlowSignalFamily;
    if (CROWD_FLOW_SIGNAL_FAMILIES.includes(f)) seen.add(f);
  }
  return [...seen].sort();
}
