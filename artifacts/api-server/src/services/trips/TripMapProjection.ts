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

// ── crew presence (§14.1 "crew presence summaries", §14.4, §10.2) ──────────────
//
// THE LAYER THAT SHIPPED AS `no_source` ON A TRUE PREMISE THAT STOPPED BEING ONE
// ================================================================================
// Its reason string said crew presence "deliberately carries no coordinates
// unless a live-share grant exists (§14.4). It is not a coordinate layer and is
// not synthesised into one here." Both halves were right, and the second was
// the point: synthesising a coordinate from an area label would be the §14.4
// violation. What changed is that the crew map now HAS a coordinate it is
// entitled to publish — lib/tripCrewLocation.ts puts `exactCoords` on a card
// only under an active live-share grant to this viewer, with hotel/home blur
// off, over a position judged LIVE or RECENT on its own clock (census-trips
// TR165). A point that arrives through that door is not synthesised; it is the
// permitted temporary precise position §14.4 allows. Everyone else on the
// crew stays a summary: counted, never placed.
//
// ENFORCED, NOT TRUSTED. The card promises exact coordinates only over a
// current position; this function checks the class again and refuses a card
// whose coordinates outlive its currency. The refusal is reported (and the
// route counts it) rather than silently dropped, because a card in that state
// is a defect upstream and the projection must not paper over it.

/** The two §10.2 classes a coordinate may be drawn as current under. */
export const CREW_POINT_CURRENT_CLASSES: ReadonlySet<string> = new Set(["LIVE", "RECENT"]);

/** What this layer reads off a crew card — a subset of lib/tripCrewLocation's CrewMemberCard. */
export interface CrewPresenceCard {
  userId: string;
  name: string | null;
  handle: string | null;
  statusLabel: string;
  ghostMode: boolean;
  liveShareActive: boolean;
  liveShareExpiresAt: string | null;
  exactCoords?: { lat: number; lng: number } | null;
  freshnessClass: string;
  observedAt: string | null;
  confidence: string;
  source: string | null;
  presenceReason: string | null;
}

export interface CrewPresenceLayerBuild {
  points: MapPoint[];
  /** Cards read; every one is either a point or summarised. */
  members: number;
  /** Cards without a permitted coordinate, by the reason they have none. */
  summarised: { hidden: number; noGrant: number; noPosition: number; refusedStale: number };
  /** The cards refused for a coordinate over a non-current class — an upstream defect, reported. */
  refusedStale: string[];
}

/**
 * The crew presence layer's points, from the crew map's cards.
 *
 * A card becomes a point only when it carries `exactCoords` (which the crew
 * map issues only under an active grant) AND its `freshnessClass` is LIVE or
 * RECENT — the check the card already made, made again where the coordinate
 * is about to be drawn. Everything else is summarised by reason.
 */
export function crewPresencePoints(cards: readonly CrewPresenceCard[]): CrewPresenceLayerBuild {
  const points: MapPoint[] = [];
  const summarised = { hidden: 0, noGrant: 0, noPosition: 0, refusedStale: 0 };
  const refusedStale: string[] = [];
  for (const c of cards) {
    if (c.ghostMode || c.presenceReason !== null || c.statusLabel === "location_hidden" || c.statusLabel === "not_shared") {
      summarised.hidden += 1;
      continue;
    }
    if (!c.liveShareActive) { summarised.noGrant += 1; continue; }
    const coords = c.exactCoords ? coordsOf(c.exactCoords.lat, c.exactCoords.lng) : null;
    if (!coords) { summarised.noPosition += 1; continue; }
    if (!CREW_POINT_CURRENT_CLASSES.has(c.freshnessClass)) {
      // §10.2: a coordinate over a LAST_KNOWN / OFFLINE position is not drawn
      // as current — and the card should not have carried it. Refused here,
      // named for the route to count.
      summarised.refusedStale += 1;
      refusedStale.push(c.userId);
      continue;
    }
    points.push({
      id: c.userId,
      kind: "crew_member",
      lat: coords.lat,
      lng: coords.lng,
      label: c.name ?? c.handle ?? null,
      meta: {
        freshnessClass: c.freshnessClass,
        observedAt: c.observedAt,
        confidence: c.confidence,
        source: c.source,
        liveShareExpiresAt: c.liveShareExpiresAt,
        statusLabel: c.statusLabel,
      },
    });
  }
  return { points, members: cards.length, summarised, refusedStale };
}

/** The sentence the response carries for this layer: who is drawn, who is summarised, and why. */
export function crewPresenceReading(b: CrewPresenceLayerBuild): string {
  const s = b.summarised;
  const parts = [
    `${b.members} crew member(s) read`,
    `${b.points.length} drawn at exact coordinates under an active live-share grant over a LIVE / RECENT position`,
    `${s.hidden} hidden or not sharing`,
    `${s.noGrant} sharing an area only (no live-share grant to this viewer)`,
    `${s.noPosition} under a grant with no publishable position`,
  ];
  if (s.refusedStale > 0) parts.push(`${s.refusedStale} REFUSED: a coordinate over a non-current position (§10.2) — counted as stale_presence_render_attempt_total`);
  return parts.join("; ");
}
