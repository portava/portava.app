/**
 * Trips §5.1 — the STRUCTURE read surface: the stage spine and what hangs off it.
 *
 * GET /trips/:tripId/structure
 *
 * WHAT THIS CLOSES
 * ================
 * Measured 2026-09-09: trip_stages, trip_legs and trip_plan_participants had no
 * reader anywhere in the server or the app. Migrations 2760, 2761 and 2771
 * created them, kernel commands from 2764, 2765 and 2772 write them, and
 * nothing could see the result. A stage a user cannot be shown is not a stage.
 *
 * THE JOINS ARE THE POINT
 * =======================
 * §5.1's stage spine is a graph: a leg connects TWO stages, a commitment hangs
 * off ONE, and an attendance row belongs to a plan item. Serving four flat
 * lists would put the join in every client, and each client would get the
 * dangling cases wrong differently. So the response nests, and it names the
 * dangling references rather than dropping them:
 *
 *   `orphanedLegs`         a leg whose from/to stage is not in this trip's set
 *   `orphanedCommitments`  a commitment whose stage_id is not either
 *   `orphanedAttendance`   an attendance row whose plan item is not either
 *
 * All three are FK-enforced today, so all three should be empty — which is
 * exactly why they are reported rather than assumed: a count that should
 * always be zero is worth showing, because the day it is not, silence would
 * have been a dropped row.
 *
 * §20.1 OUTCOMES
 * ==============
 * `trip_outcomes` is what ACTUALLY happened, and it is served here beside the
 * plan because the pair is the point: a plan element with no outcome is
 * unresolved, one with a `completed` outcome happened, and one with a
 * `missed` outcome did not. Those three are what Memory and Passport read
 * post-trip, and none of them is derivable from the plan alone.
 *
 * `plan_id` carries no foreign key by design (§5.2) — the plan a completed
 * outcome refers to may be removed while the fact that it happened must not
 * be. So an outcome naming a plan item this trip no longer has is NOT
 * orphaned data: it is the case the missing FK exists for, and it is served
 * with `planPresent: false` rather than dropped or listed as a defect.
 *
 * §9.1's PARTY
 * ============
 * The set of people a plan's transport, reservations and budget are computed
 * for is the rows in state `going` — the column comment on
 * trip_plan_participants.attendance_state says so. `goingUserIds` is that set,
 * computed once here rather than in each consumer, because `interested` and
 * `maybe` being counted as attending is the arithmetic error this exists to
 * prevent.
 *
 * FAIL-CLOSED
 * ===========
 * Every read is bound and any failure refuses the whole response. A partial
 * structure is worse than none: a trip whose legs could not be read renders as
 * a set of disconnected stages, which is a picture of a different trip.
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();
const log = logger.child({ mod: "tripStructure" });
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** §9.1: the party is the rows in `going`, and only those. */
export const ATTENDING_STATE = "going";

router.get("/trips/:tripId/structure", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  let failed: string | null = null;
  async function readTrip(table: string, cols: string, order?: string): Promise<any[]> {
    if (failed) return [];
    let q = sc!.from(table).select(cols).eq("trip_id", tripId);
    if (order) q = q.order(order, { ascending: true, nullsFirst: false });
    const { data, error } = await q;
    if (error) { log.warn({ err: error.message, tripId, table }, "structure: read failed"); failed = table; return []; }
    return (data ?? []) as any[];
  }

  const stages = await readTrip("trip_stages",
    "id, stage_type, place_id, city_id, timezone, starts_at, ends_at, state, sequence", "sequence");
  const legs = await readTrip("trip_legs",
    "id, from_stage_id, to_stage_id, leg_type, starts_at, ends_at, source_ref", "starts_at");
  const commitments = await readTrip("trip_commitments",
    "id, stage_id, type, starts_at, required_arrival_at, place_id, lateness_tolerance, prep_duration, flexibility, confidence, source_ref",
    "starts_at");
  const planItems = await readTrip("trip_plan_items", "id, title, day_date, starts_at, removed_at", "day_date");
  const outcomes = await readTrip("trip_outcomes",
    "id, stage_id, plan_id, outcome_type, occurred_at, evidence_json", "occurred_at");

  if (failed) {
    // A partial structure is a picture of a DIFFERENT trip. See the header.
    sendError(res, "degraded_unavailable",
      `Could not read this trip's ${String(failed).replace("trip_", "").replace(/_/g, " ")}`);
    return;
  }

  const livePlanIds = planItems.filter((p) => p.removed_at === null).map((p) => p.id as string);

  // Attendance is keyed by plan_id, not trip_id, so it needs its own read
  // scoped to this trip's plan items. An empty plan list means no attendance
  // rows to fetch — and `.in()` with an empty array is a query that returns
  // nothing anyway, so it is skipped rather than issued.
  let attendance: any[] = [];
  if (livePlanIds.length > 0) {
    const { data, error } = await sc
      .from("trip_plan_participants")
      .select("plan_id, user_id, attendance_state, role")
      .in("plan_id", livePlanIds);
    if (error) {
      log.warn({ err: error.message, tripId }, "structure: attendance read failed");
      sendError(res, "degraded_unavailable", "Could not read this trip's plan attendance");
      return;
    }
    attendance = (data ?? []) as any[];
  }

  const stageIds = new Set(stages.map((s) => s.id as string));
  const planIdSet = new Set(livePlanIds);
  /** Every plan item this trip has, removed ones included: an outcome may name
   *  a soft-deleted plan, and "the plan is gone entirely" is a different fact
   *  from "the plan was removed". */
  const allPlanIds = new Set(planItems.map((p) => p.id as string));

  const orphanedLegs = legs
    .filter((l) => !stageIds.has(l.from_stage_id) || !stageIds.has(l.to_stage_id))
    .map((l) => l.id as string);
  const orphanedCommitments = commitments
    .filter((c) => c.stage_id !== null && !stageIds.has(c.stage_id))
    .map((c) => c.id as string);
  const orphanedAttendance = attendance
    .filter((a) => !planIdSet.has(a.plan_id))
    .map((a) => `${a.plan_id}:${a.user_id}`);

  const byPlan = new Map<string, Array<{ userId: string; attendanceState: string; role: string | null }>>();
  for (const a of attendance) {
    if (!planIdSet.has(a.plan_id)) continue;
    const list = byPlan.get(a.plan_id) ?? [];
    list.push({ userId: a.user_id, attendanceState: a.attendance_state, role: a.role ?? null });
    byPlan.set(a.plan_id, list);
  }

  res.json({
    tripId,
    stages: stages.map((s) => ({
      id: s.id, stageType: s.stage_type, placeId: s.place_id, cityId: s.city_id,
      timezone: s.timezone, startsAt: s.starts_at, endsAt: s.ends_at,
      state: s.state, sequence: s.sequence,
      // Nested so a client does not re-derive the §5.1 graph, and gets the
      // dangling cases wrong in its own way.
      legsFrom: legs.filter((l) => l.from_stage_id === s.id).map((l) => l.id),
      legsTo: legs.filter((l) => l.to_stage_id === s.id).map((l) => l.id),
      commitmentIds: commitments.filter((c) => c.stage_id === s.id).map((c) => c.id),
    })),
    legs: legs.map((l) => ({
      id: l.id, fromStageId: l.from_stage_id, toStageId: l.to_stage_id,
      legType: l.leg_type, startsAt: l.starts_at, endsAt: l.ends_at, sourceRef: l.source_ref,
    })),
    commitments: commitments.map((c) => ({
      id: c.id, stageId: c.stage_id, type: c.type,
      startsAt: c.starts_at, requiredArrivalAt: c.required_arrival_at,
      placeId: c.place_id,
      // Postgres renders an interval as text. Passed through verbatim rather
      // than parsed to a number here — see routes/tripFeasibility.ts
      // intervalToMinutes for why a duration that cannot be read is not zero.
      latenessTolerance: c.lateness_tolerance, prepDuration: c.prep_duration,
      flexibility: c.flexibility, confidence: c.confidence, sourceRef: c.source_ref,
    })),
    planAttendance: [...byPlan.entries()].map(([planId, participants]) => ({
      planId,
      participants,
      /** §9.1's party: the `going` rows and ONLY those. `interested` and
       *  `maybe` are not attendance and must not be counted as it. */
      goingUserIds: participants.filter((p) => p.attendanceState === ATTENDING_STATE).map((p) => p.userId),
    })),
    /**
     * §20.1 — what actually happened. `planPresent` is false when the outcome
     * names a plan item this trip no longer carries, which is the case §5.2's
     * missing foreign key exists FOR: the plan can be removed, the fact that
     * it happened cannot. It is a label, not a defect, and it is deliberately
     * NOT in the orphan lists below.
     */
    outcomes: outcomes.map((o) => ({
      id: o.id, stageId: o.stage_id, planId: o.plan_id,
      outcomeType: o.outcome_type, occurredAt: o.occurred_at,
      evidence: o.evidence_json ?? {},
      planPresent: o.plan_id === null ? null : allPlanIds.has(o.plan_id as string),
      stagePresent: o.stage_id === null ? null : stageIds.has(o.stage_id as string),
    })),
    /** Should always be empty — the FKs enforce it. Reported rather than
     *  assumed, because the day one is not, silence would be a dropped row. */
    orphanedLegs,
    orphanedCommitments,
    orphanedAttendance,
  });
}));

export default router;
