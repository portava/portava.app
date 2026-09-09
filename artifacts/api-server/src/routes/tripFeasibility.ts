/**
 * Trips §7 — the feasibility read surface.
 *
 * GET /trips/:tripId/feasibility
 *
 * Evaluates §7.2's invariant across a trip's ordered commitments and returns a
 * verdict per hop plus a folded verdict for the day.
 *
 * WHAT THIS ROUTE WILL AND WILL NOT SAY
 * =====================================
 * There is no routing provider in this repository (see
 * services/trips/TravelTimeProvider.ts for the measurement across both trees).
 * So the honest answers this route can give are:
 *
 *   INFEASIBLE           proven, and SOUND — a straight line is a lower bound
 *                        on travel time, so a real route can only be longer.
 *   FEASIBLE_UNVERIFIED  it fits against that lower bound. The real route is
 *                        longer by an unknown amount.
 *   UNKNOWN              nothing could be computed.
 *
 * It will NOT return FEASIBLE, because nothing here measures a route. That is
 * not a limitation being worked around; it is the answer. `routed: false` and
 * `providerId` are in the response so a client cannot mistake one for the other,
 * and `disclosure` is the sentence to show.
 *
 * WHERE THE COORDINATES COME FROM, AND WHY THIS ROUTE USED TO BE INERT
 * ===================================================================
 * Both endpoints were hardcoded `null` here, with a comment saying
 * trip_commitments.place_id has no foreign key so there is nothing to resolve.
 * The FK really is absent (§5.2, deliberate), but the consequence was that the
 * provider answered NO_COORDINATES on EVERY hop, so this route could only ever
 * return UNKNOWN. An engine that can prove INFEASIBLE, behind a route that can
 * never ask it to, is the "built but not wired" case: it earns nothing.
 *
 * `place_id` denotes `public.places.id` — the canonical place table, the one
 * carrying `latitude`/`longitude` — and `resolvePlaces` below reads it. There
 * is still no FK, so three states have to stay apart and do:
 *
 *   place_id IS NULL          the commitment names no place. NO_COORDINATES.
 *   the row is not there      a DANGLING id. NO_COORDINATES for the verdict,
 *                             but counted and returned in `unresolvedPlaceIds`
 *                             so it is visible rather than silently the same
 *                             as "this commitment has no place".
 *   lat/lng are null          the place exists and is not located.
 *                             NO_COORDINATES.
 *
 * And the read itself failing is none of those: it is a 503, exactly like the
 * commitments read, because a day whose places could not be read is not a day
 * whose commitments are all in the same building.
 *
 * §7.4 RIDES ALONG, BECAUSE IT IS THE SAME SECTION
 * ================================================
 * §7.4 names FOUR spatial consistency checks and travel feasibility is only
 * the first. Serving the first alone, from a route called `/feasibility`, is
 * how three quarters of a section disappears: a client that gets a verdict
 * with no consistency findings beside it has no way to know that place
 * identity and stage locality were never examined.
 *
 * So `consistency` is in the response, and one of its four checks is
 * permanently UNCHECKABLE — route availability, which needs a transport-mode
 * policy this system does not have. That finding is EMITTED rather than
 * omitted for the same reason: a report covering three checks reads as clean
 * on all four.
 *
 * FAIL-CLOSED
 * ===========
 * Every read is checked. supabase-js RESOLVES on a database error rather than
 * throwing, so `error` is inspected on every call — a try/catch around these
 * reads would be dead code. A commitments read that fails becomes 503
 * `degraded_unavailable`, NOT an empty list: "this trip has no commitments" and
 * "we could not read them" are different statements, and only one of them is
 * safe to render as a feasible day.
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  checkFeasibility, foldFeasibility,
  type FeasibilityResult,
} from "../services/trips/TripFeasibilityEngine.js";
import {
  straightLineTravelTimeProvider,
  type GeoPoint,
} from "../services/trips/TravelTimeProvider.js";
import {
  checkSpatialConsistency, foldConsistency,
  type PlanForConsistency, type StageForConsistency,
} from "../services/trips/TripSpatialConsistency.js";

const router = Router();
const log = logger.child({ mod: "tripFeasibility" });

/**
 * The provider this deployment has. Swapping in a routed one is this one line;
 * every consumer already handles the `unknown` result and the UNVERIFIED
 * verdict, so nothing else changes and no branch is added.
 */
const PROVIDER = straightLineTravelTimeProvider;

export const FEASIBILITY_UNVERIFIED_DISCLOSURE =
  "Travel times are straight-line lower bounds, not measured routes. A schedule shown as workable may still not be.";

const UUID_RE = /^[0-9a-f-]{36}$/i;

interface CommitmentRow {
  id: string;
  type: string;
  starts_at: string | null;
  required_arrival_at: string | null;
  place_id: string | null;
  lateness_tolerance: string | null;
  prep_duration: string | null;
}

/**
 * Postgres renders an `interval` as text over PostgREST. Parse the shapes it
 * actually produces and return null — never 0 — for anything else: a duration
 * we could not read is not a duration of zero, and treating it as one is the
 * same class of error as treating an absent route as no travel.
 */
export function intervalToMinutes(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  // 'HH:MM:SS' or 'HH:MM:SS.ffffff', optionally with a leading 'N days '.
  const m = /^(?:(-?\d+)\s+days?\s+)?(-?\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (m) {
    const days = m[1] ? Number(m[1]) : 0;
    const hh = Number(m[2]);
    const sign = hh < 0 || (m[1] && days < 0) ? -1 : 1;
    const mins = Math.abs(days) * 1440 + Math.abs(hh) * 60 + Number(m[3]) + Number(m[4]) / 60;
    return sign * mins;
  }
  // 'N mins' / 'N min' / 'HH:MM'
  const hm = /^(-?\d+):(\d{2})$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Math.sign(Number(hm[1]) || 1) * Number(hm[2]);
  return null;
}

/** What a place lookup produced. `null` coords is a fact; a failed read is not. */
export interface ResolvedPlaces {
  /** place_id -> coordinates, or null when the row exists and is not located. */
  coords: Map<string, GeoPoint | null>;
  /** Ids that were asked for and came back with no row at all. */
  unresolved: string[];
}

/**
 * Resolve commitment place ids to coordinates in ONE read.
 *
 * Returns null — never an empty map — when the read fails. The caller turns
 * that into a 503. An empty map means "none of these places are located",
 * which is a completely different sentence and one that produces a verdict.
 */
export async function resolvePlaces(
  sc: { from: (t: string) => any },
  placeIds: string[],
): Promise<ResolvedPlaces | null> {
  const wanted = [...new Set(placeIds.filter((id): id is string => typeof id === "string" && id !== ""))];
  if (wanted.length === 0) return { coords: new Map(), unresolved: [] };

  const { data, error } = await sc
    .from("places")
    .select("id, latitude, longitude")
    .in("id", wanted);

  if (error) return null;

  const coords = new Map<string, GeoPoint | null>();
  for (const row of ((data ?? []) as Array<{ id: string; latitude: number | null; longitude: number | null }>)) {
    const lat = row.latitude;
    const lng = row.longitude;
    coords.set(
      row.id,
      typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng }
        : null,
    );
  }
  const unresolved = wanted.filter((id) => !coords.has(id));
  return { coords, unresolved };
}

router.get("/trips/:tripId/feasibility", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  const { data, error } = await sc
    .from("trip_commitments")
    .select("id, type, starts_at, required_arrival_at, place_id, lateness_tolerance, prep_duration")
    .eq("trip_id", tripId)
    .order("starts_at", { ascending: true, nullsFirst: false });

  if (error) {
    // NOT an empty itinerary. A day with no readable commitments is not a day
    // with no commitments, and the second reads as feasible.
    log.warn({ err: error.message, tripId }, "feasibility: commitments read failed");
    sendError(res, "degraded_unavailable", "Could not read this trip's commitments");
    return;
  }

  const rows = (data ?? []) as CommitmentRow[];
  const ordered = rows.filter((r) => r.starts_at !== null || r.required_arrival_at !== null);

  const places = await resolvePlaces(sc, ordered.map((r) => r.place_id ?? "").filter(Boolean));
  if (!places) {
    // Same rule as the commitments read one block up. An unreadable set of
    // places is not a set of unlocated places, and the second one produces
    // verdicts.
    log.warn({ tripId }, "feasibility: places read failed");
    sendError(res, "degraded_unavailable", "Could not read the places this trip's commitments are at");
    return;
  }
  /** null for "no place named", "no such row", and "row is not located" alike —
   *  the provider's NO_COORDINATES covers all three. `unresolvedPlaceIds` in the
   *  response is what keeps the dangling case distinguishable to a reader. */
  const pointOf = (id: string | null): GeoPoint | null => (id ? places.coords.get(id) ?? null : null);

  const legs: FeasibilityResult[] = [];
  const hops: Array<Record<string, unknown>> = [];

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];

    // The previous commitment's start is when the traveller is free to leave
    // it. There is no end time on a commitment (§7.1 does not give it one), so
    // this is the EARLIEST possible departure and therefore the most
    // optimistic input — consistent with the lower-bound reading everywhere
    // else here.
    const departFrom = prev.starts_at ? new Date(prev.starts_at) : null;
    if (!departFrom) continue;

    // Resolved above, in one read, against public.places. Still null whenever
    // the commitment names no place, names one that is not there, or names one
    // with no coordinates — see the header for why those three stay apart in
    // the response even though they produce the same verdict.
    const fromPlace: GeoPoint | null = pointOf(prev.place_id);
    const toPlace: GeoPoint | null = pointOf(next.place_id);

    const result = await checkFeasibility(
      PROVIDER,
      { departFrom, fromPlace },
      {
        toPlace,
        requiredArrivalAt: next.required_arrival_at ? new Date(next.required_arrival_at) : null,
        startsAt: next.starts_at ? new Date(next.starts_at) : null,
        prepMinutes: intervalToMinutes(next.prep_duration) ?? 0,
        latenessToleranceMinutes: intervalToMinutes(next.lateness_tolerance) ?? 0,
      },
    );

    legs.push(result);
    hops.push({
      fromCommitmentId: prev.id,
      toCommitmentId: next.id,
      verdict: result.verdict,
      slackMinutes: result.slackMinutes,
      travelMinutes: result.travelMinutes,
      prepMinutes: result.prepMinutes,
      latenessToleranceMinutes: result.latenessToleranceMinutes,
      usedStartAsArrival: result.usedStartAsArrival,
      confidence: result.confidence,
      unknownReason: result.unknownReason,
      routed: result.routed,
    });
  }

  const folded = foldFeasibility(legs);

  // ── §7.4, the other three checks ─────────────────────────────────────────
  // Read fail-closed like everything else: an unreadable plan or stage list is
  // a 503, never an empty finding list. "We found no inconsistencies" and "we
  // could not look" are the two sentences this whole route is arranged to keep
  // apart, and §7.4 is not exempt.
  const { data: planData, error: planErr } = await sc
    .from("trip_plan_items")
    .select("id, stage_id, starts_at, day_date, location_name, place_id, lat, lng")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (planErr) {
    log.warn({ err: planErr.message, tripId }, "feasibility: plan items read failed");
    sendError(res, "degraded_unavailable", "Could not read this trip's plan");
    return;
  }

  const { data: stageData, error: stageErr } = await sc
    .from("trip_stages")
    .select("id, starts_at, ends_at, timezone, place_id")
    .eq("trip_id", tripId);
  if (stageErr) {
    log.warn({ err: stageErr.message, tripId }, "feasibility: stages read failed");
    sendError(res, "degraded_unavailable", "Could not read this trip's stages");
    return;
  }

  const stageRows = (stageData ?? []) as Array<{
    id: string; starts_at: string | null; ends_at: string | null;
    timezone: string; place_id: string | null;
  }>;

  // The stage anchors need the same places table the hops used. Resolve the
  // ones not already fetched, and refuse if THAT read fails too.
  const stageAnchorIds = stageRows.map((r) => r.place_id ?? "").filter(Boolean);
  const stagePlaces = await resolvePlaces(sc, stageAnchorIds);
  if (!stagePlaces) {
    log.warn({ tripId }, "feasibility: stage anchor places read failed");
    sendError(res, "degraded_unavailable", "Could not read the places this trip's stages are anchored to");
    return;
  }

  const planRows: PlanForConsistency[] = ((planData ?? []) as any[]).map((p) => ({
    id: p.id,
    stageId: p.stage_id ?? null,
    startsAt: p.starts_at ?? null,
    dayDate: p.day_date ?? null,
    locationName: p.location_name ?? null,
    placeId: p.place_id ?? null,
    // A coordinate that is not a finite number is NOT a coordinate. Coercing
    // it would put a plan at 0,0 — off the coast of Ghana — and then measure
    // its distance from a stage in earnest.
    lat: typeof p.lat === "number" && Number.isFinite(p.lat) ? p.lat : null,
    lng: typeof p.lng === "number" && Number.isFinite(p.lng) ? p.lng : null,
  }));

  const stageList: StageForConsistency[] = stageRows.map((r) => ({
    id: r.id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    timezone: r.timezone,
    anchor: r.place_id ? stagePlaces.coords.get(r.place_id) ?? null : null,
  }));

  const consistency = checkSpatialConsistency(planRows, stageList);

  res.json({
    tripId,
    commitmentCount: rows.length,
    evaluatedHops: legs.length,
    /** Place ids named by a commitment with no row behind them. A dangling
     *  reference is a data defect, not an unlocated place, and only this field
     *  tells them apart. */
    unresolvedPlaceIds: places.unresolved,
    verdict: folded.verdict,
    confidence: folded.confidence,
    worstSlackMinutes: folded.worstSlackMinutes,
    offendingHopIndex: folded.offendingIndex,
    hops,
    provider: { id: PROVIDER.id, routed: PROVIDER.routed },
    // Always present, and always true today. A client that renders a verdict
    // without it is showing a measurement that was never made.
    disclosure: FEASIBILITY_UNVERIFIED_DISCLOSURE,
    /**
     * §7.4's other three checks. `verdict` folds them worst-first, and it
     * CANNOT be CONSISTENT today — route availability has no policy to check
     * against and emits a permanent UNCHECKABLE. That is the honest state of
     * §7.4 in this system, and hiding it would make the other three read as
     * the whole of it.
     */
    consistency: {
      verdict: foldConsistency(consistency),
      findings: consistency,
    },
  });
}));

export default router;
