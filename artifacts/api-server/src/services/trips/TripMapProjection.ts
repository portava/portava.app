/**
 * Trips §14.1 — the `TripMapProjection` contract.
 *
 * §14.1, verbatim:
 *
 *   TripMapProjection {
 *     stage
 *     hotel/private anchors (access controlled)
 *     active plans
 *     confirmed commitments
 *     saved ideas
 *     crew presence summaries
 *     route chains
 *     meetup points
 *     live opportunities
 *     safety/logistics points
 *     generatedAt
 *     sourceTripVersion
 *   }
 *
 * WHAT EXISTED, AND WHY A MARKER LIST IS NOT THIS
 * ==============================================
 * `GET /trips/:tripId/plan/map` returns plan items that have coordinates. It
 * is a marker list. census-trips TR254 says the difference exactly: a
 * projection carries a VERSION and a GENERATED-AT, so a consumer can tell
 * whether what it is drawing is current and can say what it is a projection
 * OF. A list of markers can answer neither question, and two clients drawing
 * the same trip from it can disagree without either being able to notice.
 *
 * `sourceTripVersion` is `trips.version` — the kernel's aggregate version, the
 * same number §4's commands bump and `expectedTripVersion` is checked against.
 * That is what makes this projection attributable: two projections with the
 * same `sourceTripVersion` describe the same aggregate state.
 *
 * EVERY LAYER IS THREE-VALUED, AND THAT IS THE WHOLE DESIGN
 * ========================================================
 * A map is the surface where an absent layer is least visible and most
 * dangerous: nothing on the screen looks exactly like nothing in the world. So
 * no layer is ever a bare array.
 *
 *   { status: "ok", items }        read, and this is what is there
 *   { status: "unread", reason }   the read FAILED. Not an empty layer.
 *   { status: "no_source",         nothing in this system produces this layer.
 *     reason }                     Distinct from unread: no retry will help.
 *
 * `no_source` is not a placeholder for future work — it is the honest state of
 * two of §14.1's ten layers today, and omitting them would let a consumer
 * believe a projection carrying eight layers carries ten.
 *
 * §14.4 MAP SAFETY IS ENFORCED HERE, NOT TRUSTED TO WRITERS
 * ========================================================
 * §14.4: "Sensitive anchors such as hotel/private lodging must never be
 * included in public or broad social projections." census-trips TR256 records
 * why the existing arrangement is only W: `trip_plan_items.location_is_private`
 * is a flag, and "the safety depends on each writer setting a flag".
 *
 * This projection does two things a flag cannot:
 *
 *   1. It SEPARATES the private anchors into their own layer, so a consumer
 *      that wants the ordinary plan cannot accidentally receive them by
 *      iterating one list.
 *   2. `assertNoPrivateLeak` re-checks the assembled projection and THROWS if
 *      a private-flagged item appears in any non-anchor layer. A postcondition
 *      rather than a convention: the failure it guards against is a coding
 *      mistake in this file, and a convention cannot catch one of those.
 *
 * PURE. Assembly and the safety check take their inputs as parameters; the
 * route does the reading and owns the fail-closed rules.
 */

export const LAYER_STATUSES = ["ok", "unread", "no_source"] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export type Layer<T> =
  | { status: "ok"; items: T[] }
  /** The read failed. A retry may work. NEVER an empty layer. */
  | { status: "unread"; reason: string }
  /** Nothing in this system produces this layer. A retry will not help. */
  | { status: "no_source"; reason: string };

export function ok<T>(items: T[]): Layer<T> { return { status: "ok", items }; }
export function unread<T>(reason: string): Layer<T> { return { status: "unread", reason }; }
export function noSource<T>(reason: string): Layer<T> { return { status: "no_source", reason }; }

/** A point on the map. `lat`/`lng` are always present — an item without
 *  coordinates is not a map object and is filtered out before it gets here. */
export interface MapPoint {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  label: string | null;
  /** True only in the anchors layer. Carried so a consumer cannot lose track
   *  of which points are the sensitive ones after merging layers. */
  privateAnchor?: true;
  meta?: Record<string, unknown>;
}

/** §14.1's ten layers, exactly, plus the two envelope fields. */
export interface TripMapProjection {
  tripId: string;
  /** ISO instant. §14.1's `generatedAt`. */
  generatedAt: string;
  /**
   * §14.1's `sourceTripVersion` — `trips.version`, the kernel aggregate
   * version. NULL when it could not be read, which makes the whole projection
   * unattributable: a consumer must not cache or compare it.
   */
  sourceTripVersion: number | null;
  stage: Layer<MapPoint>;
  privateAnchors: Layer<MapPoint>;
  activePlans: Layer<MapPoint>;
  confirmedCommitments: Layer<MapPoint>;
  savedIdeas: Layer<MapPoint>;
  crewPresenceSummaries: Layer<MapPoint>;
  routeChains: Layer<MapPoint>;
  meetupPoints: Layer<MapPoint>;
  liveOpportunities: Layer<MapPoint>;
  safetyPoints: Layer<MapPoint>;
}

/** The layer keys, so a consumer (and a test) can iterate them totally. */
export const PROJECTION_LAYERS = [
  "stage", "privateAnchors", "activePlans", "confirmedCommitments",
  "savedIdeas", "crewPresenceSummaries", "routeChains", "meetupPoints",
  "liveOpportunities", "safetyPoints",
] as const;
export type ProjectionLayer = (typeof PROJECTION_LAYERS)[number];

/** Layers that may carry private anchors. Exactly one. */
const ANCHOR_LAYERS: ReadonlySet<ProjectionLayer> = new Set<ProjectionLayer>(["privateAnchors"]);

export class PrivateAnchorLeak extends Error {
  readonly layer: ProjectionLayer;
  readonly pointId: string;
  constructor(layer: ProjectionLayer, pointId: string) {
    super(
      `§14.4 violation: point ${pointId} is a private anchor and appeared in the '${layer}' layer. ` +
      "A private lodging location must never reach a layer a consumer may merge into a broad view.",
    );
    this.name = "PrivateAnchorLeak";
    this.layer = layer;
    this.pointId = pointId;
  }
}

/**
 * §14.4, as a postcondition over the assembled projection.
 *
 * Throws rather than filtering. A filter would make the leak invisible and
 * leave the bug in place; the thing being guarded is a coding mistake in the
 * assembly above, and the only useful response to one is to refuse to serve
 * the projection at all.
 */
export function assertNoPrivateLeak(p: TripMapProjection): void {
  for (const key of PROJECTION_LAYERS) {
    if (ANCHOR_LAYERS.has(key)) continue;
    const layer = p[key];
    if (layer.status !== "ok") continue;
    for (const point of layer.items) {
      if (point.privateAnchor) throw new PrivateAnchorLeak(key, point.id);
    }
  }
}

/**
 * Is this projection attributable to a version of the trip?
 *
 * A projection with no `sourceTripVersion` was assembled from rows nobody can
 * tie to an aggregate state. It is still worth serving — the points are real —
 * but it must not be cached, compared against another projection, or used to
 * decide that nothing has changed.
 */
export function isAttributable(p: TripMapProjection): boolean {
  return p.sourceTripVersion !== null;
}

/** How many of §14.1's ten layers actually carry data. Reported so "eight
 *  layers arrived" is never mistaken for "ten layers arrived, two empty". */
export function layerCensus(p: TripMapProjection): {
  ok: number; unread: number; noSource: number; totalPoints: number;
} {
  let okN = 0, unreadN = 0, noSourceN = 0, totalPoints = 0;
  for (const key of PROJECTION_LAYERS) {
    const l = p[key];
    if (l.status === "ok") { okN += 1; totalPoints += l.items.length; }
    else if (l.status === "unread") unreadN += 1;
    else noSourceN += 1;
  }
  return { ok: okN, unread: unreadN, noSource: noSourceN, totalPoints };
}

/** A finite coordinate pair, or null. A non-finite value is NOT a coordinate:
 *  coercing it puts the point at 0,0 and draws it in the Gulf of Guinea. */
export function coordsOf(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  return typeof lat === "number" && typeof lng === "number"
    && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : null;
}
