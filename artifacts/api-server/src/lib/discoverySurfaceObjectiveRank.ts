/**
 * discoverySurfaceObjectiveRank — DV-09's last three surfaces: Trail, Trending
 * and Trip Planning rank on their own `01` §9 objective. census-discovery §93
 * (lane W11-X1), decisions D-W11X1-3 and D-W11X1-4.
 *
 * WHAT WAS MISSING
 * ================
 * §78 built the five objectives (lib/discoveryRankObjectives SURFACE_OBJECTIVES)
 * and the one read that resolves a surface's objective under 3450
 * (lib/discoveryRankDesigns surfaceObjectiveOptions). Discovery (§78 H1) and
 * Pulse (§78 H3) adopted theirs in §91. Trail, Trending and Trip Planning made
 * no portavaRank call, so there was nothing to hand an objective to (§78.4).
 * This module is the smallest honest ranker for each, on portavaRank itself —
 * no second scoring formula — fed only inputs the surface already holds.
 *
 * TWO SWITCHES, BOTH REQUIRED (D-W11X1-3)
 * ======================================
 *   the surface's own flag (3500, seeded FALSE) — does this surface rank at all:
 *     discovery_trail_objective_rank_enabled
 *     discovery_trending_objective_rank_enabled
 *     discovery_trip_planning_objective_rank_enabled
 *   3450 discovery_surface_objectives_enabled — the objective itself, with the
 *     owner's metadata overrides (surfaceObjectiveOptions).
 * A surface ranks only when both are on: without an objective there is nothing
 * for these three to adopt, and ranking them on the Discovery default weights
 * would be a fourth objective nobody specified. Either off, absent or
 * unreadable ⇒ `null` ⇒ each call site serves exactly what it served before
 * (the caller's own array, untouched). The surface flag is read FIRST, so with
 * it off 3450 is not even read.
 *
 * THE THREE RANKERS (inputs stated, none invented)
 * ===============================================
 *   Trail          the Trail page's `personalized_picks` spotlight (`02` §8
 *                  names "Personalized Picks"; nothing served it). Candidates
 *                  are the members the viewer may be served, ranked for the
 *                  viewer: followed creators, the viewer's place affinity, and
 *                  `trail_relevance` = the member's own membership confidence —
 *                  inside ONE Trail, `01` §9's "Trail relevance" and
 *                  "confidence" are the same fact. Freshness per kind and the
 *                  contributor/place diversity arrive with the objective.
 *   Trending       inside each claimed state of GET …/trending/places (the
 *                  state order D-W10-R1-13 decided stays first), the places are
 *                  ordered by the Trending objective over their freshness,
 *                  normalised velocity (÷ the state's fastest, as
 *                  `localMomentum`, still under the owner's cap), verified
 *                  status and saves (de-emphasised).
 *   Trip Planning  GET /trips/:tripId/nearby-places, ordered by the Trip
 *                  Planning objective: trip fit (lib/discoveryRankTrip's
 *                  kernel, for the trip being planned), route fit ≈ distance
 *                  from the trip's destination, saves, and the viewer's
 *                  category affinity. Rating stays the tie-break (the input
 *                  order), because portavaRank has no rating term.
 *
 * Every ranker is `exploration: false` (none of these surfaces has an
 * exploration slot to give) and keeps the ranker's default diversity plus the
 * objective's own. Controlled tests only; nothing here claims real-world
 * effectiveness.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { surfaceObjectiveOptions } from "./discoveryRankDesigns.js";
import {
  rankCandidates,
  type RankCandidate, type RankObjective, type ScoredCandidate, type ViewerContext, type CandidateKind,
} from "./portavaRank.js";
import { tripFitMap } from "./discoveryRankTrip.js";
import { loadPdeViewer } from "./discoveryPde.js";
import { haversineKm } from "./canonicalLocations.js";

export type ObjectiveRankedSurface = "trail" | "trending" | "trip_planning";

/** 3500's three flags. */
export const SURFACE_OBJECTIVE_RANK_FLAGS: Readonly<Record<ObjectiveRankedSurface, string>> = Object.freeze({
  trail: "discovery_trail_objective_rank_enabled",
  trending: "discovery_trending_objective_rank_enabled",
  trip_planning: "discovery_trip_planning_objective_rank_enabled",
});

/** The surface's own flag, read as a literal at its read site (check:flag-polarity reads call sites). */
async function surfaceFlagOn(sc: any, surface: ObjectiveRankedSurface): Promise<boolean> {
  if (surface === "trail") return isFlagEnabled(sc, "discovery_trail_objective_rank_enabled");
  if (surface === "trending") return isFlagEnabled(sc, "discovery_trending_objective_rank_enabled");
  return isFlagEnabled(sc, "discovery_trip_planning_objective_rank_enabled");
}

/**
 * The surface's objective when BOTH its flag and 3450 are on; otherwise null.
 * Never throws: an unreadable flag is off.
 */
export async function loadSurfaceObjective(sc: any, surface: ObjectiveRankedSurface): Promise<RankObjective | null> {
  if (!sc) return null;
  try {
    if (!(await surfaceFlagOn(sc, surface))) return null;
    return (await surfaceObjectiveOptions(sc, surface)).objective ?? null;
  } catch {
    return null;
  }
}

/** portavaRank on one surface's objective: no exploration slot, default diversity plus the objective's own. */
export function rankOnSurfaceObjective<C extends RankCandidate>(candidates: C[], ctx: ViewerContext, objective: RankObjective): ScoredCandidate<C>[] {
  return rankCandidates(candidates, ctx, { objective, exploration: false });
}

// ── Trail: the `personalized_picks` spotlight ────────────────────────────────

/** The member fields the Trail ranker reads (services/trails/TrailService ServableMember). */
export interface TrailPickRow {
  id: string;
  source_type: string;
  source_id: string;
  created_at: string;
  confidence: number | string | null;
  contributor_id: string | null;
  creatorId: string | null;
  clusterPlaceId: string | null;
  content_state: string;
}

const TRAIL_KIND: Readonly<Record<string, CandidateKind>> = { post: "post", place: "place", event: "event", itinerary: "plan", route: "plan" };

export function trailPickCandidate<R extends TrailPickRow>(r: R): RankCandidate & { __row: R } {
  return {
    id: r.id,
    kind: TRAIL_KIND[r.source_type] ?? "place",
    createdAt: r.created_at,
    authorId: r.creatorId ?? r.contributor_id ?? null,
    placeId: r.clusterPlaceId,
    __row: r,
  };
}

/**
 * The members of this Trail in the Trail objective's order for this viewer, or
 * null when the surface does not rank (either flag off). A member out of active
 * rotation is not a pick (§7). The caller builds the module from the order.
 */
export async function trailPersonalizedPicks<R extends TrailPickRow>(
  sc: any, rows: readonly R[], viewerId: string | null, nowMs: number,
): Promise<R[] | null> {
  const objective = await loadSurfaceObjective(sc, "trail");
  if (!objective) return null;
  const eligible = rows.filter((r) => r.content_state !== "archived_from_active_rotation");
  const viewer = viewerId ? await loadPdeViewer(sc, viewerId, null) : null;
  const ctx: ViewerContext = {
    userId: viewerId ?? "anonymous",
    nowMs,
    followedIds: viewer?.followedIds,
    placeAffinities: viewer?.placeAffinities,
    trailAffinity: Object.fromEntries(eligible.map((r) => [r.id, Math.max(0, Math.min(1, Number(r.confidence) || 0))])),
  };
  return rankOnSurfaceObjective(eligible.map(trailPickCandidate), ctx, objective).map((s) => s.candidate.__row);
}

// ── Trending: inside each claimed state ──────────────────────────────────────

export interface TrendingObjectiveRow { place_id: string; trend_state: string; velocity: number | null }

const placeKeyOf = (placeId: string) => placeId.replace(/^db\//, "").toLowerCase();

/**
 * The located rows, already in D-W10-R1-13's order, re-ordered INSIDE each
 * state by the Trending objective. Null objective ⇒ the SAME array. A failed
 * feature read ⇒ the same array too: the objective re-orders, it never
 * decides what is listed, so an unread input leaves the decided order.
 */
export async function trendingObjectiveOrder<R extends TrendingObjectiveRow>(sc: any, rows: R[], nowMs: number): Promise<R[]> {
  if (rows.length < 2) return rows;
  const objective = await loadSurfaceObjective(sc, "trending");
  if (!objective) return rows;
  let meta: Map<string, { created_at: string | null; saved_count: number | null; verified: boolean | null; category: string | null }>;
  try {
    const { data, error } = await sc.from("discovery_places").select("id, created_at, saved_count, verified, category")
      .in("id", [...new Set(rows.map((r) => placeKeyOf(r.place_id)))]);
    if (error || !Array.isArray(data)) return rows;
    meta = new Map((data as Array<Record<string, unknown>>).map((d) => [String(d["id"]).toLowerCase(), {
      created_at: typeof d["created_at"] === "string" ? d["created_at"] : null,
      saved_count: typeof d["saved_count"] === "number" ? d["saved_count"] : null,
      verified: typeof d["verified"] === "boolean" ? d["verified"] : null,
      category: typeof d["category"] === "string" ? d["category"] : null,
    }]));
  } catch {
    return rows;
  }
  const out: R[] = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j]!.trend_state === rows[i]!.trend_state) j++;
    const group = rows.slice(i, j);
    const cands = group.map((r) => {
      const m = meta.get(placeKeyOf(r.place_id));
      return { id: r.place_id, kind: "place" as const, createdAt: m?.created_at ?? null, likeCount: m?.saved_count ?? null, verified: m?.verified ?? null, category: m?.category ?? null, __row: r };
    });
    // Velocity is normalised inside its state (the fastest = 1) because the
    // ranker clamps a momentum input to [0,1]; the owner's cap then bounds it.
    const top = Math.max(0, ...group.map((r) => (typeof r.velocity === "number" && Number.isFinite(r.velocity) ? r.velocity : 0)));
    const ctx: ViewerContext = {
      userId: "trending", nowMs,
      localMomentum: top > 0 ? Object.fromEntries(group.filter((r) => typeof r.velocity === "number" && r.velocity > 0).map((r) => [r.place_id, (r.velocity as number) / top])) : {},
    };
    out.push(...rankOnSurfaceObjective(cands, ctx, objective).map((s) => s.candidate.__row));
    i = j;
  }
  return out;
}

// ── Trip Planning: GET /trips/:tripId/nearby-places ──────────────────────────

export interface TripPlanningPlace { id: string; category?: string | null; lat?: number | null; lng?: number | null }
export interface PlannedTrip { destination_city?: string | null; destination_lat?: number | null; destination_lng?: number | null }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The trip's nearby places in the Trip Planning objective's order, or the SAME
 * array when the surface does not rank. Trip fit uses the §78 kernel with the
 * planned trip as the context whatever its dates — a trip being planned is the
 * trip in question (D-W11X1-4). A failed saves read leaves the input order.
 */
export async function tripPlanningObjectiveOrder<P extends TripPlanningPlace>(
  sc: any, viewerId: string, trip: PlannedTrip, places: P[], nowMs: number = Date.now(),
): Promise<P[]> {
  if (places.length < 2) return places;
  const objective = await loadSurfaceObjective(sc, "trip_planning");
  if (!objective) return places;
  let saves: Map<string, number>;
  try {
    const { data, error } = await sc.from("discovery_places").select("id, saved_count").in("id", places.map((p) => p.id));
    if (error || !Array.isArray(data)) return places;
    saves = new Map((data as Array<Record<string, unknown>>).filter((d) => finite(d["saved_count"])).map((d) => [String(d["id"]), d["saved_count"] as number]));
  } catch {
    return places;
  }
  const viewer = await loadPdeViewer(sc, viewerId, trip.destination_city ?? null);
  const { cands, ctx } = tripPlanningRankInputs(viewerId, trip, places, saves, viewer.categoryAffinities, nowMs);
  return rankOnSurfaceObjective(cands, ctx, objective).map((s) => s.candidate.__place);
}

/**
 * The Trip Planning ranker's inputs, PURE: trip fit (the §78 kernel, the planned
 * trip as the context whatever its dates), route fit (distance from the trip's
 * destination), saves and the viewer's category affinity. Exported so each
 * input is pinned on its own, not only through the order it produces.
 */
export function tripPlanningRankInputs<P extends TripPlanningPlace>(
  viewerId: string, trip: PlannedTrip, places: readonly P[], saves: ReadonlyMap<string, number>,
  categoryAffinities: Record<string, number> | undefined, nowMs: number,
): { cands: Array<RankCandidate & { __place: P }>; ctx: ViewerContext } {
  const tripMatch = tripFitMap(places, [{
    id: "planned", destinationCity: trip.destination_city ?? null,
    destinationLat: finite(trip.destination_lat) ? trip.destination_lat : null, destinationLng: finite(trip.destination_lng) ? trip.destination_lng : null,
    startDate: new Date(nowMs).toISOString(), endDate: null, status: null,
  }], { city: trip.destination_city ?? null, nowMs });
  const cands = places.map((p) => ({
    id: p.id, kind: "gem" as const, category: p.category ?? null, likeCount: saves.get(p.id) ?? null,
    distanceKm: finite(p.lat) && finite(p.lng) && finite(trip.destination_lat) && finite(trip.destination_lng)
      ? haversineKm(trip.destination_lat, trip.destination_lng, p.lat, p.lng) : null,
    __place: p,
  }));
  return { cands, ctx: { userId: viewerId, nowMs, categoryAffinities, tripMatch } };
}
