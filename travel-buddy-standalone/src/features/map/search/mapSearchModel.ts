/**
 * mapSearchModel — Map search results and their camera framing (Map spec §27).
 *
 * WHAT §27 ASKS FOR
 * =================
 * Nine result types — "Places. Events. Trips. Users. Buddies. Hidden Gems.
 * Areas. Hashtags. Saved items." — and one behavioural rule:
 *
 *     "Geographic results should CENTER OR FRAME the relevant map object."
 *
 * That "or" is the whole module. A place is a point and centres. An Area is a
 * region and must be FRAMED — flying to an Area's centroid at a place-level
 * zoom is the classic search bug: the user searches "Bà Nà Hills", the camera
 * lands inside it, and the thing they searched for is off every edge of the
 * screen. `frameFor()` returns a discriminated `MapCameraFrame`, so a caller
 * physically cannot pass an Area to a centre-on-point camera call: the
 * `bounds` frame carries no `center`/`zoom` to hand it.
 *
 * DETERMINISM
 * ===========
 * Results are heterogeneous and arrive from several ranked backends, so every
 * comparator here ends in a total tie-break (title, then id). Two renders of
 * the same response produce the same list in the same order — which matters
 * because search results double as map markers, and a wobbling order is a
 * wobbling z-order.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No network, no React, no ranking of its own: a
 * result's `score` comes from whichever backend produced it, and this module
 * only orders and groups by it.
 */

import type { PrivacyClass } from '../../../types/mapObjects.ts';
import { boundsOfPoints, centerOfBounds, padBounds } from '../pulse/pulseMapBridge.ts';
import type { LatLng, MapBounds, MapCameraState } from '../pulse/pulseMapBridge.ts';

// ── The nine result types (§27) ────────────────────────────────────────────────

/** Spec §27's nine result types, in the spec's own order. */
export const MAP_SEARCH_RESULT_TYPES = [
  'place',
  'event',
  'trip',
  'user',
  'buddy',
  'hidden_gem',
  'area',
  'hashtag',
  'saved',
] as const;
export type MapSearchResultType = (typeof MAP_SEARCH_RESULT_TYPES)[number];

/** Section headers, in the spec's wording. */
export const MAP_SEARCH_GROUP_LABELS: Record<MapSearchResultType, string> = {
  place: 'Places',
  event: 'Events',
  trip: 'Trips',
  user: 'Users',
  buddy: 'Buddies',
  hidden_gem: 'Hidden Gems',
  area: 'Areas',
  hashtag: 'Hashtags',
  saved: 'Saved items',
};

interface BaseSearchResult {
  id: string;
  title: string;
  subtitle?: string;
  /** Relevance from the producing backend; higher is better. */
  score?: number;
  /** Distance from the viewport centre, km, when the backend computed one. */
  distanceKm?: number | null;
  /** Expo Router href for the result's own detail screen. */
  detailRoute?: string;
  /**
   * The §23 rung the coordinates already sit on. Carried, never sharpened —
   * a user or buddy result is normally `approximate` at best.
   */
  privacyClass?: PrivacyClass;
}

export interface PlaceSearchResult extends BaseSearchResult {
  type: 'place';
  center: LatLng;
  category?: string;
}

export interface EventSearchResult extends BaseSearchResult {
  type: 'event';
  center: LatLng;
  startsAt?: string | null;
  endsAt?: string | null;
}

/** A trip frames its stops when they are known, and centres otherwise. */
export interface TripSearchResult extends BaseSearchResult {
  type: 'trip';
  center?: LatLng | null;
  /** Bounds of the trip's stops, when the backend resolved them. */
  bounds?: MapBounds | null;
  stops?: readonly LatLng[] | null;
  destinationCity?: string;
}

export interface UserSearchResult extends BaseSearchResult {
  type: 'user';
  /** Approximate, permitted position only; may be absent. */
  center?: LatLng | null;
  handle?: string;
}

export interface BuddySearchResult extends BaseSearchResult {
  type: 'buddy';
  center?: LatLng | null;
  city?: string;
}

export interface HiddenGemSearchResult extends BaseSearchResult {
  type: 'hidden_gem';
  center: LatLng;
}

/** An Area is a REGION. It frames; it does not centre. */
export interface AreaSearchResult extends BaseSearchResult {
  type: 'area';
  bounds: MapBounds;
  /** Optional label anchor. Never used for framing. */
  center?: LatLng | null;
  areaKind?: 'city' | 'neighborhood' | 'district' | 'region';
}

/** A hashtag frames the spread of what carries it, when that is known. */
export interface HashtagSearchResult extends BaseSearchResult {
  type: 'hashtag';
  tag: string;
  count?: number;
  bounds?: MapBounds | null;
  points?: readonly LatLng[] | null;
}

export interface SavedSearchResult extends BaseSearchResult {
  type: 'saved';
  center?: LatLng | null;
  bounds?: MapBounds | null;
  /** What was saved. Drives the icon and the detail route. */
  savedKind: 'place' | 'event' | 'trip' | 'hidden_gem' | 'area';
}

export type MapSearchResult =
  | PlaceSearchResult
  | EventSearchResult
  | TripSearchResult
  | UserSearchResult
  | BuddySearchResult
  | HiddenGemSearchResult
  | AreaSearchResult
  | HashtagSearchResult
  | SavedSearchResult;

// ── Camera framing (§27) ───────────────────────────────────────────────────────

/**
 * How the camera should move for a result.
 *
 * Three cases, deliberately disjoint:
 *  - `center` carries a point and a zoom, and NO bounds.
 *  - `bounds` carries a box and padding, and NO zoom — the renderer computes
 *    the zoom that fits the box, which is the entire point of framing.
 *  - `none` carries a reason, so the caller can disable the "show on map"
 *    affordance instead of flying somewhere arbitrary.
 */
export type MapCameraFrame =
  | {
      kind: 'center';
      center: LatLng;
      zoom: number;
      cameraState: MapCameraState;
    }
  | {
      kind: 'bounds';
      bounds: MapBounds;
      /** Fractional margin already applied around the subject. */
      padding: number;
      cameraState: MapCameraState;
    }
  | { kind: 'none'; reason: 'no_geometry' };

/** Point-result zoom per type: tighter for a venue, wider for a person. */
const POINT_ZOOM: Record<MapSearchResultType, number> = {
  place: 16,
  event: 16,
  hidden_gem: 16.5,
  saved: 16,
  trip: 12,
  user: 13,
  buddy: 13,
  area: 12,
  hashtag: 13,
};

const FRAME_PADDING = 0.15;

function areaOf(b: MapBounds): number {
  return Math.abs(b.north - b.south) * Math.abs(b.east - b.west);
}

/** A box with no extent is a point wearing a box's clothes. */
function isDegenerate(b: MapBounds | null | undefined): boolean {
  return !b || areaOf(b) <= 0;
}

/**
 * §27: "Geographic results should center or frame the relevant map object."
 *
 * Framing wins wherever the result HAS an extent — Areas always, and Trips,
 * Hashtags and saved Areas whenever their bounds or point spread are known.
 * Everything else centres at a type-appropriate zoom.
 *
 * An Area with a degenerate (zero-extent) box falls back to centring on the
 * box, because framing a box of zero size would zoom the camera to infinity.
 */
export function frameFor(result: MapSearchResult): MapCameraFrame {
  const bounded = (bounds: MapBounds, cameraState: MapCameraState): MapCameraFrame => ({
    kind: 'bounds',
    bounds: padBounds(bounds, FRAME_PADDING),
    padding: FRAME_PADDING,
    cameraState,
  });
  const centred = (center: LatLng, cameraState: MapCameraState): MapCameraFrame => ({
    kind: 'center',
    center,
    zoom: POINT_ZOOM[result.type],
    cameraState,
  });

  switch (result.type) {
    case 'area': {
      if (!isDegenerate(result.bounds)) return bounded(result.bounds, 'FOCUS_AREA');
      const c = result.center ?? centerOfBounds(result.bounds);
      return Number.isFinite(c.lat) && Number.isFinite(c.lng)
        ? centred(c, 'FOCUS_AREA')
        : { kind: 'none', reason: 'no_geometry' };
    }

    case 'trip': {
      const b =
        (!isDegenerate(result.bounds) ? result.bounds : null) ??
        (result.stops && result.stops.length > 1 ? boundsOfPoints(result.stops) : null);
      if (b && !isDegenerate(b)) return bounded(b, 'FOCUS_TRIP');
      const c = result.center ?? (result.stops?.length === 1 ? result.stops[0] : null);
      return c ? centred(c, 'FOCUS_TRIP') : { kind: 'none', reason: 'no_geometry' };
    }

    case 'hashtag': {
      const b =
        (!isDegenerate(result.bounds) ? result.bounds : null) ??
        (result.points && result.points.length > 1 ? boundsOfPoints(result.points) : null);
      if (b && !isDegenerate(b)) return bounded(b, 'FOCUS_AREA');
      const c = result.points?.length === 1 ? result.points[0] : null;
      return c ? centred(c, 'FOCUS_AREA') : { kind: 'none', reason: 'no_geometry' };
    }

    case 'saved': {
      if (result.bounds && !isDegenerate(result.bounds)) {
        return bounded(result.bounds, result.savedKind === 'trip' ? 'FOCUS_TRIP' : 'FOCUS_AREA');
      }
      return result.center
        ? centred(result.center, 'FOCUS_PLACE')
        : { kind: 'none', reason: 'no_geometry' };
    }

    case 'user':
    case 'buddy':
      return result.center
        ? centred(result.center, 'FOCUS_AREA')
        : { kind: 'none', reason: 'no_geometry' };

    case 'place':
    case 'event':
    case 'hidden_gem':
      return centred(result.center, 'FOCUS_PLACE');
  }
}

/** The representative point of a result, when it has one. Never used to frame. */
export function anchorOf(result: MapSearchResult): LatLng | null {
  switch (result.type) {
    case 'place':
    case 'event':
    case 'hidden_gem':
      return result.center ?? null;
    case 'area':
      return result.center ?? centerOfBounds(result.bounds);
    case 'trip': {
      if (result.center) return result.center;
      if (result.bounds) return centerOfBounds(result.bounds);
      const b = result.stops ? boundsOfPoints(result.stops) : null;
      return b ? centerOfBounds(b) : null;
    }
    case 'hashtag': {
      if (result.bounds) return centerOfBounds(result.bounds);
      const b = result.points ? boundsOfPoints(result.points) : null;
      return b ? centerOfBounds(b) : null;
    }
    case 'user':
    case 'buddy':
    case 'saved':
      return result.center ?? (result.bounds ? centerOfBounds(result.bounds) : null) ?? null;
  }
}

/** Whether the result can move the camera at all. */
export function isGeographic(result: MapSearchResult): boolean {
  return frameFor(result).kind !== 'none';
}

// ── Ordering and grouping ──────────────────────────────────────────────────────

export interface SearchOrderContext {
  /**
   * Type weights applied on top of `score`, so a query can bias its own
   * result mix (an "Areas" filter, a geographic-first query). Absent types
   * weigh 0. Weights never reorder ACROSS groups — grouping is fixed by §27.
   */
  typeWeights?: Partial<Record<MapSearchResultType, number>>;
  /** When set, results without geometry sort after those with it. */
  preferGeographic?: boolean;
}

function effectiveScore(r: MapSearchResult, ctx: SearchOrderContext): number {
  return (r.score ?? 0) + (ctx.typeWeights?.[r.type] ?? 0);
}

/**
 * Total order over heterogeneous results:
 *   geographic-first (opt-in) → effective score desc → distance asc →
 *   title (locale) → type (§27 order) → id.
 *
 * Every step is deterministic and the last one is unique, so `orderResults` is
 * a stable total order regardless of the input array's order.
 */
export function compareSearchResults(
  a: MapSearchResult,
  b: MapSearchResult,
  ctx: SearchOrderContext = {},
): number {
  if (ctx.preferGeographic) {
    const ga = isGeographic(a) ? 0 : 1;
    const gb = isGeographic(b) ? 0 : 1;
    if (ga !== gb) return ga - gb;
  }
  const sa = effectiveScore(a, ctx);
  const sb = effectiveScore(b, ctx);
  if (sa !== sb) return sb - sa;

  const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;

  const t = a.title.localeCompare(b.title);
  if (t !== 0) return t;

  const ta = MAP_SEARCH_RESULT_TYPES.indexOf(a.type);
  const tb = MAP_SEARCH_RESULT_TYPES.indexOf(b.type);
  if (ta !== tb) return ta - tb;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A new, deterministically ordered array. The input is never mutated. */
export function orderResults(
  results: readonly MapSearchResult[],
  ctx: SearchOrderContext = {},
): MapSearchResult[] {
  return [...(results ?? [])].sort((a, b) => compareSearchResults(a, b, ctx));
}

export interface MapSearchGroup {
  type: MapSearchResultType;
  label: string;
  results: MapSearchResult[];
}

export interface GroupOptions extends SearchOrderContext {
  /** Cap per group, for a collapsed "see all" list. */
  limitPerGroup?: number;
  /** Drop empty groups. Default true. */
  omitEmpty?: boolean;
}

/**
 * Group results by §27 type, in the spec's declared order, with each group
 * internally ordered by `compareSearchResults`.
 *
 * Group order is FIXED — it is the spec's list, not a ranked one. Letting
 * relevance reorder the sections would make the results screen's shape change
 * on every keystroke, which is a worse experience than a slightly suboptimal
 * section on top.
 */
export function groupResults(
  results: readonly MapSearchResult[],
  opts: GroupOptions = {},
): MapSearchGroup[] {
  const omitEmpty = opts.omitEmpty ?? true;
  const buckets = new Map<MapSearchResultType, MapSearchResult[]>();
  for (const t of MAP_SEARCH_RESULT_TYPES) buckets.set(t, []);

  const seen = new Set<string>();
  for (const r of results ?? []) {
    if (!r || typeof r.id !== 'string' || r.id === '') continue;
    if (typeof r.title !== 'string' || r.title.trim() === '') continue;
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buckets.get(r.type)?.push(r);
  }

  const out: MapSearchGroup[] = [];
  for (const type of MAP_SEARCH_RESULT_TYPES) {
    let list = orderResults(buckets.get(type) ?? [], opts);
    if (opts.limitPerGroup != null) list = list.slice(0, opts.limitPerGroup);
    if (list.length === 0 && omitEmpty) continue;
    out.push({ type, label: MAP_SEARCH_GROUP_LABELS[type], results: list });
  }
  return out;
}

/**
 * The frame that shows ALL results at once — what the map should do when the
 * user runs a search without picking one result yet.
 *
 * Only anchors of geographic results contribute. Returns a `none` frame when
 * nothing in the result set can be placed.
 */
export function frameForResultSet(results: readonly MapSearchResult[]): MapCameraFrame {
  const anchors: LatLng[] = [];
  let onlyResult: MapSearchResult | null = null;
  let geographicCount = 0;

  for (const r of results ?? []) {
    if (!isGeographic(r)) continue;
    geographicCount += 1;
    onlyResult = r;
    const a = anchorOf(r);
    if (a) anchors.push(a);
  }

  if (geographicCount === 1 && onlyResult) return frameFor(onlyResult);

  const b = boundsOfPoints(anchors);
  if (!b) return { kind: 'none', reason: 'no_geometry' };
  if (isDegenerate(b)) {
    return { kind: 'center', center: centerOfBounds(b), zoom: 15, cameraState: 'FOCUS_AREA' };
  }
  return {
    kind: 'bounds',
    bounds: padBounds(b, FRAME_PADDING),
    padding: FRAME_PADDING,
    cameraState: 'FOCUS_AREA',
  };
}
