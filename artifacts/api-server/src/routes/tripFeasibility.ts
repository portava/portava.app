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

    // trip_commitments.place_id has no foreign key by design (§5.2), so there
    // is no coordinate to resolve without the canonical place bridge. Both
    // endpoints are therefore null and the provider answers NO_COORDINATES —
    // which is the truth, and which produces UNKNOWN rather than a guess.
    const fromPlace: GeoPoint | null = null;
    const toPlace: GeoPoint | null = null;

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

  res.json({
    tripId,
    commitmentCount: rows.length,
    evaluatedHops: legs.length,
    verdict: folded.verdict,
    confidence: folded.confidence,
    worstSlackMinutes: folded.worstSlackMinutes,
    offendingHopIndex: folded.offendingIndex,
    hops,
    provider: { id: PROVIDER.id, routed: PROVIDER.routed },
    // Always present, and always true today. A client that renders a verdict
    // without it is showing a measurement that was never made.
    disclosure: FEASIBILITY_UNVERIFIED_DISCLOSURE,
  });
}));

export default router;
