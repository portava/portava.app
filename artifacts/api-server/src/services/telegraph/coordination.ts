/**
 * Telegraph §8 Plans, Decisions & Action Objects + §9 Coordination Mode.
 *
 * Spec:
 *   §8    ConversationDecision (question, options, voters, resolution rule,
 *          deadline, final result), ConversationCommitment (who agreed to do
 *          what, by when, whether it was completed), CoordinationSession,
 *          Rendezvous (checkpoint, landmark, time window, fallback point,
 *          proximity state)
 *   §8.1  the fourteen native actions
 *   §8.2  "AI/entity extraction may suggest … canonical creation requires user
 *          confirmation unless a pre-authorized deterministic shortcut exists"
 *   §9    PREPARING -> ASSEMBLING -> ACTIVE -> RETURNING -> COMPLETE, with
 *          DISRUPTED / CANCELLED as exits
 *   §9.1  the seven quick states; "User-declared status must remain
 *          distinguishable from system-derived ETA or location-derived
 *          estimates."
 *
 * ── WHY THESE ARE PROJECTIONS, NOT TABLES ───────────────────────────────────
 * Appendix A: the spec's schema names are "architectural names, not permission
 * to create duplicate tables if equivalent canonical structures already
 * exist." A decision IS a question one person asked and answers other people
 * gave — which is a message and some messages. Storing it a second time in a
 * `conversation_decisions` table would create two sources of truth for the
 * same conversation, and would need a migration no database has.
 *
 * So each §8 object is carried as a typed message and READ as a projection
 * over the thread. The projections are pure functions of rows, which is what
 * makes their rules — a late vote, a changed vote, an unresolved tie —
 * testable without a database.
 *
 * ── WHAT THIS IS HONEST ABOUT ───────────────────────────────────────────────
 * A projection over messages is not a queryable store: a commitment cannot be
 * listed across threads, and a decision cannot be indexed. Where that matters
 * the census row says so rather than this module pretending otherwise.
 */
import { z } from "zod";
import {
  COORDINATION_QUICK_STATES,
  QUICK_STATE_PROVENANCE,
  isCoordinationQuickState,
  isTelegraphAction,
  type CoordinationQuickState,
  type CoordinationState,
  type TelegraphAction,
} from "./vocabulary.js";

// ── §9's state machine ───────────────────────────────────────────────────────

/**
 * §9's arrows, and only §9's arrows.
 *
 * DISRUPTED is recoverable — a plan that hit traffic can resume assembling —
 * which is why it has outbound edges. CANCELLED and COMPLETE are terminal:
 * §9's diagram has no arrow leaving either, and inventing one here would be
 * this module deciding something the spec did not.
 */
const TRANSITIONS: Readonly<Record<CoordinationState, readonly CoordinationState[]>> = {
  PREPARING: ["ASSEMBLING", "DISRUPTED", "CANCELLED"],
  ASSEMBLING: ["ACTIVE", "DISRUPTED", "CANCELLED"],
  ACTIVE: ["RETURNING", "DISRUPTED", "COMPLETE"],
  RETURNING: ["COMPLETE", "DISRUPTED"],
  COMPLETE: [],
  DISRUPTED: ["ASSEMBLING", "ACTIVE", "RETURNING", "COMPLETE", "CANCELLED"],
  CANCELLED: [],
};

export function legalNextStates(from: CoordinationState): readonly CoordinationState[] {
  return TRANSITIONS[from] ?? [];
}

export function isLegalTransition(from: CoordinationState, to: CoordinationState): boolean {
  return legalNextStates(from).includes(to);
}

export function isTerminalCoordinationState(s: CoordinationState): boolean {
  return legalNextStates(s).length === 0;
}

/** §9: "when a shared plan approaches its leave-by/start window". */
export const LEAVE_BY_LEAD_MINUTES = 45;
/** How long after the end a plan is still RETURNING rather than COMPLETE. */
export const RETURN_WINDOW_MINUTES = 120;

export interface CoordinatedPlan {
  objectId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  /** Explicit leave-by, when the plan has one; else derived from startsAt. */
  leaveByAt?: string | null;
  status?: string | null;
}

function ms(v: string | null | undefined): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * §9's state for a plan, DERIVED from its own timeline.
 *
 * Derived rather than stored, deliberately: a stored state drifts the moment
 * an app is offline through a transition, and the recovery would be a
 * background job nothing in this tree runs. `null` means the plan carries no
 * timeline at all, in which case it has no coordination state — not PREPARING,
 * which would put every undated wish into a coordination surface.
 */
export function derivedCoordinationState(plan: CoordinatedPlan, nowMs: number): CoordinationState | null {
  const status = (plan.status ?? "").toLowerCase();
  if (status === "cancelled" || status === "declined") return "CANCELLED";
  if (status === "disrupted") return "DISRUPTED";

  const start = ms(plan.startsAt);
  const end = ms(plan.endsAt) ?? (start !== null ? start + 2 * 3600_000 : null);
  if (start === null) return null;

  const leaveBy = ms(plan.leaveByAt) ?? start - LEAVE_BY_LEAD_MINUTES * 60_000;

  if (nowMs < leaveBy) return "PREPARING";
  if (nowMs < start) return "ASSEMBLING";
  if (end !== null && nowMs < end) return "ACTIVE";
  if (end !== null && nowMs < end + RETURN_WINDOW_MINUTES * 60_000) return "RETURNING";
  return "COMPLETE";
}

/** The leave-by instant §9 and §9's Preparing row both refer to. */
export function leaveByFor(plan: CoordinatedPlan): string | null {
  if (plan.leaveByAt) return plan.leaveByAt;
  const start = ms(plan.startsAt);
  if (start === null) return null;
  return new Date(start - LEAVE_BY_LEAD_MINUTES * 60_000).toISOString();
}

/**
 * §9: "the thread can TEMPORARILY transform from normal conversation into a
 * coordination surface". Temporarily is the operative word — PREPARING is not
 * it. A plan three days out must not put the conversation into a coordination
 * mode for three days.
 */
export function threadIsCoordinating(state: CoordinationState | null): boolean {
  return state === "ASSEMBLING" || state === "ACTIVE" || state === "RETURNING" || state === "DISRUPTED";
}

// ── §9.1 quick states ────────────────────────────────────────────────────────

export const QuickStatePayload = z.object({
  state: z.enum(COORDINATION_QUICK_STATES),
  /** The plan this status is about, when it is about one. */
  objectId: z.string().max(200).nullish(),
  /** Coarse only — a quick state must never require exact coordinates. */
  approximateLabel: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
  /**
   * §9.1's closing rule, carried in the row: this is what the USER SAID. A
   * system-derived estimate would carry a different provenance and is not
   * representable through this payload.
   */
  provenance: z.literal(QUICK_STATE_PROVENANCE).default(QUICK_STATE_PROVENANCE),
});

// ── §8 Rendezvous ────────────────────────────────────────────────────────────

/** §8's five properties, all of them. */
export const RendezvousPayload = z.object({
  checkpoint: z.string().min(1).max(200),
  landmark: z.string().max(200).nullish(),
  windowStartsAt: z.string().max(64).nullish(),
  windowEndsAt: z.string().max(64).nullish(),
  fallbackPoint: z.string().max(200).nullish(),
  /** Coarse proximity state, never coordinates. */
  proximityState: z.enum(["UNKNOWN", "FAR", "NEARBY", "ARRIVED"]).default("UNKNOWN"),
});

// ── §8 ConversationDecision ──────────────────────────────────────────────────

export const RESOLUTION_RULES = ["PLURALITY", "MAJORITY", "UNANIMOUS", "ASKER_DECIDES"] as const;
export type ResolutionRule = (typeof RESOLUTION_RULES)[number];

export const DecisionPayload = z.object({
  question: z.string().min(1).max(300),
  options: z
    .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200) }))
    .min(2)
    .max(10),
  resolutionRule: z.enum(RESOLUTION_RULES).default("PLURALITY"),
  deadlineAt: z.string().max(64).nullish(),
});

export const VotePayload = z.object({
  decisionId: z.string().min(1).max(64),
  optionId: z.string().min(1).max(40),
});

export interface DecisionVote {
  userId: string;
  optionId: string;
  at: string;
  /** A vote cast after the deadline is RECORDED and NOT COUNTED. */
  late: boolean;
}

export interface ConversationDecision {
  decisionId: string;
  askedBy: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  resolutionRule: ResolutionRule;
  deadlineAt: string | null;
  votes: DecisionVote[];
  tally: Record<string, number>;
  resolved: boolean;
  result: string | null;
  /** Why it resolved, or why it has not. Never silent. */
  reason:
    | "rule_satisfied"
    | "deadline_passed"
    | "awaiting_votes"
    | "tied"
    | "no_votes"
    | "asker_has_not_decided";
}

export interface DecisionInputMessage {
  id: string;
  sender_id: string;
  created_at: string;
  payload: unknown;
}

/**
 * §8's ConversationDecision, projected from the question and the answers.
 *
 * Three rules that a naive tally gets wrong, and each is asserted in the test:
 *   - A voter may change their mind: the LATEST vote by a user counts, the
 *     earlier one does not.
 *   - A vote after the deadline is recorded (so the thread shows it happened)
 *     and is not counted (so the deadline means something).
 *   - A tie under PLURALITY is UNRESOLVED, not a coin toss. The spec asks for
 *     a "final result"; a tie does not have one.
 */
export function projectDecision(
  decision: DecisionInputMessage,
  voteMessages: DecisionInputMessage[],
  nowMs: number,
): ConversationDecision | null {
  const parsed = DecisionPayload.safeParse(decision.payload);
  if (!parsed.success) return null;
  const { question, options, resolutionRule, deadlineAt } = parsed.data;
  const deadline = ms(deadlineAt ?? null);
  const optionIds = new Set(options.map((o) => o.id));

  const latestByUser = new Map<string, DecisionVote>();
  for (const m of [...voteMessages].sort(
    (a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0),
  )) {
    const v = VotePayload.safeParse(m.payload);
    if (!v.success) continue;
    if (v.data.decisionId !== decision.id) continue;
    if (!optionIds.has(v.data.optionId)) continue;
    const at = ms(m.created_at) ?? 0;
    latestByUser.set(m.sender_id, {
      userId: m.sender_id,
      optionId: v.data.optionId,
      at: m.created_at,
      late: deadline !== null && at > deadline,
    });
  }

  const votes = [...latestByUser.values()];
  const counted = votes.filter((v) => !v.late);
  const tally: Record<string, number> = {};
  for (const o of options) tally[o.id] = 0;
  for (const v of counted) tally[v.optionId] = (tally[v.optionId] ?? 0) + 1;

  const deadlinePassed = deadline !== null && nowMs > deadline;
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const runnerUp = entries[1];

  let resolved = false;
  let result: string | null = null;
  let reason: ConversationDecision["reason"] = "awaiting_votes";

  if (counted.length === 0) {
    reason = deadlinePassed ? "no_votes" : "awaiting_votes";
  } else if (resolutionRule === "ASKER_DECIDES") {
    const askerVote = counted.find((v) => v.userId === decision.sender_id);
    if (askerVote) {
      resolved = true;
      result = askerVote.optionId;
      reason = "rule_satisfied";
    } else {
      reason = "asker_has_not_decided";
    }
  } else if (resolutionRule === "UNANIMOUS") {
    const allSame = counted.every((v) => v.optionId === counted[0]!.optionId);
    if (allSame && counted.length >= 2) {
      resolved = true;
      result = counted[0]!.optionId;
      reason = "rule_satisfied";
    } else {
      reason = deadlinePassed ? "tied" : "awaiting_votes";
    }
  } else if (resolutionRule === "MAJORITY") {
    if (top && top[1] * 2 > counted.length) {
      resolved = true;
      result = top[0];
      reason = "rule_satisfied";
    } else {
      reason = deadlinePassed ? "tied" : "awaiting_votes";
    }
  } else {
    // PLURALITY — resolved only when the deadline has passed or nobody can
    // catch up, and never on a tie.
    const clearWinner = Boolean(top && (!runnerUp || top[1] > runnerUp[1]));
    if (clearWinner && deadlinePassed) {
      resolved = true;
      result = top![0];
      reason = "deadline_passed";
    } else if (!clearWinner && deadlinePassed) {
      reason = "tied";
    } else {
      reason = "awaiting_votes";
    }
  }

  return {
    decisionId: decision.id,
    askedBy: decision.sender_id,
    question,
    options,
    resolutionRule,
    deadlineAt: deadlineAt ?? null,
    votes,
    tally,
    resolved,
    result,
    reason,
  };
}

// ── §8 ConversationCommitment ────────────────────────────────────────────────

export const CommitmentPayload = z.object({
  what: z.string().min(1).max(300),
  byWhen: z.string().max(64).nullish(),
  /** Who is being asked. Empty = anyone in the thread may take it. */
  askedOf: z.array(z.string().max(200)).max(50).default([]),
});

export const CommitmentResponsePayload = z.object({
  commitmentId: z.string().min(1).max(64),
  response: z.enum(["AGREED", "DECLINED", "COMPLETED"]),
  note: z.string().max(500).nullish(),
});

export interface ConversationCommitment {
  commitmentId: string;
  askedBy: string;
  what: string;
  byWhen: string | null;
  agreedBy: Array<{ userId: string; at: string }>;
  declinedBy: Array<{ userId: string; at: string }>;
  completedBy: string | null;
  completedAt: string | null;
  /** True once byWhen has passed with nothing completed. */
  overdue: boolean;
}

/** §8's ConversationCommitment, projected from the ask and the answers. */
export function projectCommitment(
  commitment: DecisionInputMessage,
  responses: DecisionInputMessage[],
  nowMs: number,
): ConversationCommitment | null {
  const parsed = CommitmentPayload.safeParse(commitment.payload);
  if (!parsed.success) return null;

  const latest = new Map<string, { response: string; at: string }>();
  let completedBy: string | null = null;
  let completedAt: string | null = null;

  for (const m of [...responses].sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))) {
    const r = CommitmentResponsePayload.safeParse(m.payload);
    if (!r.success) continue;
    if (r.data.commitmentId !== commitment.id) continue;
    if (r.data.response === "COMPLETED") {
      completedBy = m.sender_id;
      completedAt = m.created_at;
      continue;
    }
    latest.set(m.sender_id, { response: r.data.response, at: m.created_at });
  }

  const agreedBy: Array<{ userId: string; at: string }> = [];
  const declinedBy: Array<{ userId: string; at: string }> = [];
  for (const [userId, v] of latest) {
    if (v.response === "AGREED") agreedBy.push({ userId, at: v.at });
    else declinedBy.push({ userId, at: v.at });
  }

  const due = ms(parsed.data.byWhen ?? null);
  return {
    commitmentId: commitment.id,
    askedBy: commitment.sender_id,
    what: parsed.data.what,
    byWhen: parsed.data.byWhen ?? null,
    agreedBy,
    declinedBy,
    completedBy,
    completedAt,
    overdue: completedBy === null && due !== null && nowMs > due,
  };
}

// ── §19 acknowledgement, and why it is not Seen ──────────────────────────────

/**
 * §19's "Acknowledgment for important operational changes is distinct from
 * passive Seen" (census T261), and §30A.5's ANNOUNCEMENT, whose payload has
 * carried `requiresAcknowledgement` since §11 with nothing behind it.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * `AnnouncementPayload.requiresAcknowledgement` existed, the renderer drew a
 * "Got it" button for it, and the button called an `onAcknowledge` prop that
 * NO CALLER PASSED. Pressing it did nothing, on the only surface that mounts
 * the renderer. An affordance that looks built and is inert is worse for a
 * reader than an absent one — the census says exactly that about the content
 * drawer's dead `false` (T294) — so this is a defect closed, not a feature
 * added.
 *
 * ── WHY AN ACKNOWLEDGEMENT IS A MESSAGE ─────────────────────────────────────
 * Appendix A: the spec's schema names are architectural names, not permission
 * to create tables when an equivalent canonical structure exists. An
 * acknowledgement is a thing a person SAID in a thread, which is a message,
 * and it is projected back exactly the way §8's commitments and votes are.
 * That is also what keeps this reachable: a side table would need a migration,
 * and migrations 2810-2813 show what that costs — four of them exist in NO
 * database and every flag they add is seeded FALSE.
 *
 * ── WHY IT IS NOT SEEN, MECHANICALLY ────────────────────────────────────────
 * `projectAcknowledgements` takes acknowledgement MESSAGES and nothing else.
 * It is a pure function with no access to `message_thread_members.last_read_at`
 * and no parameter that could carry one, so a read receipt cannot become an
 * acknowledgement by accident or by a later edit that "helpfully" filled the
 * gap. The test asserts that separation directly: a member who has read the
 * thread and not pressed the button is OUTSTANDING.
 */
export const AcknowledgementPayload = z.object({
  /** The ANNOUNCEMENT message being acknowledged. */
  announcementMessageId: z.string().min(1).max(64),
  note: z.string().max(280).nullish(),
});

/** The ANNOUNCEMENT fields this projection needs, already parsed. */
export interface AnnouncementInputMessage {
  id: string;
  sender_id: string;
  created_at: string;
  title: string;
  requiresAcknowledgement: boolean;
}

export interface ProjectedAnnouncement {
  messageId: string;
  announcedBy: string;
  createdAt: string;
  title: string;
  requiresAcknowledgement: boolean;
  /** First acknowledgement per person, in the order they arrived. */
  acknowledgedBy: Array<{ userId: string; at: string; note: string | null }>;
  /**
   * Members who have not acknowledged, or NULL when the roster was not
   * supplied. Null rather than `[]`, because an empty list reads as "everybody
   * has acknowledged" and that is the one answer this must never invent.
   */
  outstanding: string[] | null;
  /** True only when the roster is known AND nobody is outstanding. */
  complete: boolean | null;
}

/**
 * §19's acknowledgement state for a thread's announcements.
 *
 * Rules, each asserted in `src/test/telegraphCoordination.test.ts`:
 *   - The FIRST acknowledgement by a person wins. Pressing twice does not move
 *     the timestamp; an acknowledgement is a fact about when somebody saw a
 *     change, and re-asserting it later does not make it later.
 *   - An acknowledgement naming a message that is not an announcement here is
 *     DROPPED, because the OUTPUT is keyed by the announcements passed in and
 *     never by what an acknowledgement claims to answer. There was a
 *     `known.has(target)` filter here as well; a mutation deleting it left
 *     every test green, which made it decoration, so it is gone and the
 *     structural property is what the test pins instead.
 *   - The announcer is not outstanding on their own announcement.
 *   - An announcement that does not ask for acknowledgement has `outstanding`
 *     and `complete` NULL, not `[]` and `true`: there is nothing for it to be
 *     complete about, and reporting it complete would let a notice nobody was
 *     asked to acknowledge look acknowledged by everyone.
 */
export function projectAcknowledgements(
  announcements: AnnouncementInputMessage[],
  acknowledgements: DecisionInputMessage[],
  memberIds?: readonly string[],
): ProjectedAnnouncement[] {
  const byAnnouncement = new Map<string, Map<string, { at: string; note: string | null }>>();

  for (const m of [...acknowledgements].sort(
    (a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0),
  )) {
    const parsed = AcknowledgementPayload.safeParse(m.payload);
    if (!parsed.success) continue;
    const target = parsed.data.announcementMessageId;
    const bucket = byAnnouncement.get(target) ?? new Map();
    // First wins: a repeat press must not move the time.
    if (!bucket.has(m.sender_id)) {
      bucket.set(m.sender_id, { at: m.created_at, note: parsed.data.note ?? null });
    }
    byAnnouncement.set(target, bucket);
  }

  return announcements.map((a) => {
    const bucket = byAnnouncement.get(a.id) ?? new Map<string, { at: string; note: string | null }>();
    const acknowledgedBy = [...bucket.entries()].map(([userId, v]) => ({
      userId,
      at: v.at,
      note: v.note,
    }));
    let outstanding: string[] | null = null;
    if (a.requiresAcknowledgement && memberIds) {
      outstanding = memberIds.filter((id) => id !== a.sender_id && !bucket.has(id));
    }
    return {
      messageId: a.id,
      announcedBy: a.sender_id,
      createdAt: a.created_at,
      title: a.title,
      requiresAcknowledgement: a.requiresAcknowledgement,
      acknowledgedBy,
      outstanding,
      complete: outstanding === null ? null : outstanding.length === 0,
    };
  });
}

// ── §8.1 native actions, as messages ─────────────────────────────────────────

export const ActionMessagePayload = z.object({
  action: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  objectType: z.string().max(40).nullish(),
  objectId: z.string().max(200).nullish(),
  detail: z.string().max(500).nullish(),
  /** §8.2: everything a client sends here is a PROPOSAL. */
  requiresConfirmation: z.literal(true).default(true),
});

/**
 * The §8.1 actions this route can carry as a coordination message.
 *
 * The seven absent ones are NOT missing: they are owned by a canonical
 * surface and go through it — ADD_TO_TRIP through the trip wishlist,
 * CREATE_PLAN / JOIN_PLAN / LEAVE_PLAN / VOTE through meetups, SHARE_PLACE
 * through the share route (§5), CHECK_IN_SAFE through the §6.2 SAFETY kind.
 * Routing them through here as well would be a second writer for the same
 * fact, which is exactly what Appendix A forbids.
 */
export const COORDINATION_ACTIONS: readonly TelegraphAction[] = [
  "MEET_HERE",
  "SHARE_ROUTE",
  "SHARE_AVAILABILITY",
  "SHARE_LOCATION",
  "SPLIT_RIDE",
  "RETURN_TO_GROUP",
  "DO_THIS_NOW",
] as const;

export function isCoordinationAction(v: unknown): v is TelegraphAction {
  return isTelegraphAction(v) && (COORDINATION_ACTIONS as readonly string[]).includes(v);
}

// ── the message kinds this module writes ─────────────────────────────────────

/**
 * §8 and §9 need carriers, and §6.2's thirteen kinds do not include one for a
 * quick state, a decision, a vote, a rendezvous or a commitment. These are
 * therefore ADDITIONAL kinds serving §8/§9/§19, not members of §6.2's list —
 * and saying so is the point: §6.2's thirteen are accounted for exactly in
 * `services/telegraph/messageKinds.ts`, and nothing here silently grows that
 * list.
 *
 * ACKNOWLEDGEMENT is the eighth and it is the odd one: it serves §19's
 * "acknowledgment … distinct from passive Seen" rather than §8 or §9, and it
 * answers a §6.2 ANNOUNCEMENT rather than a coordination message. It lives
 * here because this module is where a fact a person asserts in a thread is
 * carried as a message and read back as a projection, and duplicating that
 * machinery next to the ANNOUNCEMENT schema would be a second convention for
 * one job.
 */
export const COORDINATION_KINDS = [
  "COORDINATION",
  "DECISION",
  "VOTE",
  "RENDEZVOUS",
  "COMMITMENT",
  "COMMITMENT_RESPONSE",
  "ACTION_PROPOSAL",
  "ACKNOWLEDGEMENT",
] as const;

export type CoordinationKind = (typeof COORDINATION_KINDS)[number];

const COORDINATION_PAYLOADS = {
  COORDINATION: QuickStatePayload,
  DECISION: DecisionPayload,
  VOTE: VotePayload,
  RENDEZVOUS: RendezvousPayload,
  COMMITMENT: CommitmentPayload,
  COMMITMENT_RESPONSE: CommitmentResponsePayload,
  ACTION_PROPOSAL: ActionMessagePayload,
  ACKNOWLEDGEMENT: AcknowledgementPayload,
} as const;

export const COORDINATION_ENVELOPE_VERSION = "1" as const;

export type CoordinationValidateResult =
  | { ok: true; kind: CoordinationKind; msgType: string; subtype: string | null; envelope: unknown }
  | { ok: false; error: string };

export function validateCoordinationMessage(
  kind: unknown,
  payload: unknown,
): CoordinationValidateResult {
  if (typeof kind !== "string" || !(COORDINATION_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of: ${COORDINATION_KINDS.join(", ")}` };
  }
  const k = kind as CoordinationKind;
  const parsed = COORDINATION_PAYLOADS[k].safeParse(payload ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? `Invalid ${k} payload` };
  }
  const data: any = parsed.data;
  if (k === "ACTION_PROPOSAL" && !isCoordinationAction(data.action)) {
    return {
      ok: false,
      error:
        `action must be one of: ${COORDINATION_ACTIONS.join(", ")}. ` +
        "The other §8.1 actions are owned by a canonical surface and go through it.",
    };
  }
  return {
    ok: true,
    kind: k,
    msgType: k.toLowerCase(),
    subtype: coordinationSubtype(k, data),
    envelope: { kind: k, envelopeVersion: COORDINATION_ENVELOPE_VERSION, payload: data },
  };
}

function coordinationSubtype(kind: CoordinationKind, payload: any): string | null {
  switch (kind) {
    case "COORDINATION":
      return isCoordinationQuickState(payload?.state) ? String(payload.state).toLowerCase() : null;
    case "ACTION_PROPOSAL":
      return typeof payload?.action === "string" ? payload.action.toLowerCase() : null;
    case "COMMITMENT_RESPONSE":
      return typeof payload?.response === "string" ? payload.response.toLowerCase() : null;
    case "DECISION":
      return typeof payload?.resolutionRule === "string" ? payload.resolutionRule.toLowerCase() : null;
    default:
      return null;
  }
}

export function parseCoordinationEnvelope(
  msgType: string | null | undefined,
  body: string | null | undefined,
): { kind: CoordinationKind; payload: any } | null {
  if (typeof msgType !== "string" || typeof body !== "string" || body.length === 0) return null;
  const kind = msgType.toUpperCase();
  if (!(COORDINATION_KINDS as readonly string[]).includes(kind)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || parsed.kind !== kind || parsed.envelopeVersion !== COORDINATION_ENVELOPE_VERSION) {
    return null;
  }
  const check = COORDINATION_PAYLOADS[kind as CoordinationKind].safeParse(parsed.payload);
  if (!check.success) return null;
  return { kind: kind as CoordinationKind, payload: check.data };
}

// ── the thread's live coordination view ──────────────────────────────────────

export interface QuickStateRow {
  userId: string;
  state: CoordinationQuickState;
  at: string;
  approximateLabel: string | null;
  note: string | null;
  /** §9.1: always USER_DECLARED here; a derived estimate is a different field. */
  provenance: typeof QUICK_STATE_PROVENANCE;
}

export interface ThreadCoordination {
  threadId: string;
  generatedAt: string;
  /** The plan the thread is coordinating around, when there is one. */
  plan: (CoordinatedPlan & { leaveByAt: string | null }) | null;
  state: CoordinationState | null;
  /** §9: is the thread in its temporary coordination surface right now? */
  coordinating: boolean;
  legalNext: readonly CoordinationState[];
  /** The latest declared status per member (§9.1). */
  quickStates: QuickStateRow[];
  /** §9 Assembling: "arrival counts", derived from declared states only. */
  arrivedCount: number;
  onMyWayCount: number;
  decisions: ConversationDecision[];
  commitments: ConversationCommitment[];
  rendezvous: Array<{ messageId: string; setBy: string; at: string; payload: any }>;
}

/** Latest declared quick state per member, newest first. */
export function latestQuickStates(
  rows: Array<{ sender_id: string; created_at: string; payload: any }>,
): QuickStateRow[] {
  const byUser = new Map<string, QuickStateRow>();
  for (const r of [...rows].sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))) {
    const p = QuickStatePayload.safeParse(r.payload);
    if (!p.success) continue;
    byUser.set(r.sender_id, {
      userId: r.sender_id,
      state: p.data.state,
      at: r.created_at,
      approximateLabel: p.data.approximateLabel ?? null,
      note: p.data.note ?? null,
      provenance: QUICK_STATE_PROVENANCE,
    });
  }
  return [...byUser.values()].sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}
