/**
 * The Temporal Freedom Engine — PURE, and owned by no context.
 *
 * It answers one question for any schedule: given the commitments a person
 * must keep, how much time is truly theirs between them, and when is that
 * time over? It owns usable time, the next commitment and the freedom window.
 * It owns no prose for a person to read beyond the one-line `detail` that
 * names a constraint or a conflict, and it calls no model.
 *
 * ── WHY THIS IS ITS OWN PACKAGE ─────────────────────────────────────────────
 * Every context that needs this answer reaches it through an ADAPTER that lives
 * with that context, translates the context's own records into
 * `EngineCommitment`s, and translates the answer back into the context's own
 * vocabulary (its conflict reason, its horizon, its places). This module
 * imports none of them and names none of them: no context's reason codes, no
 * context's tables, no context's horizon. Context-specific logic — why a
 * commitment does not wait, where a schedule begins, which reason code a
 * conflict carries on a context's wire — is an adapter's to state, and the
 * engine computes on what the adapter hands it. That boundary is asserted by
 * reading this file, not by this comment.
 *
 * The shapes, from the spec:
 *
 *   FreedomWindow { beginsAt endsAt origin requiredDestination participants
 *                   hardConstraints[] confidence }
 *   Commitment    { type startsAt requiredArrivalAt location preparationTime
 *                   latenessTolerance hardConstraints confidence }
 *
 * and the rule it enforces: a conflict is not silently rendered as a normal
 * schedule. Confirmed schedules may contain known conflicts only when
 * explicitly overridden and visibly marked.
 *
 * ── A WINDOW IS A LOWER BOUND ON FREE TIME, OR IT IS NOT A WINDOW ───────────
 * There is no routing provider behind most travel terms this engine is handed,
 * so a travel term can prove that something does NOT fit and can never prove
 * that it does. Every choice below leans the same way: when two readings are
 * possible, the window is the SMALLER one, so that a consumer proposing a plan
 * or filling a gap is never handed time the person does not have.
 *
 *   beginsAt   the person is free to leave the previous commitment: its end
 *              when known, else its start — and never before the LATEST moment
 *              they were allowed to arrive at it (deadline + lateness
 *              tolerance). Leaving before you had to arrive is not a thing.
 *   endsAt     the moment they must LEAVE to make the next commitment:
 *              (requiredArrivalAt ?? startsAt) + latenessTolerance
 *              − travel(origin → destination) − prepDuration.
 *              The travel term is the provider's lower bound at the
 *              feasibility percentile; an unknown travel term is NOT zero —
 *              the window then ends at the deadline itself, is flagged
 *              TRAVEL_UNKNOWN and graded INSUFFICIENT, and is never certified.
 *   conflict   when endsAt ≤ beginsAt there is no window; there is a
 *              TEMPORAL_CONFLICT, with the shortfall in minutes, and it is
 *              returned beside the windows rather than dropped. An adapter may
 *              re-label the reason for its own wire; it may not drop it.
 *
 * `certified` is HIGH confidence and no unknown term. With no routed provider
 * no window is certified; the field exists so a consumer can ask, and so the
 * property "an earlier hard commitment cannot increase the preceding certified
 * free window" has a subject. That property holds for EVERY window this engine
 * emits, certified or not, because a travel lower bound satisfies the triangle
 * inequality and prep is non-negative.
 *
 * The HORIZON is the span the caller asks about (`horizonStart`/`horizonEnd`).
 * With a start, a window is emitted before the first commitment; with an end,
 * one after the last. A caller asking only about the gaps BETWEEN commitments
 * passes neither.
 *
 * NO OVERRIDE PATH EXISTS. `overridden` is always false and the type says so:
 * an override needs a command that records it, and detection and marking are
 * what this module does.
 */
import { worstTravelConfidence, type TravelConfidence } from "../../lib/travelEstimate.js";

const MS_PER_MIN = 60_000;

/** A located point. The engine's own type: it borrows no context's coordinate shape. */
export interface TemporalPoint {
  lat: number;
  lng: number;
}

export interface FreedomPlace {
  placeId: string | null;
  point: TemporalPoint | null;
}

/** FreedomWindow.hardConstraints[] — what bounds this window, by name. */
export const HARD_CONSTRAINT_KINDS = [
  /** The destination commitment is `fixed`: the end cannot be negotiated. */
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

/** FreedomWindow, every field, plus the ids that say what it sits between. */
export interface FreedomWindow {
  id: string;
  position: WindowPosition;
  /** ISO instants. */
  beginsAt: string;
  endsAt: string;
  durationMinutes: number; usableMinutes?: number; softConstraints?: Array<{ key: string; value: string }>; riskBudget?: { maxLatenessMinutes: number; unsafeActionsPermitted: false }; uncertaintyBudget?: { reservedMinutes: number; share: number; basis: "policy_reserve" };
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
  /** The next deadline (with tolerance) falls before the person is free to leave the previous commitment. */
  "OVERLAP",
  /** There is time between them, but not enough for travel + prep. */
  "NO_TIME_TO_TRAVEL",
  /** Two plan items on the same day overlap in time. */
  "PLAN_OVERLAP",
] as const;
export type TemporalConflictKind = (typeof TEMPORAL_CONFLICT_KINDS)[number];

/** The engine's one conflict reason. Context-free; an adapter re-labels it for its own wire. */
export const TEMPORAL_CONFLICT_REASON = "TEMPORAL_CONFLICT" as const;

export interface TemporalConflict {
  reason: typeof TEMPORAL_CONFLICT_REASON;
  kind: TemporalConflictKind;
  commitmentIds: string[];
  planIds: string[];
  /** Minutes short. null when it could not be quantified. */
  shortfallMinutes: number | null;
  /** No override path exists. Always false, and typed so. */
  overridden: false;
  detail: string;
}

// ── Commitment.hardConstraints and Commitment.confidence ───────────────────
//
// The spec names eight members on `Commitment { type, startsAt,
// requiredArrivalAt, location, preparationTime, latenessTolerance,
// hardConstraints, confidence }`, and the engine READS the last two:
//
//   confidence       a commitment's own certainty about its terms (its deadline,
//                    its preparation). It caps every window it bounds: the
//                    window is the WORSE of the hop's confidence and each end's.
//                    `null` means the adapter states none, and a null end
//                    leaves the hop's confidence as it was. No band is invented
//                    for a commitment whose source states none.
//   hardConstraints  what the commitment will not bend on, in the engine's own
//                    generic vocabulary. NO_LATE_ARRIVAL is the one the engine
//                    enforces: a commitment that does not wait never has a
//                    lateness tolerance spent on it, whatever number a caller
//                    put in `latenessToleranceMinutes` — in the window's end, in
//                    the overlap test and in when the person is released.
//
// The vocabulary names no context. Why a given commitment does not wait is the
// adapter's to say, in the `detail` it attaches; the engine reads only `kind`.

/** Commitment.hardConstraints — the generic kinds the engine enforces. */
export const COMMITMENT_HARD_CONSTRAINT_KINDS = [
  /** The commitment does not wait for a late arrival: its lateness tolerance is never spent. */
  "NO_LATE_ARRIVAL",
] as const;
export type CommitmentHardConstraintKind = (typeof COMMITMENT_HARD_CONSTRAINT_KINDS)[number];

export interface CommitmentHardConstraint {
  kind: CommitmentHardConstraintKind;
  /** Why this commitment declares it, in the adapter's own words. */
  detail: string;
}

/** A commitment as the engine reads it — each adapter translates its own records into this. */
export interface EngineCommitment {
  id: string;
  type: string;
  startsAt: Date | null;
  requiredArrivalAt: Date | null;
  /** null: unknown. An adapter whose records carry no end states null, and the window says so. */
  endsAt: Date | null;
  place: FreedomPlace;
  /** fixed | shiftable | flexible. Only `fixed` is read. */
  flexibility: string;
  prepMinutes: number;
  latenessToleranceMinutes: number;
  /** Commitment.hardConstraints. Empty: the commitment declares none. */
  hardConstraints: readonly CommitmentHardConstraint[];
  /** Commitment.confidence. `null`: the adapter states none. */
  confidence: TravelConfidence | null;
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
  /** Where the span being asked about begins. null: no window before the first commitment. */
  horizonStart: Date | null;
  /** Where the span being asked about ends. null: no window after the last commitment. */
  horizonEnd: Date | null;
}

export interface FreedomResult {
  windows: FreedomWindow[];
  conflicts: TemporalConflict[];
  /** Commitments with neither a start nor an arrival time: not on the line, not silently dropped. */
  unplacedCommitmentIds: string[];
}

/** The `detail` of the before-first window's NO_ORIGIN constraint. An adapter may re-word it. */
export const HORIZON_START_NO_ORIGIN_DETAIL = "nothing precedes this window; where the horizon begins is not a located place";
/** The `detail` of the after-last window's NO_DESTINATION constraint. An adapter may re-word it. */
export const HORIZON_END_NO_DESTINATION_DETAIL = "nothing follows this window before the horizon ends";

function deadlineOf(c: EngineCommitment): Date | null {
  return c.requiredArrivalAt ?? c.startsAt;
}
function validDate(d: Date | null): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** The lateness tolerance the engine may actually spend on `c`: none when it declares NO_LATE_ARRIVAL. */
export function spendableToleranceMinutes(c: EngineCommitment): number {
  const strict = (c.hardConstraints ?? []).some((h) => h.kind === "NO_LATE_ARRIVAL");
  return strict ? 0 : c.latenessToleranceMinutes;
}

/** `base` lowered to the worst confidence any bounding commitment states; an unstated one changes nothing. */
export function commitmentBoundConfidence(base: TravelConfidence, ...bounds: readonly EngineCommitment[]): TravelConfidence {
  let out = base;
  for (const c of bounds) if (c.confidence != null) out = worstTravelConfidence(out, c.confidence);
  return out;
}

/**
 * When the person is free to leave `c`: its end when known, else its start,
 * and never before the latest moment they were allowed to arrive. The LATER
 * of the candidates, on purpose — see the header.
 */
export function leaveAt(c: EngineCommitment): Date | null {
  const end = validDate(c.endsAt) ? c.endsAt : (validDate(c.startsAt) ? c.startsAt : null);
  const dl = deadlineOf(c);
  const latestArrival = validDate(dl) ? new Date(dl.getTime() + spendableToleranceMinutes(c) * MS_PER_MIN) : null;
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
  if (ordered.length > 0 && validDate(inputs.horizonStart)) {
    const first = ordered[0]!;
    const deadline = deadlineOf(first)!;
    const endMs = deadline.getTime() + spendableToleranceMinutes(first) * MS_PER_MIN - first.prepMinutes * MS_PER_MIN;
    if (endMs > inputs.horizonStart.getTime()) {
      push({
        position: "before_first",
        beginsAt: inputs.horizonStart.toISOString(), endsAt: new Date(endMs).toISOString(),
        origin: null,
        requiredDestination: { ...first.place, commitmentId: first.id, arriveBy: deadline.toISOString() },
        hardConstraints: [
          { kind: "NO_ORIGIN", commitmentId: null, detail: HORIZON_START_NO_ORIGIN_DETAIL },
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
    const latestArrivalMs = deadline.getTime() + spendableToleranceMinutes(next) * MS_PER_MIN;

    const constraints: HardConstraint[] = [];
    if (!validDate(prev.endsAt)) constraints.push({ kind: "PREVIOUS_END_UNKNOWN", commitmentId: prev.id, detail: `${prev.type} has no end time; the window begins at its start` });
    if (next.requiredArrivalAt === null) constraints.push({ kind: "ARRIVAL_DEADLINE_ASSUMED_FROM_START", commitmentId: next.id, detail: "no requiredArrivalAt; startsAt stood in" });
    if (next.flexibility === "fixed") constraints.push({ kind: "NEXT_IS_FIXED", commitmentId: next.id, detail: `${next.type} is fixed` });
    if (!prev.place.point) constraints.push({ kind: "NO_ORIGIN", commitmentId: prev.id, detail: `${prev.type} has no located place` });

    // The next deadline, with every tolerance, is before the person can
    // leave the previous commitment: an overlap, whatever the travel term.
    if (latestArrivalMs <= begins.getTime()) {
      conflicts.push({
        reason: TEMPORAL_CONFLICT_REASON, kind: "OVERLAP",
        commitmentIds: [prev.id, next.id], planIds: [],
        shortfallMinutes: Math.round((begins.getTime() - latestArrivalMs) / MS_PER_MIN),
        overridden: false,
        detail: `${next.type} must be reached by ${new Date(latestArrivalMs).toISOString()} but ${prev.type} does not release the traveller until ${begins.toISOString()}`,
      });
      continue;
    }

    let confidence: TravelConfidence = commitmentBoundConfidence(hop.confidence, prev, next);
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
        reason: TEMPORAL_CONFLICT_REASON, kind: "NO_TIME_TO_TRAVEL",
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
  if (ordered.length > 0 && validDate(inputs.horizonEnd)) {
    const last = ordered[ordered.length - 1]!;
    const begins = leaveAt(last);
    if (begins && inputs.horizonEnd.getTime() > begins.getTime()) {
      push({
        position: "after_last",
        beginsAt: begins.toISOString(), endsAt: inputs.horizonEnd.toISOString(),
        origin: last.place,
        requiredDestination: null,
        hardConstraints: [
          { kind: "NO_DESTINATION", commitmentId: null, detail: HORIZON_END_NO_DESTINATION_DETAIL },
          ...(!validDate(last.endsAt) ? [{ kind: "PREVIOUS_END_UNKNOWN" as const, commitmentId: last.id, detail: `${last.type} has no end time; the window begins at its start` }] : []),
        ],
        confidence: commitmentBoundConfidence("LOW", last),
        reservedMinutes: 0,
        afterCommitmentId: last.id, beforeCommitmentId: null,
      });
    }
  }

  windows.sort((a, b) => Date.parse(a.beginsAt) - Date.parse(b.beginsAt));
  return { windows, conflicts, unplacedCommitmentIds: unplaced };
}

// ── The free gap before the next item of a day's plan ────────────────────────

export interface PlanForGap {
  id: string;
  startsAt: string | null;
}

export interface PlanFreeGap {
  /** Minutes until the next timed item, or null when nothing timed is ahead ("the rest of the day"). */
  gapMinutes: number | null;
  /** The next timed item, or null. */
  nextPlanId: string | null;
  nextStartsAt: string | null;
  /** How many items carried a start time; 0 means the day has no timed plan and no gap is claimed. */
  timedCount: number;
}

/**
 * The free gap between `nowMs` and the next timed plan item — the "gap between
 * commitments" question asked of a DAY'S PLAN rather than of the commitment
 * set. Owned here so no consumer derives free time on its own. A day with no
 * timed item claims no gap: an entirely unplanned day is normal, not a signal,
 * and the caller decides what to do with `timedCount === 0`.
 */
export function freeGapFromPlan(items: readonly PlanForGap[], nowMs: number): PlanFreeGap {
  const timed = items
    .map((i) => ({ id: i.id, at: i.startsAt ? Date.parse(i.startsAt) : NaN, iso: i.startsAt }))
    .filter((i) => Number.isFinite(i.at));
  if (timed.length === 0) return { gapMinutes: null, nextPlanId: null, nextStartsAt: null, timedCount: 0 };
  const upcoming = timed.filter((i) => i.at > nowMs).sort((a, b) => a.at - b.at);
  const next = upcoming[0] ?? null;
  return {
    gapMinutes: next ? Math.floor((next.at - nowMs) / MS_PER_MIN) : null,
    nextPlanId: next?.id ?? null,
    nextStartsAt: next?.iso ?? null,
    timedCount: timed.length,
  };
}

// ── The conflict rule on a day's plan ─────────────────────────────────────────

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
          reason: TEMPORAL_CONFLICT_REASON, kind: "PLAN_OVERLAP",
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
