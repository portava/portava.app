/**
 * Trips spec §7.3 — the Temporal Freedom Engine, PURE.
 *
 * §7.3, verbatim:
 *
 *   FreedomWindow { beginsAt endsAt origin requiredDestination participants
 *                   hardConstraints[] confidence }
 *   Trips queries the Temporal Freedom Engine for gaps between commitments.
 *   Discovery, Compass, Saved Ideas, and Buddy matching consume these windows
 *   rather than independently calculating "free time."
 *
 * And §7.2's second sentence, which is the other half of this file:
 *
 *   Confirmed timelines may contain known conflicts only when explicitly
 *   overridden and visibly marked. A conflict is not silently rendered as a
 *   normal itinerary.
 *
 * WHAT EXISTED
 * ============
 * census-trips TR131: `grep -rli "FreedomWindow"` over the whole tree → nothing.
 * TR132: no gap computation; `trip_plan_items.category` admits 'free_time' as a
 * LABEL a person types, the opposite of a computed window. TR129/TR130: nothing
 * detects a conflict, so an impossible pair renders as an ordinary day list.
 * What DID exist is the §7.2 invariant itself, evaluated per hop by
 * services/trips/TripFeasibilityEngine.ts against a straight-line LOWER BOUND
 * on travel time — and its header is the premise of everything here: there is
 * no routing provider in this repository, so a travel term can prove that
 * something does NOT fit, and can never prove that it does.
 *
 * A WINDOW IS A LOWER BOUND ON FREE TIME, OR IT IS NOT A WINDOW
 * =============================================================
 * Every choice below leans the same way the feasibility engine leans: when two
 * readings are possible, the window is the SMALLER one, so that a consumer
 * (Compass proposing a plan, Discovery filling a gap) is never handed time
 * the traveller does not have.
 *
 *   beginsAt   the traveller is free to leave the previous commitment: its
 *              end when known, else its start — and never before the LATEST
 *              moment they were allowed to arrive at it (deadline + lateness
 *              tolerance). Leaving before you had to arrive is not a thing.
 *   endsAt     the moment they must LEAVE to make the next commitment:
 *              (requiredArrivalAt ?? startsAt) + latenessTolerance
 *              − travel(origin → destination) − prepDuration.
 *              The travel term is the provider's lower bound at the
 *              feasibility percentile; an unknown travel term is NOT zero —
 *              the window then ends at the deadline itself, is flagged
 *              TRAVEL_UNKNOWN and graded INSUFFICIENT, and is never certified.
 *   conflict   when endsAt ≤ beginsAt there is no window; there is a
 *              TRIP_TEMPORAL_CONFLICT, with the shortfall in minutes, and it
 *              is returned beside the windows rather than dropped. §7.2: not
 *              silently rendered.
 *
 * `certified` is HIGH confidence and no unknown term. With no routed provider
 * no window is certified today; the field exists so a consumer can ask, and
 * so §22.4's property ("an earlier hard commitment cannot increase the
 * preceding certified free window") has a subject. That property holds for
 * EVERY window this engine emits, certified or not, because the travel lower
 * bound satisfies the triangle inequality and prep is non-negative — the
 * test drives it with the real provider.
 *
 * NO OVERRIDE PATH EXISTS. `overridden` is always false and the type says so.
 * §7.2's "explicitly overridden" needs a command that records the override
 * (§40.3 states this as not built); detection and marking are what this file
 * does.
 */
import { worstTravelConfidence, type TravelConfidence } from "../../lib/travelEstimate.js";
import type { GeoPoint } from "./TravelTimeProvider.js";

const MS_PER_MIN = 60_000;

export interface FreedomPlace {
  placeId: string | null;
  point: GeoPoint | null;
}

/** §7.3 hardConstraints[] — what bounds this window, by name. */
export const HARD_CONSTRAINT_KINDS = [
  /** The destination commitment is `fixed` (§7.1 flexibility): the end cannot be negotiated. */
  "NEXT_IS_FIXED",
  /** The previous commitment has no end time; the window begins at its start. */
  "PREVIOUS_END_UNKNOWN",
  /** No travel term could be computed; the end is the deadline itself, optimistic. */
  "TRAVEL_UNKNOWN",
  /** The destination has no requiredArrivalAt; its start stood in. */
  "ARRIVAL_DEADLINE_ASSUMED_FROM_START",
  /** The window opens somewhere unknown (previous commitment has no located place). */
  "NO_ORIGIN",
  /** The window has no destination (nothing follows it). */
  "NO_DESTINATION",
] as const;
export type HardConstraintKind = (typeof HARD_CONSTRAINT_KINDS)[number];

export interface HardConstraint {
  kind: HardConstraintKind;
  commitmentId: string | null;
  detail: string;
}

export type WindowPosition = "before_first" | "between" | "after_last";

/** §7.3 FreedomWindow, every field, plus the ids that say what it sits between. */
export interface FreedomWindow {
  id: string;
  position: WindowPosition;
  /** ISO instants. */
  beginsAt: string;
  endsAt: string;
  durationMinutes: number;
  origin: FreedomPlace | null;
  requiredDestination: (FreedomPlace & { commitmentId: string; arriveBy: string }) | null;
  participants: string[];
  hardConstraints: HardConstraint[];
  confidence: TravelConfidence;
  /** HIGH confidence with no unknown term. Never true without a routed provider. */
  certified: boolean;
  /** Minutes taken off the end for travel + prep. null when travel is unknown. */
  reservedMinutes: number | null;
  afterCommitmentId: string | null;
  beforeCommitmentId: string | null;
}

export const TEMPORAL_CONFLICT_KINDS = [
  /** The next deadline (with tolerance) falls before the traveller is free to leave the previous commitment. */
  "OVERLAP",
  /** There is time between them, but not enough for travel + prep. */
  "NO_TIME_TO_TRAVEL",
  /** Two plan items on the same day overlap in time. */
  "PLAN_OVERLAP",
] as const;
export type TemporalConflictKind = (typeof TEMPORAL_CONFLICT_KINDS)[number];

export interface TemporalConflict {
  reason: "TRIP_TEMPORAL_CONFLICT";
  kind: TemporalConflictKind;
  commitmentIds: string[];
  planIds: string[];
  /** Minutes short. null when it could not be quantified. */
  shortfallMinutes: number | null;
  /** No override path exists (§40.3). Always false, and typed so. */
  overridden: false;
  detail: string;
}

/** A commitment as the engine reads it — the route translates rows into this. */
export interface EngineCommitment {
  id: string;
  type: string;
  startsAt: Date | null;
  requiredArrivalAt: Date | null;
  /** null: unknown. `trip_commitments` has no end column (2761). */
  endsAt: Date | null;
  place: FreedomPlace;
  /** §7.1 flexibility: fixed | shiftable | flexible. */
  flexibility: string;
  prepMinutes: number;
  latenessToleranceMinutes: number;
}

/** The travel term for one hop, as the feasibility engine reports it. */
export interface HopTravel {
  travelMinutes: number | null;
  confidence: TravelConfidence;
  routed: boolean;
  unknownReason: string | null;
}

export interface FreedomInputs {
  commitments: readonly EngineCommitment[];
  /** hops[i] is the travel from ordered commitment i to i+1. Length = commitments − 1. */
  hops: readonly HopTravel[];
  participants: readonly string[];
  tripStart: Date | null;
  tripEnd: Date | null;
}

export interface FreedomResult {
  windows: FreedomWindow[];
  conflicts: TemporalConflict[];
  /** Commitments with neither a start nor an arrival time: not on the line, not silently dropped. */
  unplacedCommitmentIds: string[];
}

function deadlineOf(c: EngineCommitment): Date | null {
  return c.requiredArrivalAt ?? c.startsAt;
}
function validDate(d: Date | null): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * When the traveller is free to leave `c`: its end when known, else its start,
 * and never before the latest moment they were allowed to arrive. The LATER
 * of the candidates, on purpose — see the header.
 */
export function leaveAt(c: EngineCommitment): Date | null {
  const end = validDate(c.endsAt) ? c.endsAt : (validDate(c.startsAt) ? c.startsAt : null);
  const dl = deadlineOf(c);
  const latestArrival = validDate(dl) ? new Date(dl.getTime() + c.latenessToleranceMinutes * MS_PER_MIN) : null;
  if (!end && !latestArrival) return null;
  if (!end) return latestArrival;
  if (!latestArrival) return end;
  return end.getTime() >= latestArrival.getTime() ? end : latestArrival;
}

/** Ordered by deadline (requiredArrivalAt ?? startsAt); the unplaceable set aside. */
export function orderCommitments(commitments: readonly EngineCommitment[]): { ordered: EngineCommitment[]; unplaced: string[] } {
  const placed = commitments.filter((c) => validDate(deadlineOf(c)));
  const unplaced = commitments.filter((c) => !validDate(deadlineOf(c))).map((c) => c.id);
  const ordered = [...placed].sort((a, b) => deadlineOf(a)!.getTime() - deadlineOf(b)!.getTime());
  return { ordered, unplaced };
}

export function computeFreedomWindows(inputs: FreedomInputs): FreedomResult {
  const { ordered, unplaced } = orderCommitments(inputs.commitments);
  if (inputs.hops.length !== Math.max(0, ordered.length - 1)) {
    throw new Error(`computeFreedomWindows: ${ordered.length} placed commitment(s) need ${Math.max(0, ordered.length - 1)} hop(s), got ${inputs.hops.length}`);
  }
  const participants = [...inputs.participants];
  const windows: FreedomWindow[] = [];
  const conflicts: TemporalConflict[] = [];

  const push = (w: Omit<FreedomWindow, "id" | "durationMinutes" | "certified" | "participants">) => {
    const begins = Date.parse(w.beginsAt); const ends = Date.parse(w.endsAt);
    const unknownTerm = w.hardConstraints.some((h) => h.kind === "TRAVEL_UNKNOWN" || h.kind === "PREVIOUS_END_UNKNOWN" || h.kind === "NO_ORIGIN");
    windows.push({
      ...w,
      id: `fw:${w.afterCommitmentId ?? "start"}:${w.beforeCommitmentId ?? "end"}`,
      durationMinutes: Math.round((ends - begins) / MS_PER_MIN),
      participants,
      certified: w.confidence === "HIGH" && !unknownTerm,
    });
  };

  // ── before the first commitment ──────────────────────────────────────────
  if (ordered.length > 0 && validDate(inputs.tripStart)) {
    const first = ordered[0]!;
    const deadline = deadlineOf(first)!;
    const endMs = deadline.getTime() + first.latenessToleranceMinutes * MS_PER_MIN - first.prepMinutes * MS_PER_MIN;
    if (endMs > inputs.tripStart.getTime()) {
      push({
        position: "before_first",
        beginsAt: inputs.tripStart.toISOString(), endsAt: new Date(endMs).toISOString(),
        origin: null,
        requiredDestination: { ...first.place, commitmentId: first.id, arriveBy: deadline.toISOString() },
        hardConstraints: [
          { kind: "NO_ORIGIN", commitmentId: null, detail: "nothing precedes this window; where the trip begins is not a located place" },
          { kind: "TRAVEL_UNKNOWN", commitmentId: first.id, detail: "no origin, so no travel term; the end is the deadline less prep" },
          ...(first.requiredArrivalAt === null ? [{ kind: "ARRIVAL_DEADLINE_ASSUMED_FROM_START" as const, commitmentId: first.id, detail: "no requiredArrivalAt; startsAt stood in" }] : []),
          ...(first.flexibility === "fixed" ? [{ kind: "NEXT_IS_FIXED" as const, commitmentId: first.id, detail: `${first.type} is fixed` }] : []),
        ],
        confidence: "INSUFFICIENT",
        reservedMinutes: null,
        afterCommitmentId: null, beforeCommitmentId: first.id,
      });
    }
  }

  // ── between consecutive commitments ──────────────────────────────────────
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    const hop = inputs.hops[i - 1]!;
    const begins = leaveAt(prev);
    if (!begins) continue; // cannot happen for a placed commitment; typed defensively
    const deadline = deadlineOf(next)!;
    const latestArrivalMs = deadline.getTime() + next.latenessToleranceMinutes * MS_PER_MIN;

    const constraints: HardConstraint[] = [];
    if (!validDate(prev.endsAt)) constraints.push({ kind: "PREVIOUS_END_UNKNOWN", commitmentId: prev.id, detail: `${prev.type} has no end time; the window begins at its start` });
    if (next.requiredArrivalAt === null) constraints.push({ kind: "ARRIVAL_DEADLINE_ASSUMED_FROM_START", commitmentId: next.id, detail: "no requiredArrivalAt; startsAt stood in" });
    if (next.flexibility === "fixed") constraints.push({ kind: "NEXT_IS_FIXED", commitmentId: next.id, detail: `${next.type} is fixed` });
    if (!prev.place.point) constraints.push({ kind: "NO_ORIGIN", commitmentId: prev.id, detail: `${prev.type} has no located place` });

    // The next deadline, with every tolerance, is before the traveller can
    // leave the previous commitment: an overlap, whatever the travel term.
    if (latestArrivalMs <= begins.getTime()) {
      conflicts.push({
        reason: "TRIP_TEMPORAL_CONFLICT", kind: "OVERLAP",
        commitmentIds: [prev.id, next.id], planIds: [],
        shortfallMinutes: Math.round((begins.getTime() - latestArrivalMs) / MS_PER_MIN),
        overridden: false,
        detail: `${next.type} must be reached by ${new Date(latestArrivalMs).toISOString()} but ${prev.type} does not release the traveller until ${begins.toISOString()}`,
      });
      continue;
    }

    let confidence: TravelConfidence = hop.confidence;
    let reservedMinutes: number | null;
    let endMs: number;
    if (hop.travelMinutes === null) {
      constraints.push({ kind: "TRAVEL_UNKNOWN", commitmentId: next.id, detail: `travel term unavailable (${hop.unknownReason ?? "unknown"}); the end is the deadline less prep, which is optimistic` });
      reservedMinutes = null;
      endMs = latestArrivalMs - next.prepMinutes * MS_PER_MIN;
      confidence = "INSUFFICIENT";
    } else {
      reservedMinutes = hop.travelMinutes + next.prepMinutes;
      endMs = latestArrivalMs - reservedMinutes * MS_PER_MIN;
    }
    if (constraints.some((c) => c.kind === "PREVIOUS_END_UNKNOWN" || c.kind === "ARRIVAL_DEADLINE_ASSUMED_FROM_START")) {
      confidence = worstTravelConfidence(confidence, "LOW");
    }

    if (endMs <= begins.getTime()) {
      // Time exists between them and travel + prep eats all of it. With an
      // unknown travel term this can still be reached when prep alone does.
      conflicts.push({
        reason: "TRIP_TEMPORAL_CONFLICT", kind: "NO_TIME_TO_TRAVEL",
        commitmentIds: [prev.id, next.id], planIds: [],
        shortfallMinutes: Math.round((begins.getTime() - endMs) / MS_PER_MIN),
        overridden: false,
        detail: hop.travelMinutes === null
          ? `${next.prepMinutes} min of preparation for ${next.type} does not fit before its deadline`
          : `${hop.travelMinutes} min of travel (a lower bound) plus ${next.prepMinutes} min of preparation does not fit between ${prev.type} and ${next.type}`,
      });
      continue;
    }

    push({
      position: "between",
      beginsAt: begins.toISOString(), endsAt: new Date(endMs).toISOString(),
      origin: prev.place,
      requiredDestination: { ...next.place, commitmentId: next.id, arriveBy: deadline.toISOString() },
      hardConstraints: constraints,
      confidence,
      reservedMinutes,
      afterCommitmentId: prev.id, beforeCommitmentId: next.id,
    });
  }

  // ── after the last commitment ────────────────────────────────────────────
  if (ordered.length > 0 && validDate(inputs.tripEnd)) {
    const last = ordered[ordered.length - 1]!;
    const begins = leaveAt(last);
    if (begins && inputs.tripEnd.getTime() > begins.getTime()) {
      push({
        position: "after_last",
        beginsAt: begins.toISOString(), endsAt: inputs.tripEnd.toISOString(),
        origin: last.place,
        requiredDestination: null,
        hardConstraints: [
          { kind: "NO_DESTINATION", commitmentId: null, detail: "nothing follows this window before the trip ends" },
          ...(!validDate(last.endsAt) ? [{ kind: "PREVIOUS_END_UNKNOWN" as const, commitmentId: last.id, detail: `${last.type} has no end time; the window begins at its start` }] : []),
        ],
        confidence: "LOW",
        reservedMinutes: 0,
        afterCommitmentId: last.id, beforeCommitmentId: null,
      });
    }
  }

  windows.sort((a, b) => Date.parse(a.beginsAt) - Date.parse(b.beginsAt));
  return { windows, conflicts, unplacedCommitmentIds: unplaced };
}

// ── §7.2 on the plan itself ───────────────────────────────────────────────────

export interface PlanForOverlap {
  id: string;
  dayDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * Two plan items on the same day whose times overlap. Only items with BOTH a
 * start and an end can overlap; an item with no end is not assumed to end
 * instantly, and not assumed to run all day — it is simply not judged.
 * Adjacent pairs after sorting by start; a chain of three overlapping items
 * yields two conflicts, one per adjacent pair.
 */
export function detectPlanOverlaps(items: readonly PlanForOverlap[]): TemporalConflict[] {
  const byDay = new Map<string, PlanForOverlap[]>();
  for (const it of items) {
    if (!it.dayDate || !it.startsAt || !it.endsAt) continue;
    const s = Date.parse(it.startsAt); const e = Date.parse(it.endsAt);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) continue;
    (byDay.get(it.dayDate) ?? byDay.set(it.dayDate, []).get(it.dayDate)!).push(it);
  }
  const out: TemporalConflict[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1]!; const b = list[i]!;
      const overlapMs = Date.parse(a.endsAt!) - Date.parse(b.startsAt!);
      if (overlapMs > 0) {
        out.push({
          reason: "TRIP_TEMPORAL_CONFLICT", kind: "PLAN_OVERLAP",
          commitmentIds: [], planIds: [a.id, b.id],
          shortfallMinutes: Math.round(overlapMs / MS_PER_MIN),
          overridden: false,
          detail: `plan items overlap by ${Math.round(overlapMs / MS_PER_MIN)} min on ${a.dayDate}`,
        });
      }
    }
  }
  return out;
}
