/**
 * Trips §14.1 — `GET /trips/:tripId/map-projection`.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT A RENAME
 * ==============================================
 * `GET /trips/:tripId/plan/map` returns plan items that have coordinates. It
 * stays, and it is a marker list. census-trips TR254 states the gap this route
 * closes: a projection carries a VERSION and a GENERATED-AT, so a consumer can
 * say what state of the trip it is drawing and whether that state is current.
 * A marker list can answer neither, and two clients drawing the same trip from
 * it can disagree without either being able to notice.
 *
 * THE VERSION IS READ FIRST, AND ON PURPOSE
 * ========================================
 * `trips.version` is read BEFORE the layers, so `sourceTripVersion` names the
 * state the layers were read against rather than a version observed after
 * them. It can still race a concurrent command — the layers are not read in
 * one snapshot — and that is stated here rather than implied: this is a
 * READ-YOUR-WRITES-ish projection, not a serialisable one. What it guarantees
 * is attribution, not isolation.
 *
 * FAIL-CLOSED, PER LAYER RATHER THAN PER REQUEST
 * ==============================================
 * Every other Trips read surface in this pass refuses the WHOLE response when
 * any input fails, because a partial answer there is a different answer. A map
 * is the one place where that is wrong: a trip whose saved-ideas read failed
 * still has stages, and refusing everything would hide nine working layers
 * behind one broken one.
 *
 * So each layer carries its own status, and a failed read becomes
 * `{ status: "unread" }` — never an empty layer. The difference matters more
 * here than anywhere: on a map, nothing on the screen looks exactly like
 * nothing in the world.
 *
 * §14.4 IS ENFORCED, NOT TRUSTED
 * ==============================
 * Private lodging goes in its own layer AND the assembled projection is
 * re-checked by `assertNoPrivateLeak`, which throws. See the service header
 * for why a postcondition rather than a convention.
 *
 * §19.1 ENVELOPE, §19.2 PATH
 * ==========================
 * The response spreads the shared `TripProjectionEnvelope` — the two fields
 * this route always had (`generatedAt`, `sourceTripVersion`) plus
 * `projectionSchemaVersion` and `freshness`, from one instant. §19.2's path
 * for this projection is `GET /trips/:id/map`; routes/tripProjections.ts
 * registers it and calls `serveMapProjection` below, so the two paths cannot
 * serve two projections.
 */
import { Router, type Request, type Response } from "express";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  ok, unread, noSource, assertNoPrivateLeak, layerCensus, coordsOf,
  type Layer, type MapPoint, type TripMapProjection,
} from "../services/trips/TripMapProjection.js";
import { liveEnvelope, type TripProjectionEnvelope } from "../services/trips/TripProjectionEnvelope.js";
import { buildTripOpportunityProjection } from "../services/trips/TripOpportunityProjection.js";

const router = Router();
const log = logger.child({ mod: "tripMapProjection" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** §14.1's "active plans": not removed, and not cancelled. TR46 records that
 *  IN_PROGRESS does not exist, so "active" is the best this schema supports and
 *  the response says which reading was used. */
const INACTIVE_PLAN_STATUSES: ReadonlySet<string> = new Set(["cancelled", "declined"]);

router.get("/trips/:tripId/map-projection", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  await serveMapProjection(req, res, auth);
}));

/** The projection, after authentication. Shared with `GET /trips/:tripId/map` (routes/tripProjections.ts). */
export async function serveMapProjection(req: Request<{ tripId: string }>, res: Response, auth: { user: { id: string } }): Promise<void> {
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  // ── the version, first ───────────────────────────────────────────────────
  // NULL when unreadable, which makes the projection unattributable rather
  // than making it wrong. A default of 0 would be a version claim.
  let sourceTripVersion: number | null = null;
  {
    const { data, error } = await sc.from("trips").select("version").eq("id", tripId).maybeSingle();
    if (error) log.warn({ err: error.message, tripId }, "map projection: version unreadable");
    else if (data && typeof (data as any).version === "number") sourceTripVersion = (data as any).version;
  }

  /**
   * Read one table into a layer. A failure is `unread`, never `[]`.
   *
   * Takes a BUILT query rather than a table name and a column list — see the
   * same note in routes/tripStructure.ts. `.from(variable)` is invisible to
   * check:write-path-columns, which is the guard that would catch a column
   * this projection selects and the live schema does not have.
   */
  async function layer(
    table: string,
    q: PromiseLike<{ data: unknown; error: { message: string } | null }>,
    project: (rows: any[]) => MapPoint[],
  ): Promise<Layer<MapPoint>> {
    const { data, error } = await q;
    if (error) {
      log.warn({ err: error.message, tripId, table }, "map projection: layer unread");
      return unread(`${table} could not be read`);
    }
    return ok(project((data ?? []) as any[]));
  }

  /**
   * Resolve `places` rows to coordinates for a set of ids, in one read.
   *
   * Returns null when the READ failed, which the callers turn into an `unread`
   * layer. An empty map means "none of these places are located", which is a
   * completely different sentence and yields an `ok` layer with fewer points.
   */
  async function placeCoords(ids: string[]): Promise<Map<string, { lat: number; lng: number }> | null> {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (wanted.length === 0) return new Map();
    const { data, error } = await sc!.from("places").select("id, latitude, longitude").in("id", wanted);
    if (error) return null;
    const out = new Map<string, { lat: number; lng: number }>();
    for (const p of ((data ?? []) as any[])) {
      const c = coordsOf(p.latitude, p.longitude);
      if (c) out.set(p.id, c);
    }
    return out;
  }

  // ── stage (§14.1 "stage") ────────────────────────────────────────────────
  // trip_stages carries place_id/city_id, not lat/lng, so a stage's point is
  // its anchor's. A stage with no resolvable anchor is not a map object and is
  // simply absent — distinct from the layer being unread, which is what a
  // FAILED anchor read produces.
  let stagePoints: Layer<MapPoint> = unread("not read");
  {
    const { data, error } = await sc
      .from("trip_stages")
      .select("id, stage_type, state, sequence, place_id")
      .eq("trip_id", tripId);
    if (error) {
      log.warn({ err: error.message, tripId }, "map projection: stages unread");
      stagePoints = unread("trip_stages could not be read");
    } else {
      const rows = (data ?? []) as any[];
      const coords = await placeCoords(rows.map((s) => s.place_id ?? ""));
      if (coords === null) {
        // The stages read fine and their locations did not. An unread LAYER,
        // not a set of unlocated stages.
        stagePoints = unread("the places these stages are anchored to could not be read");
      } else {
        stagePoints = ok(rows.flatMap((s) => {
          const c = s.place_id ? coords.get(s.place_id) : undefined;
          if (!c) return [];
          return [{
            id: s.id, kind: "stage", lat: c.lat, lng: c.lng,
            label: s.stage_type ?? null,
            meta: { state: s.state, sequence: s.sequence },
          }];
        }));
      }
    }
  }

  // ── plan items feed three layers, from ONE read ──────────────────────────
  // active plans, private anchors and meetup points all come from
  // trip_plan_items. Reading it once means the three cannot disagree about
  // which items exist, and means one failure marks all three unread rather
  // than three of them differently.
  let activePlans: Layer<MapPoint> = unread("not read");
  let privateAnchors: Layer<MapPoint> = unread("not read");
  let meetupPoints: Layer<MapPoint> = unread("not read");
  {
    const { data, error } = await sc
      .from("trip_plan_items")
      .select("id, title, category, status, lat, lng, location_is_private, location_name")
      .eq("trip_id", tripId)
      .is("removed_at", null);
    if (error) {
      log.warn({ err: error.message, tripId }, "map projection: plan items unread");
      const why = "trip_plan_items could not be read";
      activePlans = unread(why); privateAnchors = unread(why); meetupPoints = unread(why);
    } else {
      const rows = (data ?? []) as any[];
      const active: MapPoint[] = [];
      const anchors: MapPoint[] = [];
      const meetups: MapPoint[] = [];
      for (const r of rows) {
        const c = coordsOf(r.lat, r.lng);
        if (!c) continue;              // no coordinates, not a map object
        const base = { id: r.id, lat: c.lat, lng: c.lng, label: r.title ?? r.location_name ?? null };

        // §14.4. A private-flagged item goes to the anchors layer and NOWHERE
        // else — not also to active plans, not also to meetup points. This
        // `continue` is the enforcement; assertNoPrivateLeak below is the
        // proof that it worked.
        if (r.location_is_private === true) {
          anchors.push({ ...base, kind: "private_anchor", privateAnchor: true,
            meta: { category: r.category } });
          continue;
        }
        if (r.category === "meeting_point") {
          meetups.push({ ...base, kind: "meetup_point", meta: { status: r.status } });
          continue;
        }
        if (!INACTIVE_PLAN_STATUSES.has(String(r.status ?? ""))) {
          active.push({ ...base, kind: "plan", meta: { category: r.category, status: r.status } });
        }
      }
      activePlans = ok(active); privateAnchors = ok(anchors); meetupPoints = ok(meetups);
    }
  }

  // ── confirmed commitments (§14.1) ────────────────────────────────────────
  // trip_commitments.place_id denotes public.places.id, as routes/
  // tripFeasibility.ts established. A commitment with no resolvable place is
  // not a map object.
  let confirmedCommitments: Layer<MapPoint> = unread("not read");
  {
    const { data, error } = await sc
      .from("trip_commitments")
      .select("id, type, place_id, starts_at, required_arrival_at, confidence")
      .eq("trip_id", tripId);
    if (error) confirmedCommitments = unread("trip_commitments could not be read");
    else {
      const rows = (data ?? []) as any[];
      const coords = await placeCoords(rows.map((r) => r.place_id ?? ""));
      if (coords === null) {
        confirmedCommitments = unread("the places these commitments are at could not be read");
      } else {
        confirmedCommitments = ok(rows.flatMap((r) => {
          const c = r.place_id ? coords.get(r.place_id) : undefined;
          if (!c) return [];
          return [{
            id: r.id, kind: "commitment", lat: c.lat, lng: c.lng, label: r.type ?? null,
            meta: { startsAt: r.starts_at, requiredArrivalAt: r.required_arrival_at, confidence: r.confidence },
          }];
        }));
      }
    }
  }

  // ── saved ideas (§14.1) ──────────────────────────────────────────────────
  const savedIdeas = await layer(
    "trip_saved_places",
    sc.from("trip_saved_places")
      .select("id, place_name, place_type, lat, lng")
      .eq("trip_id", tripId),
    (rows) => rows.flatMap((r) => {
      const c = coordsOf(r.lat, r.lng);
      return c ? [{ id: r.id, kind: "saved_idea", lat: c.lat, lng: c.lng,
                    label: r.place_name ?? null, meta: { placeType: r.place_type } }] : [];
    }),
  );

  // Stated, not omitted. A projection carrying seven layers must not be
  // mistaken for one carrying ten, three of them empty. And a `no_source` is
  // the strongest claim this projection makes about a layer — that NOTHING in
  // the system produces it — so each of these names an obstacle that was
  // re-read rather than cited. See the route-chains block above for what
  // happens when one is not.
  // ── the layers that genuinely have no producer ───────────────────────────
  const crewPresenceSummaries: Layer<MapPoint> = noSource(
    "Crew presence is served as summary CARDS by GET /trips/:id/crew/map and deliberately carries no coordinates unless a live-share grant exists (§14.4). It is not a coordinate layer and is not synthesised into one here.",
  );
  // ── route chains (§14.1, §14.2) ──────────────────────────────────────────
  //
  // THIS LAYER SHIPPED AS `no_source` ON A FALSE PREMISE, AND THAT IS WORTH
  // RECORDING WHERE THE CODE IS.
  //
  // Its reason string said "route_plans/route_stops are owner-only by RLS
  // (census-trips TR261), so a trip's crew cannot read the trip's own route
  // chain." Both halves are wrong. `0058_trip_flow.sql` creates
  // `route_plans_member_select` (:32), `route_stops_member_select` (:85) and
  // `route_legs_member_select` (:127) — three member-read policies, the first
  // of them two lines below the owner-only one the census cited and stopped
  // at. And it would not have mattered here anyway: this route reads through
  // the service client after `requireTripMember`, which bypasses RLS entirely.
  //
  // A `no_source` is a claim that nothing in the system produces a layer. It
  // is the strongest thing this projection says about a layer and it was made
  // from a citation nobody re-read. The layer is real, so here it is.
  //
  // The stops carry `structured_location` — a jsonb `{label, lat, lng}` — so a
  // stop is a point when that object holds finite coordinates and is not one
  // otherwise, exactly as everywhere else in this file.
  let routeChains: Layer<MapPoint> = unread("not read");
  {
    const { data: plans, error: planErr } = await sc
      .from("route_plans")
      .select("id, title, status")
      .eq("trip_id", tripId);
    if (planErr) {
      log.warn({ err: planErr.message, tripId }, "map projection: route plans unread");
      routeChains = unread("route_plans could not be read");
    } else {
      const planRows = (plans ?? []) as any[];
      if (planRows.length === 0) {
        routeChains = ok([]);
      } else {
        const byPlan = new Map(planRows.map((p) => [p.id as string, p]));
        const { data: stops, error: stopErr } = await sc
          .from("route_stops")
          .select("id, route_plan_id, title, structured_location, order_index, checkpoint_status")
          .in("route_plan_id", planRows.map((p) => p.id as string));
        if (stopErr) {
          // The plans read and their stops did not. An unread LAYER, not a set
          // of routes with no stops.
          log.warn({ err: stopErr.message, tripId }, "map projection: route stops unread");
          routeChains = unread("route_stops could not be read");
        } else {
          routeChains = ok(((stops ?? []) as any[]).flatMap((st) => {
            const loc = (st.structured_location ?? {}) as Record<string, unknown>;
            const c = coordsOf(loc.lat, loc.lng);
            if (!c) return [];
            const plan = byPlan.get(st.route_plan_id);
            return [{
              id: st.id, kind: "route_stop", lat: c.lat, lng: c.lng,
              label: st.title ?? (typeof loc.label === "string" ? loc.label : null),
              meta: {
                routePlanId: st.route_plan_id,
                routeTitle: plan?.title ?? null,
                routeStatus: plan?.status ?? null,
                orderIndex: st.order_index,
                checkpointStatus: st.checkpoint_status,
              },
            }];
          }));
        }
      }
    }
  }
  // §14.1 live opportunities (§13): every open window's EXECUTABLE
  // experiences that have a point. A refused projection is UNREAD, by reason.
  let liveOpportunities: Layer<MapPoint>;
  {
    const savedPoints = new Map<string, { lat: number; lng: number }>(savedIdeas.status === "ok" ? savedIdeas.items.map((pt) => [pt.id, { lat: pt.lat, lng: pt.lng }]) : []);
    const built = await buildTripOpportunityProjection(sc, tripId, user.id);
    if (!built.ok) liveOpportunities = unread(`opportunity projection unavailable (${built.reason}): ${built.message}`);
    else liveOpportunities = ok(built.projection.windows.flatMap((w) => w.executable).filter((e, i, all) => all.findIndex((x) => x.candidateId === e.candidateId) === i).flatMap((e) => {
      const c = savedPoints.get(e.candidateId);
      if (!c) return [];
      return [{ id: e.id, kind: "opportunity", lat: c.lat, lng: c.lng, label: e.name, meta: { primitive: e.primitive, arriveAt: e.arriveAt, leaveBy: e.leaveBy, stayMinutes: e.stayMinutes, score: e.score, windowId: e.windowId } }];
    }));
  }
  const safetyPoints: Layer<MapPoint> = noSource(
    "No trip-scoped safety or logistics point store exists. Safe Return sessions are not map points.",
  );

  const projection: TripMapProjection & TripProjectionEnvelope = {
    ...liveEnvelope(sourceTripVersion),
    tripId,
    stage: stagePoints,
    privateAnchors,
    activePlans,
    confirmedCommitments,
    savedIdeas,
    crewPresenceSummaries,
    routeChains,
    meetupPoints,
    liveOpportunities,
    safetyPoints,
  };

  // §14.4, proved rather than assumed. Throwing here is deliberate: the thing
  // it catches is a coding mistake above, and the only useful response to one
  // is to refuse to serve the projection.
  try {
    assertNoPrivateLeak(projection);
  } catch (e: any) {
    log.error({ err: e?.message, tripId }, "§14.4 private anchor leak — projection refused");
    sendError(res, "db_error", "The map projection could not be assembled safely");
    return;
  }

  res.json({
    ...projection,
    /** How many of §14.1's ten layers carry data, could not be read, and have
     *  no producer. Present so "eight layers arrived" is never read as "ten
     *  arrived, two empty". */
    census: layerCensus(projection),
    /** TR46: there is no IN_PROGRESS status, so "active" means not removed and
     *  not cancelled. Said in the response rather than assumed by the reader. */
    activePlanReading: "not removed and not cancelled; TR46 — no IN_PROGRESS status exists",
  });
}

export default router;
