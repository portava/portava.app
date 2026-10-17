/**
 * Telegraph §30A.19 — the Context Kernel's POLICY: five inputs in, what the
 * surface may reveal and which actions it may offer out (census-telegraph T439).
 *
 * Spec v1.1 §30A.19, verbatim:
 *   "Formalize a Context Kernel above the transport layer. Inputs are
 *    Relationship, Time, Proximity, Intent, and Shared Objects. These feed
 *    Policy + Capabilities, which determine what the Telegraph surface may
 *    reveal and what actions it may offer."
 *
 * census-telegraph T439 (N): "No kernel. Two of the five inputs exist as
 * scattered, uncomposed resolvers … Nothing assembles them." This module is
 * the composition, as a PURE function: it takes the five readings plus the
 * §14.1 capability answer and decides. `contextKernel.ts` gathers the readings
 * from the resolvers that already exist; nothing here touches a table.
 *
 * ── ABOVE TRANSPORT ─────────────────────────────────────────────────────────
 * No input here is a message. Intent is the ONE input derived from message
 * text, and what crosses into this module is the classifier's label, its
 * confidence, the message id and its time — never the body. The kernel cannot
 * become a second copy of conversation content because its types cannot carry
 * one.
 *
 * ── IT NARROWS; IT NEVER GRANTS ─────────────────────────────────────────────
 * §14.1's capabilities are the policy's floor and ceiling at once: an action is
 * offered only when the capability that governs it is TRUE in
 * `resolveConversationCapabilities`' answer, and the kernel has no branch that
 * turns a false into a true. Every rule below can only WITHHOLD — an input, or
 * an action. Execution is still re-authorized by the owning domain (§30A.10,
 * T410); this is what the surface OFFERS, like `actionsWhileLive`.
 *
 * ── HOW EACH INPUT FEEDS THE POLICY ─────────────────────────────────────────
 *   Relationship   BLOCKED (either direction) gets the non-member answer, byte for
 *                  byte (T439): all five withheld, the clock included, nothing offered — §15.3, "no subsystem may rediscover a
 *                  blocked relationship". In a direct conversation it is also
 *                  the gate on Proximity: a bucket is revealed only about
 *                  somebody the viewer has an ACTIVE or TEMPORARY relationship
 *                  with (§30A.1's states with a live origin). An unread
 *                  relationship (flag off, read failed) admits no proximity.
 *   Time           The §3.3 band of the soonest revealed shared object. Only a
 *                  shared object HAPPENING NOW puts §2.3's NOW actions (meet
 *                  here, live location scope, return) on offer.
 *   Proximity      Somebody in the nearest bucket (`same_area`) puts MEET_HERE
 *                  on offer — §2.3's "meet here".
 *   Intent         The detected intent's action (`intentAction`).
 *   Shared Objects Each revealed object's own `availableActions` (already
 *                  narrowed by `actionsWhileLive`), and the Time band above.
 *
 * Every candidate action then passes `ACTION_GOVERNING_CAPABILITY`.
 *
 * ── FAIL DIRECTION ──────────────────────────────────────────────────────────
 * A reading that is not `read` is WITHHELD with its reason, never published as
 * a floor: "you share nothing" built from a failed read is a statement about
 * two people that is false. `degraded` names every input that was unreadable.
 */
import {
  allDenied, type ConversationCapabilities,
  type ConversationCapabilityName,
  type ResolvedConversationCapabilities,
} from "../../domain/telegraph/contracts/conversationCapabilities.js";
import type { TelegraphReason } from "../../domain/telegraph/contracts/telegraphReasonCodes.js";
import type {
  TelegraphRelationship,
  TelegraphRelationshipState,
} from "../../domain/telegraph/contracts/telegraphRelationship.js";
import type { ProximityBucket } from "../../lib/proximityBuckets.js";
import type { IntentType } from "../telegraphIntent.js";
import { NOW_ACTIONS } from "./layers.js";
import {
  bandRank,
  type SharedContextBand,
  type SharedContextItem,
  type TelegraphSharedContextProjection,
} from "./sharedContext.js";
import { TELEGRAPH_ACTIONS, type TelegraphAction, type TelegraphObjectType } from "./vocabulary.js";

// ── the five inputs ──────────────────────────────────────────────────────────

/** §30A.19's five inputs, verbatim and in the spec's order. */
export const CONTEXT_KERNEL_INPUTS = ["relationship", "time", "proximity", "intent", "sharedObjects"] as const;
export type ContextKernelInput = (typeof CONTEXT_KERNEL_INPUTS)[number];

/**
 * What a gatherer can say about one input. Four states, because "off",
 * "does not apply here" and "could not be read" are three different facts and
 * a client told only "absent" would render all three as "nothing".
 */
export type KernelReading<T> =
  | { readonly status: "read"; readonly value: T }
  /** The input's own feature flag is off on this deployment. */
  | { readonly status: "off"; readonly detail: string }
  /** The input has no meaning here (relationship in a group, intent in an E2EE thread). */
  | { readonly status: "not_applicable"; readonly detail: string }
  /** A read failed. Never published as a floor. */
  | { readonly status: "unreadable"; readonly detail: string };

/** One person's proximity, bucket-only — the reachable projection's shape, no finer. */
export interface KernelProximityPerson {
  readonly userId: string;
  readonly bucket: ProximityBucket;
  readonly travel: string;
  readonly freshness: string;
}

export interface KernelProximity {
  readonly people: readonly KernelProximityPerson[];
}

/** The classifier's verdict on the newest message it recognised. No body, by type. */
export interface KernelIntent {
  readonly intent: IntentType;
  readonly confidence: number;
  readonly messageId: string;
  readonly at: string;
  readonly sentByViewer: boolean;
}

export interface KernelSharedObjects {
  readonly projection: TelegraphSharedContextProjection;
  /** A resolver failed: the rail is a floor, and says so (the rail's own `incomplete`). */
  readonly incomplete: boolean;
}

/** The Time input as the kernel states it. The clock is UTC and says so (T423). */
export interface KernelTime {
  readonly now: string;
  readonly frame: "UTC";
  /** §3.3's band of the soonest revealed live shared object, or null when none was revealed. */
  readonly band: SharedContextBand | null;
  /** The start of the soonest revealed object that has not started yet, or null. */
  readonly nextStartsAt: string | null;
}

// ── withholding reasons ──────────────────────────────────────────────────────

/** Why an input was not revealed. Closed, and `KERNEL_BLOCKED` never reaches the wire. */
export const CONTEXT_KERNEL_WITHHELD = [
  "KERNEL_NOT_MEMBER",
  "KERNEL_BLOCKED",
  "KERNEL_INPUT_OFF",
  "KERNEL_INPUT_NOT_APPLICABLE",
  "KERNEL_INPUT_UNREADABLE",
  "KERNEL_RELATIONSHIP_REQUIRED",
] as const;
export type ContextKernelWithheld = (typeof CONTEXT_KERNEL_WITHHELD)[number];

/**
 * The capabilities route's rule, applied to the kernel's own vocabulary: a
 * block is a true reason that must not be told, so it reads as "not a member"
 * — the same answer as a thread that does not exist or that the viewer left.
 */
export function redactKernelReasonForWire(r: ContextKernelWithheld): ContextKernelWithheld {
  return r === "KERNEL_BLOCKED" ? "KERNEL_NOT_MEMBER" : r;
}

// ── action tables ────────────────────────────────────────────────────────────

/**
 * The §14.1 capability that governs each §8.1 action. Creating or changing a
 * plan is `canCreatePlan` (the Compass gate's rule for a plan draft, and the
 * restriction policy's `decidePlanCreation`); every other action is something
 * the viewer does INTO this conversation — a card, a share, a vote, a check-in
 * — and is offered only while the viewer may post here at all.
 */
export const ACTION_GOVERNING_CAPABILITY: Readonly<Record<TelegraphAction, ConversationCapabilityName>> = {
  ADD_TO_TRIP: "canCreatePlan",
  CREATE_PLAN: "canCreatePlan",
  JOIN_PLAN: "canSendMessage",
  LEAVE_PLAN: "canSendMessage",
  MEET_HERE: "canSendMessage",
  SHARE_PLACE: "canSendMessage",
  SHARE_ROUTE: "canSendMessage",
  VOTE: "canSendMessage",
  SHARE_AVAILABILITY: "canSendMessage",
  SHARE_LOCATION: "canSendMessage",
  SPLIT_RIDE: "canSendMessage",
  CHECK_IN_SAFE: "canSendMessage",
  RETURN_TO_GROUP: "canSendMessage",
  DO_THIS_NOW: "canSendMessage",
};

/**
 * Each `detectIntent` label's §8.1 action. This kernel's own table, after the
 * suggestion cards (ACTION_FOR_INTENT): meetup and plan → CREATE_PLAN (a plan in
 * a TRIP conversation → ADD_TO_TRIP), time poll → VOTE, places → SHARE_PLACE.
 * Two depart from the cards, stated: availability → SHARE_AVAILABILITY (not a
 * time poll) and transport → SHARE_ROUTE (not a place).
 */
export function intentAction(intent: IntentType, conversationType: string): TelegraphAction {
  switch (intent) {
    case "create_meetup":
    case "layover_meetup":
      return "CREATE_PLAN";
    case "add_to_plan":
    case "general_plan":
      return conversationType === "trip" ? "ADD_TO_TRIP" : "CREATE_PLAN";
    case "time_poll":
      return "VOTE";
    case "availability_match":
      return "SHARE_AVAILABILITY";
    case "transport":
      return "SHARE_ROUTE";
    case "find_place":
    case "suggest_activity":
    case "nightlife":
    case "food":
    case "attraction":
    case "beach":
    case "layover_activity":
    case "layover_food":
      return "SHARE_PLACE";
  }
}

/** §30A.1 states with a live origin. Only these admit a proximity bucket in a direct conversation. */
export const PROXIMITY_ADMITTING_STATES: readonly TelegraphRelationshipState[] = ["ACTIVE", "TEMPORARY"];

/** The bucket that puts "meet here" on offer: the nearest rung on the ladder. */
export const MEET_HERE_BUCKET: ProximityBucket = "same_area";

// ── the decision ─────────────────────────────────────────────────────────────

export interface ContextKernelFacts {
  readonly conversationId: string;
  readonly viewerId: string;
  readonly conversationType: string;
  /** Active membership, established by the gatherer's own fail-closed read. */
  readonly member: boolean;
  /** §14.1's answer for this viewer here — the policy's ceiling. */
  readonly capabilities: ResolvedConversationCapabilities;
  readonly relationship: KernelReading<TelegraphRelationship>;
  readonly proximity: KernelReading<KernelProximity>;
  /** `value: null` means read, and no message carried a recognisable intent. */
  readonly intent: KernelReading<KernelIntent | null>;
  readonly sharedObjects: KernelReading<KernelSharedObjects>;
  readonly nowMs: number;
}

export interface KernelInputVerdict<T> {
  readonly revealed: boolean;
  readonly reason: ContextKernelWithheld | null;
  readonly detail: string | null;
  readonly value: T | null;
}

export interface KernelOfferedAction {
  readonly action: TelegraphAction;
  readonly source: ContextKernelInput;
  readonly capability: ConversationCapabilityName;
  readonly objectType?: TelegraphObjectType;
  readonly objectId?: string;
}

export interface KernelWithheldAction extends KernelOfferedAction {
  readonly reason: TelegraphReason;
}

export interface ContextKernel {
  readonly conversationId: string;
  readonly viewerId: string;
  readonly conversationType: string;
  readonly generatedAt: string;
  readonly inputs: {
    readonly relationship: KernelInputVerdict<TelegraphRelationship>;
    readonly time: KernelInputVerdict<KernelTime>;
    readonly proximity: KernelInputVerdict<KernelProximity>;
    readonly intent: KernelInputVerdict<KernelIntent | null>;
    readonly sharedObjects: KernelInputVerdict<KernelSharedObjects>;
  };
  readonly capabilities: ConversationCapabilities;
  readonly capabilityReasons: Readonly<Record<ConversationCapabilityName, TelegraphReason | null>>;
  readonly offeredActions: readonly KernelOfferedAction[];
  readonly withheldActions: readonly KernelWithheldAction[];
  /** The inputs whose reading was actually `read`. */
  readonly inputsRead: readonly ContextKernelInput[];
  /** An input was unreadable, a shared-object resolver failed, or §14.1 itself degraded. */
  readonly degraded: boolean;
  readonly degradedInputs: readonly ContextKernelInput[];
}

function withheld<T>(reason: ContextKernelWithheld, detail: string | null): KernelInputVerdict<T> {
  return { revealed: false, reason, detail, value: null };
}

function revealed<T>(value: T): KernelInputVerdict<T> {
  return { revealed: true, reason: null, detail: null, value };
}

/** A reading that was not `read`, as the verdict that says why. */
function fromReading<T>(r: KernelReading<T>): KernelInputVerdict<T> {
  switch (r.status) {
    case "read":
      return revealed(r.value);
    case "off":
      return withheld("KERNEL_INPUT_OFF", r.detail);
    case "not_applicable":
      return withheld("KERNEL_INPUT_NOT_APPLICABLE", r.detail);
    case "unreadable":
      return withheld("KERNEL_INPUT_UNREADABLE", r.detail);
  }
}

/** True when the relationship input is read and admits a proximity bucket. */
export function relationshipAdmitsProximity(r: KernelReading<TelegraphRelationship>): boolean {
  return r.status === "read" && PROXIMITY_ADMITTING_STATES.includes(r.value.state);
}

/**
 * Whether a gatherer may READ proximity at all for this conversation — the same
 * rule `decideContextKernel` applies to reveal it, so a bucket the kernel would
 * withhold is never observed (and never spends the §4.3 observation budget).
 */
export function proximityMayBeRead(conversationType: string, relationship: KernelReading<TelegraphRelationship>): boolean {
  return conversationType === "direct" ? relationshipAdmitsProximity(relationship) : true;
}

function liveItems(p: TelegraphSharedContextProjection): SharedContextItem[] {
  return [...p.now, ...p.upcoming, ...p.unresolved];
}

/** The Time input, from the clock and the shared objects that were revealed. */
export function kernelTime(nowMs: number, shared: KernelSharedObjects | null): KernelTime {
  let band: SharedContextBand | null = null;
  let nextStartsAt: string | null = null;
  if (shared) {
    for (const item of [...shared.projection.now, ...shared.projection.upcoming]) {
      if (band === null || bandRank(item.orderBand) < bandRank(band)) band = item.orderBand;
      const start = item.startsAt ? Date.parse(item.startsAt) : NaN;
      if (Number.isFinite(start) && start > nowMs && (nextStartsAt === null || start < Date.parse(nextStartsAt))) {
        nextStartsAt = item.startsAt as string;
      }
    }
  }
  return { now: new Date(nowMs).toISOString(), frame: "UTC", band, nextStartsAt };
}

/**
 * Decide what the surface may reveal and offer, from the five inputs and §14.1.
 */
export function decideContextKernel(f: ContextKernelFacts): ContextKernel {
  const caps = f.capabilities;
  const base = {
    conversationId: f.conversationId,
    viewerId: f.viewerId,
    conversationType: f.conversationType,
    generatedAt: new Date(f.nowMs).toISOString(),
    capabilities: caps.capabilities,
    capabilityReasons: caps.reasons,
  };

  // 1. Not an active member: nothing about the conversation is revealed, not even its clock.
  if (!f.member) {
    return nothingRevealed(f, "KERNEL_NOT_MEMBER", caps);
  }

  const inputsRead = CONTEXT_KERNEL_INPUTS.filter((k) => k === "time" || (f as any)[k]?.status === "read");
  const degradedInputs = CONTEXT_KERNEL_INPUTS.filter((k) =>
    (f as any)[k]?.status === "unreadable" || (k === "sharedObjects" && f.sharedObjects.status === "read" && f.sharedObjects.value.incomplete));

  // 2. A block, seen by either the capability policy or the relationship read,
  //    gets EXACTLY the non-member answer above — census-telegraph T439. A block
  //    is the blocker's decision about the viewer, and a blocked member must not
  //    be able to tell it from "not a member here": a field in which the two
  //    answers differ would answer "did this person block me?". So ONE builder
  //    makes both (`nothingRevealed`, at the foot of this file), and the block
  //    travels only as an internal reason that the wire redacts (KERNEL_BLOCKED
  //    to KERNEL_NOT_MEMBER, TELEGRAPH_AUTH_BLOCKED to TELEGRAPH_AUTH_NOT_MEMBER).
  //    What that withholds, each of which this branch used to show:
  //      - the clock. A non-member is not shown the conversation's time;
  //      - the conversation type. "unknown", as for a thread that does not exist;
  //      - §14.1's grants (below);
  //      - inputsRead and degraded. Nothing read is shown, so nothing is listed
  //        as read; and the answer rests on the block, which WAS read, so no
  //        other read's failure can move it — and none is told.
  //    The gatherer gathers nothing for a member §14.1 saw blocked
  //    (contextKernel.ts), so no input's failure can change this answer's status.
  const blocked = caps.reasons.canSendMessage === "TELEGRAPH_AUTH_BLOCKED"
    || (f.relationship.status === "read" && f.relationship.value.state === "BLOCKED");
  if (blocked) {
    return nothingRevealed(f, "KERNEL_BLOCKED", {
      // §14.1's own answer is NOT passed through. It still GRANTS a blocked
      // member canCreatePlan and canViewPreMembershipHistory, and gives policy
      // reasons (no in-chat payment, no broadcast, a DM invite forms a group)
      // that a non-member never gets. A stranger's §14.1 answer is every
      // capability denied as NOT_MEMBER; this is every capability denied as
      // BLOCKED, which the wire redacts to exactly that.
      ...allDenied("TELEGRAPH_AUTH_BLOCKED"),
      // A stranger's §14.1 answer is not degraded, so this one is not either:
      // whether the trust state, the booking or some input failed to read is
      // not something a viewer shown nothing may learn, and it cannot change an
      // answer that withholds everything. The route test pins the two answers
      // byte-equal (telegraphConversationCapabilities.test.ts, T439 route).
      degraded: false,
    });
  }

  // 3. Each input on its own reading, then the relationship → proximity gate.
  const relationship = fromReading(f.relationship);
  const sharedObjects = fromReading(f.sharedObjects);
  const intent = fromReading(f.intent);
  const proximity: KernelInputVerdict<KernelProximity> = f.conversationType === "direct" && !relationshipAdmitsProximity(f.relationship)
    ? withheld("KERNEL_RELATIONSHIP_REQUIRED",
      f.relationship.status === "read"
        ? `a ${f.relationship.value.state} relationship admits no proximity`
        : "the relationship could not be established, so no proximity is revealed")
    : fromReading(f.proximity);
  const time = revealed(kernelTime(f.nowMs, sharedObjects.revealed ? sharedObjects.value : null));

  // 4. Candidate actions, each tagged with the input that put it on offer.
  const candidates: KernelOfferedAction[] = [];
  const add = (action: TelegraphAction, source: ContextKernelInput, obj?: { objectType: TelegraphObjectType; objectId: string }) => {
    if (!(TELEGRAPH_ACTIONS as readonly string[]).includes(action)) return;
    const dup = candidates.some((c) => c.action === action && c.source === source && c.objectId === obj?.objectId);
    if (dup) return;
    candidates.push({ action, source, capability: ACTION_GOVERNING_CAPABILITY[action], ...(obj ?? {}) });
  };
  if (sharedObjects.revealed && sharedObjects.value) {
    for (const item of liveItems(sharedObjects.value.projection)) {
      for (const a of item.availableActions) add(a, "sharedObjects", { objectType: item.objectType, objectId: item.objectId });
    }
  }
  if (time.value?.band === "HAPPENING_NOW") {
    for (const a of NOW_ACTIONS) add(a as TelegraphAction, "time");
  }
  if (proximity.revealed && proximity.value?.people.some((p) => p.bucket === MEET_HERE_BUCKET)) {
    add("MEET_HERE", "proximity");
  }
  if (intent.revealed && intent.value) {
    add(intentAction(intent.value.intent, f.conversationType), "intent");
  }

  // 5. §14.1 decides. Narrowing only: a false capability withholds; nothing grants.
  const offeredActions: KernelOfferedAction[] = [];
  const withheldActions: KernelWithheldAction[] = [];
  for (const c of candidates) {
    if (caps.capabilities[c.capability] === true) offeredActions.push(c);
    else withheldActions.push({ ...c, reason: caps.reasons[c.capability] ?? "TELEGRAPH_AUTH_NOT_MEMBER" });
  }

  return {
    ...base,
    inputs: { relationship, time, proximity, intent, sharedObjects },
    offeredActions,
    withheldActions,
    inputsRead,
    degraded: caps.degraded || degradedInputs.length > 0,
    degradedInputs,
  };
}

// ── the wire ─────────────────────────────────────────────────────────────────

/**
 * The kernel as a client may see it: every §14.1 reason through `redactForWire`
 * and every kernel reason through `redactKernelReasonForWire`, so a block reads
 * exactly as "not a member" on every field — the capabilities route's rule.
 */
export function contextKernelForWire(k: ContextKernel, redactCapability: (r: TelegraphReason) => TelegraphReason) {
  const input = <T>(v: KernelInputVerdict<T>) => ({
    revealed: v.revealed,
    reason: v.reason === null ? null : redactKernelReasonForWire(v.reason),
    detail: v.reason === "KERNEL_BLOCKED" ? null : v.detail,
    value: v.value,
  });
  const capabilityReasons: Record<string, TelegraphReason | null> = {};
  for (const [name, r] of Object.entries(k.capabilityReasons)) capabilityReasons[name] = r === null ? null : redactCapability(r);
  return {
    conversationId: k.conversationId,
    conversationType: k.conversationType,
    generatedAt: k.generatedAt,
    inputs: {
      relationship: input(k.inputs.relationship),
      time: input(k.inputs.time),
      proximity: input(k.inputs.proximity),
      intent: input(k.inputs.intent),
      sharedObjects: input(k.inputs.sharedObjects),
    },
    capabilities: k.capabilities,
    capabilityReasons,
    offeredActions: k.offeredActions,
    withheldActions: k.withheldActions.map((a) => ({ ...a, reason: redactCapability(a.reason) })),
    inputsRead: k.inputsRead,
    degraded: k.degraded,
    degradedInputs: k.degradedInputs,
  };
}

// ── the one answer for a viewer who is shown nothing (census-telegraph T439) ──

/**
 * The kernel for a viewer who is shown nothing: one who is not an active member
 * (`reason` KERNEL_NOT_MEMBER, §14.1's own refusal as `caps`), and one who is
 * blocked (`reason` KERNEL_BLOCKED, every capability denied as BLOCKED). ONE
 * builder, so the two cannot drift: through `contextKernelForWire` the blocked
 * answer is byte-identical to a stranger's, and the endpoint cannot be asked
 * "did this person block me?". The internal answer keeps the honest reason for
 * the census and the tests; only the wire forgets it.
 *
 * Nothing about the conversation: no clock (the Time input is withheld like the
 * other four), no type ("unknown", as for a thread that does not exist), nothing
 * read, nothing offered or withheld.
 */
function nothingRevealed(
  f: ContextKernelFacts,
  reason: "KERNEL_NOT_MEMBER" | "KERNEL_BLOCKED",
  caps: Pick<ResolvedConversationCapabilities, "capabilities" | "reasons" | "degraded">,
): ContextKernel {
  return {
    conversationId: f.conversationId,
    viewerId: f.viewerId,
    conversationType: "unknown",
    generatedAt: new Date(f.nowMs).toISOString(),
    inputs: {
      relationship: withheld(reason, null),
      time: withheld(reason, null),
      proximity: withheld(reason, null),
      intent: withheld(reason, null),
      sharedObjects: withheld(reason, null),
    },
    capabilities: caps.capabilities,
    capabilityReasons: caps.reasons,
    offeredActions: [],
    withheldActions: [],
    inputsRead: [],
    degraded: caps.degraded,
    degradedInputs: [],
  };
}
