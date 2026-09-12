/**
 * Trips spec §9.4 impact preview and §15.3 invalidation semantics, PURE
 * (census-trips TR156, TR291–TR295).
 *
 * §9.4: "Before a proposal that changes a confirmed plan is accepted,
 *        compute downstream impact: affected reservations, transport,
 *        participants, commitment conflicts, cancellation costs, and
 *        safety/return implications."
 * §15.3: "When replanning invalidates a booked activity, the planner must
 *        return explicit side effects: booking at risk, cancellation
 *        deadline, potential cost, affected participants, and required user
 *        confirmation. Automatic replanning may not silently cancel purchases."
 *
 * One function, `previewImpact(change, state, now)`, over a typed change
 * (move / cancel / add / remove a plan; move a commitment) and the trip's
 * state. It computes nothing it cannot see: a reservation's cost is
 * whatever the reservation carries, and "unknown" is returned as null with
 * the reason, never as zero.
 */
import { detectPlanOverlaps, type TemporalConflict } from "./TripFreedomEngine.js";

export const CHANGE_KINDS = ["move_plan", "cancel_plan", "remove_plan", "add_plan", "move_commitment"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ProposedChange {
  kind: ChangeKind;
  /** The plan or commitment the change is about; null for add_plan. */
  targetId: string | null;
  /** The new slot for move_* and add_plan. */
  startsAt?: string | null;
  endsAt?: string | null;
  title?: string | null;
  proposedBy?: string | null;
}

export interface StatePlan {
  id: string; title: string | null; status: string | null; startsAt: string | null; endsAt: string | null; dayDate: string | null;
  /** 2771 attendance, else the crew. */
  participantIds: string[];
  /** ALL_CREW | OPTIONAL | SUBGROUP | SOLO (2770 plan_scope). */
  planScope: string | null;
  /** True when the plan is confirmed (§9.4 "changes a confirmed plan"). */
  confirmed: boolean;
}
export interface StateReservation {
  id: string; title: string | null; type: string | null; status: string | null; startsAt: string | null; endsAt: string | null;
  cancellationDeadlineAt: string | null;
  /** Minor units, when the reservation carries a price; null when it does not. */
  costMinor: number | null; currency: string | null;
  /** The plan it is attached to, when known (title or time overlap otherwise). */
  planId: string | null;
  participantIds: string[];
}
export interface StateTransport {
  id: string; mode: string; state: string; plannedDepartureAt: string | null; plannedArrivalAt: string | null; servesId: string | null; partySize: number | null; costMinor: number | null; currency: string | null;
}
export interface StateCommitment {
  id: string; type: string; startsAt: string | null; requiredArrivalAt: string | null; flexibility: string | null; participantIds: string[];
}
export interface ImpactState {
  plans: StatePlan[];
  reservations: StateReservation[];
  transport: StateTransport[];
  commitments: StateCommitment[];
  /** Safe Return sessions active for participants, if any. */
  safeReturnActiveFor: string[];
  crewIds: string[];
}

export interface BookingAtRisk {
  reservationId: string;
  title: string | null;
  /** ISO or null. */
  cancellationDeadlineAt: string | null;
  deadlinePassed: boolean | null;
  /** Minor units or null when the reservation carries no price. */
  potentialCostMinor: number | null;
  currency: string | null;
  why: string;
}

export interface BookingSideEffects {
  bookingsAtRisk: BookingAtRisk[];
  /** The soonest deadline among the bookings at risk. */
  cancellationDeadline: string | null;
  /** Sum of known costs; null when any at-risk booking's cost is unknown. */
  potentialCostMinor: number | null;
  currency: string | null;
  affectedParticipants: string[];
  /** §15.3: a purchase may not be cancelled silently — true whenever a booking is at risk. */
  requiresUserConfirmation: boolean;
  explanation: string[];
}

export interface ImpactPreview {
  change: ProposedChange;
  /** §9.4 "changes a confirmed plan" — the preview is required before acceptance. */
  changesConfirmedPlan: boolean;
  affectedReservations: StateReservation[];
  affectedTransport: StateTransport[];
  affectedParticipants: string[];
  commitmentConflicts: TemporalConflict[];
  cancellationCosts: { knownMinor: number; unknownCount: number; currency: string | null };
  safetyImplications: string[];
  /** §15.3, always present; empty when no booking is at risk. */
  bookingSideEffects: BookingSideEffects;
  /** §9.3: shared mutations need governance. */
  governance: { sharedMutation: boolean; affectsOthers: boolean; suggestedDecisionRule: "anyone" | "host" | "majority" | "unanimous" };
  summary: string;
}

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
function overlaps(aS: number | null, aE: number | null, bS: number | null, bE: number | null): boolean {
  if (aS === null || bS === null) return false;
  const ae = aE ?? aS + 60 * 60_000; const be = bE ?? bS + 60 * 60_000;
  return aS < be && bS < ae;
}

export function previewImpact(change: ProposedChange, state: ImpactState, now: number): ImpactPreview {
  const target = change.kind === "move_commitment"
    ? null
    : state.plans.find((p) => p.id === change.targetId) ?? null;
  const commitment = change.kind === "move_commitment" ? state.commitments.find((c) => c.id === change.targetId) ?? null : null;
  const changesConfirmedPlan = !!target?.confirmed;
  const tS = ms(target?.startsAt); const tE = ms(target?.endsAt);

  // reservations: attached to the plan, or overlapping it in time with the same title
  const affectedReservations = target ? state.reservations.filter((r) => r.planId === target.id
    || (r.title && target.title && r.title.trim().toLowerCase() === target.title.trim().toLowerCase())
    || overlaps(ms(r.startsAt), ms(r.endsAt), tS, tE)) : [];
  const affectedTransport = target ? state.transport.filter((t) => t.servesId === target.id || overlaps(ms(t.plannedDepartureAt), ms(t.plannedArrivalAt), tS === null ? null : tS - 3 * 3_600_000, tE ?? tS)) : commitment ? state.transport.filter((t) => t.servesId === commitment.id) : [];
  const affectedParticipants = [...new Set([...(target?.participantIds ?? commitment?.participantIds ?? []), ...affectedReservations.flatMap((r) => r.participantIds)])];

  // commitment conflicts: the new slot against the other plans that day and the commitments' approach windows
  const conflicts: TemporalConflict[] = [];
  if ((change.kind === "move_plan" || change.kind === "add_plan") && change.startsAt) {
    const nS = ms(change.startsAt); const nE = ms(change.endsAt) ?? (nS !== null ? nS + ((tE ?? tS ?? 0) - (tS ?? 0) || 60 * 60_000) : null);
    const day = change.startsAt.slice(0, 10);
    const others = state.plans.filter((p) => p.id !== change.targetId && p.dayDate === day && p.status !== "cancelled").map((p) => ({ id: p.id, dayDate: p.dayDate, startsAt: p.startsAt, endsAt: p.endsAt }));
    conflicts.push(...detectPlanOverlaps([...others, { id: change.targetId ?? "proposed", dayDate: day, startsAt: change.startsAt, endsAt: nE !== null ? new Date(nE).toISOString() : null }] as any));
    for (const c of state.commitments) {
      const need = ms(c.requiredArrivalAt) ?? ms(c.startsAt);
      if (need !== null && nS !== null && nE !== null && nS < need && nE > need - 30 * 60_000) {
        conflicts.push({ reason: "TRIP_TEMPORAL_CONFLICT", kind: "OVERLAP", commitmentIds: [c.id], planIds: [change.targetId ?? "proposed"], shortfallMinutes: Math.round((nE - (need - 30 * 60_000)) / 60_000), overridden: false, detail: `the new slot runs into commitment ${c.id}'s approach window` });
      }
    }
  }

  // §15.3 booking side effects
  const invalidating = change.kind === "cancel_plan" || change.kind === "remove_plan" || (change.kind === "move_plan" && !!change.startsAt);
  const bookingsAtRisk: BookingAtRisk[] = invalidating ? affectedReservations.filter((r) => r.status !== "cancelled" && r.status !== "dismissed").map((r) => {
    const dl = ms(r.cancellationDeadlineAt);
    return {
      reservationId: r.id, title: r.title, cancellationDeadlineAt: r.cancellationDeadlineAt, deadlinePassed: dl === null ? null : dl <= now,
      potentialCostMinor: r.costMinor, currency: r.currency,
      why: change.kind === "move_plan" ? "the plan it is booked for would move" : "the plan it is booked for would be cancelled",
    };
  }) : [];
  const unknownCost = bookingsAtRisk.filter((b) => b.potentialCostMinor === null).length;
  // §15.3's potential cost is the BOOKINGS at risk; §9.4's cancellation cost adds the transport that served the plan.
  const bookingsMinor = bookingsAtRisk.reduce((acc, b) => acc + (b.potentialCostMinor ?? 0), 0);
  const knownMinor = bookingsMinor + affectedTransport.filter(() => invalidating).reduce((acc, t) => acc + (t.costMinor ?? 0), 0);
  const currency = bookingsAtRisk.find((b) => b.currency)?.currency ?? affectedTransport.find((t) => t.currency)?.currency ?? null;
  const deadlines = bookingsAtRisk.map((b) => b.cancellationDeadlineAt).filter((d): d is string => !!d).sort();
  const sideEffects: BookingSideEffects = {
    bookingsAtRisk,
    cancellationDeadline: deadlines[0] ?? null,
    potentialCostMinor: bookingsAtRisk.length === 0 ? 0 : unknownCost > 0 ? null : bookingsMinor,
    currency,
    affectedParticipants,
    requiresUserConfirmation: bookingsAtRisk.length > 0,
    explanation: bookingsAtRisk.length === 0 ? ["no booking is at risk"] : [
      `${bookingsAtRisk.length} booking(s) at risk`,
      deadlines[0] ? `soonest cancellation deadline ${deadlines[0]}${ms(deadlines[0])! <= now ? " (passed)" : ""}` : "no cancellation deadline is recorded",
      unknownCost > 0 ? `${unknownCost} booking(s) carry no price; the potential cost is unknown, not zero` : `potential cost ${bookingsMinor} ${currency ?? ""}`.trim(),
      "a purchase is not cancelled without the user's confirmation (§15.3)",
    ],
  };

  const safety: string[] = [];
  for (const id of affectedParticipants) if (state.safeReturnActiveFor.includes(id)) safety.push(`${id} has an active Safe Return session; a changed return time must reach it`);
  if (change.kind === "move_plan" && change.startsAt && /T(2[2-3]|0[0-4]):/.test(change.startsAt)) safety.push("the new slot is late at night; return logistics change");

  const affectsOthers = affectedParticipants.some((id) => id !== change.proposedBy);
  const sharedMutation = (target?.planScope ?? "ALL_CREW").toUpperCase() !== "SOLO" && affectsOthers;
  const governance = {
    sharedMutation, affectsOthers,
    suggestedDecisionRule: (!sharedMutation ? "anyone" : bookingsAtRisk.length > 0 ? "unanimous" : changesConfirmedPlan ? "majority" : "host") as ImpactPreview["governance"]["suggestedDecisionRule"],
  };
  const summary = [
    `${change.kind.replace("_", " ")}${target ? ` "${target.title ?? target.id}"` : commitment ? ` ${commitment.type} ${commitment.id}` : ""}`,
    changesConfirmedPlan ? "changes a confirmed plan" : null,
    `${affectedReservations.length} reservation(s), ${affectedTransport.length} transport segment(s), ${affectedParticipants.length} participant(s)`,
    conflicts.length > 0 ? `${conflicts.length} commitment conflict(s)` : "no commitment conflict",
    bookingsAtRisk.length > 0 ? `${bookingsAtRisk.length} booking(s) at risk — confirmation required` : null,
    safety.length > 0 ? `${safety.length} safety implication(s)` : null,
  ].filter(Boolean).join("; ");

  return {
    change, changesConfirmedPlan, affectedReservations, affectedTransport, affectedParticipants, commitmentConflicts: conflicts,
    cancellationCosts: { knownMinor, unknownCount: unknownCost, currency }, safetyImplications: safety, bookingSideEffects: sideEffects, governance, summary,
  };
}
