/**
 * Telegraph §9 — what each coordination STATE puts in front of people.
 *
 * §9's table, verbatim:
 *
 *   Preparing   Plan card, attendance, leave-by, route, availability conflicts.
 *   Assembling  On my way, running late, meet here, ETA, pickup, arrival counts.
 *   Active      Minimal conversation, NEXT STEP, crew state, optional location scope.
 *   Returning   Heading back, Safe Return, SHARED TRANSPORT, return checkpoint.
 *   Complete    CLOSEOUT, media grouping, explicit Memory/recap options.
 *
 * `coordination.ts` derives the state and projects the objects the states are
 * made of (decisions, commitments, rendezvous, quick states). Three of the
 * table's cells were still nobody's job, and census-telegraph says so in three
 * rows:
 *
 *   T106  "There is no next-step surface."
 *   T107  "shared transport does not exist."
 *   T108  "There is still no closeout surface: at COMPLETE the coordination
 *          panel simply disappears rather than becoming one."
 *
 * This module answers each with a projection over facts the thread already
 * holds. It is PURE — no client, no clock, no logger — so the one answer both
 * clients get is computed here and nowhere else (§30A.2's "clients must not
 * recompute this from raw tables" applies to a next step as much as to a
 * person's reachability).
 *
 * ── NOTHING HERE IS A NEW WRITER ────────────────────────────────────────────
 * A next step is DERIVED from decisions, commitments, a rendezvous and the
 * plan's own timeline; a shared ride is an existing §8.1 `SPLIT_RIDE` action
 * proposal plus the existing `ACTION_RESPONSE`s to it; a closeout is the plan's
 * own end. No table, no column, no new message kind — Appendix A's rule against
 * a second store for an existing fact holds here as it does in `coordination.ts`.
 */
import type { CoordinationState } from "./vocabulary.js";
import { RETURN_WINDOW_MINUTES, type CoordinatedPlan } from "./coordination.js";

// ── shared input shapes (the projected objects `coordination.ts` produces) ──

export interface StageDecision {
  decisionId: string;
  question: string;
  deadlineAt: string | null;
  resolved: boolean;
}

export interface StageCommitment {
  commitmentId: string;
  what: string;
  byWhen: string | null;
  completedBy: string | null;
  overdue: boolean;
}

export interface StageRendezvous {
  messageId: string;
  at: string;
  payload: { checkpoint?: unknown; landmark?: unknown; windowStartsAt?: unknown; windowEndsAt?: unknown } | null;
}

function msOf(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// ── §9 Active: NEXT STEP (T106) ─────────────────────────────────────────────

/**
 * Why this is the next step. One value per source, so a reader can tell a step
 * a person agreed to from one the plan's clock implies.
 */
export const NEXT_STEP_KINDS = [
  /** A commitment somebody agreed to, past its deadline and not done. */
  "OVERDUE_COMMITMENT",
  /** A decision that still has no result — the earliest deadline first. */
  "OPEN_DECISION",
  /** The meeting point whose window has not closed. */
  "MEET_AT",
  /** A commitment not yet due. */
  "COMMITMENT_DUE",
  /** §9 Assembling: leave by the plan's leave-by. */
  "LEAVE_BY",
  /** §9 Active: the plan is under way and ends at its end. */
  "PLAN_ENDS",
  /** §9 Returning: heading back — the step is getting home and saying so. */
  "HEAD_BACK",
] as const;
export type NextStepKind = (typeof NEXT_STEP_KINDS)[number];

export interface NextStep {
  kind: NextStepKind;
  /** Human words. Never empty. */
  label: string;
  /** The instant the step is about, when it has one. */
  at: string | null;
  /** The message the step came from (a decision, commitment or rendezvous), or null for a plan-timeline step. */
  sourceMessageId: string | null;
  /**
   * DERIVED, always — a next step is the system's reading of the thread, not
   * something a person declared. §9.1's rule that a derived estimate stay
   * distinguishable from a declared status is carried in the value.
   */
  provenance: "DERIVED_FROM_THREAD";
}

/** The states in which a thread is coordinating and so has a next step. */
const NEXT_STEP_STATES: readonly CoordinationState[] = ["ASSEMBLING", "ACTIVE", "RETURNING", "DISRUPTED"];

export interface NextStepInput {
  state: CoordinationState | null;
  plan: (CoordinatedPlan & { leaveByAt: string | null }) | null;
  decisions: readonly StageDecision[];
  commitments: readonly StageCommitment[];
  rendezvous: readonly StageRendezvous[];
  nowMs: number;
}

/**
 * The ONE next step for a coordinating thread, or null.
 *
 * Order, and why:
 *   1. an overdue commitment — something a person said they would do and has
 *      not, which is the step most likely to be blocking everyone else;
 *   2. an open decision, earliest deadline first (no deadline sorts last) —
 *      the group cannot act on a question it has not answered;
 *   3. the newest meeting point whose window has not closed;
 *   4. the earliest commitment not yet due;
 *   5. the plan's own timeline: leave-by while ASSEMBLING, the end while
 *      ACTIVE, heading back while RETURNING.
 *
 * A thread that is not coordinating has no next step: PREPARING is three days
 * out and COMPLETE is over, and inventing a step for either would be the panel
 * nagging about a plan that is not happening now.
 */
export function projectNextStep(input: NextStepInput): NextStep | null {
  if (!input.state || !NEXT_STEP_STATES.includes(input.state)) return null;
  const base = { provenance: "DERIVED_FROM_THREAD" as const };

  const overdue = input.commitments
    .filter((c) => !c.completedBy && c.overdue)
    .sort((a, b) => (msOf(a.byWhen) ?? Infinity) - (msOf(b.byWhen) ?? Infinity))[0];
  if (overdue) {
    return { ...base, kind: "OVERDUE_COMMITMENT", label: `Overdue: ${overdue.what}`, at: overdue.byWhen, sourceMessageId: overdue.commitmentId };
  }

  const openDecision = input.decisions
    .filter((d) => !d.resolved)
    .sort((a, b) => (msOf(a.deadlineAt) ?? Infinity) - (msOf(b.deadlineAt) ?? Infinity))[0];
  if (openDecision) {
    return { ...base, kind: "OPEN_DECISION", label: `Decide: ${openDecision.question}`, at: openDecision.deadlineAt, sourceMessageId: openDecision.decisionId };
  }

  const meet = [...input.rendezvous]
    .sort((a, b) => (msOf(b.at) ?? 0) - (msOf(a.at) ?? 0))
    .find((r) => {
      const ends = msOf(r.payload?.windowEndsAt);
      return text(r.payload?.checkpoint) !== null && (ends === null || ends > input.nowMs);
    });
  if (meet) {
    const checkpoint = text(meet.payload?.checkpoint)!;
    const startsAt = text(meet.payload?.windowStartsAt);
    return { ...base, kind: "MEET_AT", label: `Meet at ${checkpoint}`, at: startsAt, sourceMessageId: meet.messageId };
  }

  const due = input.commitments
    .filter((c) => !c.completedBy && !c.overdue)
    .sort((a, b) => (msOf(a.byWhen) ?? Infinity) - (msOf(b.byWhen) ?? Infinity))[0];
  if (due) {
    return { ...base, kind: "COMMITMENT_DUE", label: due.what, at: due.byWhen, sourceMessageId: due.commitmentId };
  }

  const plan = input.plan;
  if (input.state === "ASSEMBLING" && plan?.leaveByAt) {
    return { ...base, kind: "LEAVE_BY", label: `Leave for ${plan.title}`, at: plan.leaveByAt, sourceMessageId: null };
  }
  if (input.state === "ACTIVE" && plan) {
    return { ...base, kind: "PLAN_ENDS", label: `${plan.title} is under way`, at: plan.endsAt, sourceMessageId: null };
  }
  if (input.state === "RETURNING") {
    return { ...base, kind: "HEAD_BACK", label: "Head back and let people know you're home", at: null, sourceMessageId: null };
  }
  return null;
}

// ── §9 Returning: SHARED TRANSPORT (T107) ───────────────────────────────────

/** The §8.1 action a shared ride is made of. */
export const SHARED_RIDE_ACTION = "SPLIT_RIDE" as const;

export interface RideProposalRow {
  id: string;
  sender_id: string;
  created_at: string;
  payload: { action?: unknown; title?: unknown; detail?: unknown } | null;
}

export interface RideResponseRow {
  id: string;
  sender_id: string;
  created_at: string;
  payload: { actionMessageId?: unknown; response?: unknown } | null;
}

export interface SharedRide {
  proposalId: string;
  proposedBy: string;
  proposedAt: string;
  title: string;
  detail: string | null;
  /** The proposer and everyone whose LATEST answer is CONFIRMED. */
  riders: string[];
  /** Everyone whose latest answer is DECLINED. */
  declined: string[];
  /**
   * False when the roster could not be read: the rider list was NOT checked
   * against current membership and must not be presented as verified.
   */
  rosterChecked: boolean;
}

/**
 * Shared rides, from `SPLIT_RIDE` proposals and the answers to them.
 *
 * A person's LATEST answer counts (they may join, then drop out). A member who
 * has left the conversation is not riding with anyone — §14.2 re-checks on the
 * READ — so riders and decliners are filtered by the active roster. When the
 * roster is unknown (`null`) nobody is dropped and `rosterChecked` says so,
 * because an unreadable roster must become neither "everybody is still here"
 * presented as fact nor "nobody is".
 */
export function projectSharedRides(
  proposals: readonly RideProposalRow[],
  responses: readonly RideResponseRow[],
  activeMemberIds: ReadonlySet<string> | null,
): SharedRide[] {
  const inRoster = (id: string) => activeMemberIds === null || activeMemberIds.has(id);
  const rides: SharedRide[] = [];
  for (const p of proposals) {
    if (p.payload?.action !== SHARED_RIDE_ACTION) continue;
    if (!inRoster(p.sender_id)) continue;
    const latest = new Map<string, { at: number; response: string }>();
    for (const r of responses) {
      if (r.payload?.actionMessageId !== p.id) continue;
      const response = r.payload?.response;
      if (response !== "CONFIRMED" && response !== "DECLINED") continue;
      const at = msOf(r.created_at) ?? 0;
      const prev = latest.get(r.sender_id);
      if (!prev || at >= prev.at) latest.set(r.sender_id, { at, response });
    }
    const riders = [p.sender_id];
    const declined: string[] = [];
    for (const [userId, v] of latest) {
      if (userId === p.sender_id || !inRoster(userId)) continue;
      if (v.response === "CONFIRMED") riders.push(userId);
      else declined.push(userId);
    }
    rides.push({
      proposalId: p.id,
      proposedBy: p.sender_id,
      proposedAt: p.created_at,
      title: text(p.payload?.title) ?? "Shared ride",
      detail: text(p.payload?.detail),
      riders,
      declined,
      rosterChecked: activeMemberIds !== null,
    });
  }
  return rides.sort((a, b) => (msOf(b.proposedAt) ?? 0) - (msOf(a.proposedAt) ?? 0));
}

// ── §9 Complete: CLOSEOUT (T108) ────────────────────────────────────────────

/**
 * How long after a plan becomes COMPLETE its closeout is offered. Long enough
 * to cover "the next morning", short enough that a thread does not carry last
 * month's dinner at its top forever. A closeout that never went away would be
 * a banner, and people learn to stop reading banners.
 */
export const CLOSEOUT_WINDOW_HOURS = 18;

export interface Closeout {
  planObjectId: string;
  title: string;
  /** The plan's end, as the plan states it. */
  endedAt: string;
  /** Until when this closeout is offered. */
  offeredUntil: string;
  /** Declared arrivals, from §9.1 quick states — what people SAID, not a measurement. */
  arrivedCount: number;
  /**
   * §10.2 / §10.3: the options are explicit and NOTHING is created by showing
   * them. A recap is an invitation to curate (`GET /threads/:id/recap` writes
   * nothing); saving to Memory is a per-item act.
   */
  options: readonly ("CREATE_RECAP" | "SAVE_TO_MEMORY" | "DONE")[];
}

/**
 * The closeout for a thread whose plan has just completed, or null.
 *
 * COMPLETE begins `RETURN_WINDOW_MINUTES` after the plan's end (see
 * `derivedCoordinationState`), so the offer runs from then for
 * `CLOSEOUT_WINDOW_HOURS`. A cancelled plan gets no closeout — there is
 * nothing to close out, and a recap of a night that did not happen is the
 * "automatic historical truth" §10.3 refuses.
 */
export function projectCloseout(input: {
  state: CoordinationState | null;
  plan: CoordinatedPlan | null;
  arrivedCount: number;
  nowMs: number;
}): Closeout | null {
  if (input.state !== "COMPLETE" || !input.plan) return null;
  const start = msOf(input.plan.startsAt);
  const end = msOf(input.plan.endsAt) ?? (start !== null ? start + 2 * 3600_000 : null);
  if (end === null) return null;
  const completeFrom = end + RETURN_WINDOW_MINUTES * 60_000;
  const until = completeFrom + CLOSEOUT_WINDOW_HOURS * 3600_000;
  if (input.nowMs < completeFrom || input.nowMs >= until) return null;
  return {
    planObjectId: input.plan.objectId,
    title: input.plan.title,
    endedAt: new Date(end).toISOString(),
    offeredUntil: new Date(until).toISOString(),
    arrivedCount: Math.max(0, Math.trunc(input.arrivedCount)),
    options: ["CREATE_RECAP", "SAVE_TO_MEMORY", "DONE"],
  };
}
