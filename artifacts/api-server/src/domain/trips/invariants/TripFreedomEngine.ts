/**
 * Trips spec §7.3 — the TRIPS ADAPTER onto the Temporal Freedom Engine.
 *
 * §7.3, verbatim:
 *
 *   FreedomWindow { beginsAt endsAt origin requiredDestination participants
 *                   hardConstraints[] confidence }
 *   Trips queries the Temporal Freedom Engine for gaps between commitments.
 *   Discovery, Compass, Saved Ideas, and Buddy matching consume these windows
 *   rather than independently calculating "free time."
 *
 * And §7.2's second sentence:
 *
 *   Confirmed timelines may contain known conflicts only when explicitly
 *   overridden and visibly marked. A conflict is not silently rendered as a
 *   normal itinerary.
 *
 * WHERE THE ENGINE IS
 * ===================
 * The engine itself — the window arithmetic, the commitment ordering, the
 * conflict detection, the lower-bound rule and its reasons — is
 * `domain/temporal/TemporalFreedomEngine.ts`, a domain package of its own that
 * no context owns. It used to be this file. It moved because "Trips queries the
 * Temporal Freedom Engine" (§7.3) and the Layover spec §7 ("Layover is its
 * first high-stakes adapter"; "keep airport-specific logic in the Layover
 * adapter, not in the generalized engine") both describe ONE engine that each
 * context reaches through an adapter (census-layover L13, L59). An engine that
 * lived inside Trips' package, emitted a trip-named reason and took a
 * `tripStart`/`tripEnd` was Trips' engine, not the generalised one.
 *
 * WHAT THIS ADAPTER DOES
 * ======================
 * It is the only place Trips' vocabulary meets the engine's, and it changes
 * nothing a Trips consumer can observe. Every name its importers used is still
 * exported from here, with the same shape:
 *
 *   `tripStart` / `tripEnd`   are the engine's `horizonStart` / `horizonEnd`:
 *                             a trip's span is the horizon Trips asks about.
 *   `TRIP_TEMPORAL_CONFLICT`  is the reason every conflict carries on Trips'
 *                             wire (tripReasonCodes, TripHealth, the replan
 *                             and derived-event paths, the kernel's refusal).
 *                             The engine emits its context-free
 *                             TEMPORAL_CONFLICT; this adapter re-labels it and
 *                             changes nothing else about the conflict.
 *   the trip's two ends       the engine words the before-first / after-last
 *                             constraints in terms of its horizon; Trips' wire
 *                             has always said "trip", and still does.
 *
 * Commitments come in already translated: the routes and the projection build
 * `EngineCommitment`s from `trip_commitments` rows, which have no end column
 * (2761) — so `endsAt` is null for every Trips row and the window says
 * PREVIOUS_END_UNKNOWN — and which store confidence as a 0..1 number, not a
 * band, so Trips states no commitment confidence and the engine computes
 * exactly as it did before commitments could carry one.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR131: `grep -rli "FreedomWindow"` over the whole tree → nothing.
 * TR132: no gap computation; `trip_plan_items.category` admits 'free_time' as a
 * LABEL a person types, the opposite of a computed window. TR129/TR130: nothing
 * detects a conflict, so an impossible pair renders as an ordinary day list.
 * What DID exist is the §7.2 invariant itself, evaluated per hop by
 * domain/trips/invariants/TripFeasibilityEngine.ts against a straight-line LOWER
 * BOUND on travel time — and its header is the premise of the engine: there is
 * no routing provider in this repository, so a travel term can prove that
 * something does NOT fit, and can never prove that it does.
 *
 * NO OVERRIDE PATH EXISTS. `overridden` is always false and the type says so.
 * §7.2's "explicitly overridden" needs a command that records the override
 * (§40.3 states this as not built); detection and marking are what the engine
 * does.
 */
import {
  computeFreedomWindows as computeEngineFreedomWindows,
  detectPlanOverlaps as detectEnginePlanOverlaps,
  HORIZON_START_NO_ORIGIN_DETAIL, HORIZON_END_NO_DESTINATION_DETAIL,
  type FreedomInputs as EngineFreedomInputs,
  type FreedomResult as EngineFreedomResult,
  type FreedomWindow,
  type PlanForOverlap,
  type TemporalConflict as EngineTemporalConflict,
} from "../../temporal/TemporalFreedomEngine.js";

// Everything Trips' importers read that the engine already says in Trips' own
// terms is the engine's, re-exported unchanged: the same functions, the same
// closed vocabularies, the same shapes.
export {
  leaveAt, orderCommitments, freeGapFromPlan, spendableToleranceMinutes, commitmentBoundConfidence,
  HARD_CONSTRAINT_KINDS, TEMPORAL_CONFLICT_KINDS, COMMITMENT_HARD_CONSTRAINT_KINDS,
} from "../../temporal/TemporalFreedomEngine.js";
export type {
  FreedomPlace, HardConstraintKind, HardConstraint, WindowPosition, FreedomWindow, TemporalConflictKind,
  EngineCommitment, HopTravel, PlanForGap, PlanFreeGap, PlanForOverlap,
  CommitmentHardConstraintKind, CommitmentHardConstraint,
} from "../../temporal/TemporalFreedomEngine.js";

/** §7.2 on Trips' wire: the engine's conflict, under Trips' reason code. */
export interface TemporalConflict extends Omit<EngineTemporalConflict, "reason"> {
  reason: "TRIP_TEMPORAL_CONFLICT";
}

/** The engine's inputs with Trips' span: a trip's start and end are the horizon. */
export interface FreedomInputs extends Omit<EngineFreedomInputs, "horizonStart" | "horizonEnd"> {
  tripStart: Date | null;
  tripEnd: Date | null;
}

export interface FreedomResult extends Omit<EngineFreedomResult, "conflicts"> {
  conflicts: TemporalConflict[];
}

/** Trips' wording of the two horizon constraints, as its wire has always carried them. */
const TRIP_DETAIL_FOR: ReadonlyMap<string, string> = new Map([
  [HORIZON_START_NO_ORIGIN_DETAIL, "nothing precedes this window; where the trip begins is not a located place"],
  [HORIZON_END_NO_DESTINATION_DETAIL, "nothing follows this window before the trip ends"],
]);

function tripConflict(c: EngineTemporalConflict): TemporalConflict {
  return { ...c, reason: "TRIP_TEMPORAL_CONFLICT" };
}

function tripWindow(w: FreedomWindow): FreedomWindow {
  if (!w.hardConstraints.some((h) => TRIP_DETAIL_FOR.has(h.detail))) return w;
  return { ...w, hardConstraints: w.hardConstraints.map((h) => (TRIP_DETAIL_FOR.has(h.detail) ? { ...h, detail: TRIP_DETAIL_FOR.get(h.detail)! } : h)) };
}

/** §7.3 — the windows and §7.2 conflicts for a trip's commitments, in Trips' vocabulary. */
export function computeFreedomWindows(inputs: FreedomInputs): FreedomResult {
  const r = computeEngineFreedomWindows({
    commitments: inputs.commitments, hops: inputs.hops, participants: inputs.participants,
    horizonStart: inputs.tripStart, horizonEnd: inputs.tripEnd,
  });
  return { windows: r.windows.map(tripWindow), conflicts: r.conflicts.map(tripConflict), unplacedCommitmentIds: r.unplacedCommitmentIds };
}

/** §7.2 on the plan itself: overlapping plan items on a day, under Trips' reason code. */
export function detectPlanOverlaps(items: readonly PlanForOverlap[]): TemporalConflict[] {
  return detectEnginePlanOverlaps(items).map(tripConflict);
}
