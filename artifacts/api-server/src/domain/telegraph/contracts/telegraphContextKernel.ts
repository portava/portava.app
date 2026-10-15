/**
 * Telegraph §30A.19 — the Context Kernel, as a contract (census-telegraph T439).
 *
 * §30A.19, verbatim: "Formalize a Context Kernel above the transport layer.
 * Inputs are Relationship, Time, Proximity, Intent, and Shared Objects. These
 * feed Policy + Capabilities, which determine what the Telegraph surface may
 * reveal and what actions it may offer."
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
 * The SHAPE of the kernel and the rules that hold whatever the readers return:
 * the five inputs by name, the four states an input can be in, the closed
 * reason vocabulary, how a conversation gate (membership, the pair's block)
 * overrides every input, and the one wire projection. It is PURE: no client,
 * no clock, no I/O. The reads live in server/telegraph/telegraphContextKernel.ts
 * and go through resolvers that already exist; this module cannot open a read
 * path, so it cannot widen one.
 *
 * ── NOT lib/contextKernel.ts ────────────────────────────────────────────────
 * That module is Sensing §6's platform kernel (§18.1's nine contexts for the
 * Opportunity Engine). It is request-scoped and carries no viewer identity and
 * no relationship BY DESIGN ("No viewer id, no profile, no account handle"), so
 * Telegraph's first input cannot be expressed through it. This one is
 * conversation-scoped and viewer-scoped. Neither imports the other.
 *
 * ── FOUR STATES, NEVER A GUESS ──────────────────────────────────────────────
 *   read           the input was read; `value` is what the source published.
 *   degraded       a read it rests on FAILED; no value. Never "nothing there".
 *   not_consulted  the input does not apply here (its source is switched off,
 *                  or it is pairwise and this is not a two-person conversation).
 *   withheld       the input applies and is not shown to this viewer (not a
 *                  member, a block either way, the source published nothing).
 * A value exists ONLY in `read`. The type makes the other three value-less, so
 * no reader can hand back a "floor" built from a failed read.
 *
 * ── THE GATE OUTRANKS EVERY INPUT ───────────────────────────────────────────
 * A viewer who is not an active member — never one, or one who LEFT — gets every
 * input withheld with exactly the body a thread that does not exist gets (200,
 * never a membership oracle; contextForWire). A block EITHER WAY in a direct conversation
 * withholds all five — the minimal context — and the reason is redacted on the
 * wire to the non-member's reason, so the endpoint is not a block oracle (§15.3:
 * "No subsystem may independently rediscover a blocked relationship"). A block
 * state that could not be read withholds all five too, as unreadable.
 *
 * ── NO COORDINATE IS REPRESENTABLE ──────────────────────────────────────────
 * Proximity is a bucket name and a freshness band — `precision` is the literal
 * type "bucket" — and the wire projection copies named fields only. A reader
 * that handed back a richer object would have every other field dropped here.
 *
 * Grading: T439 is W while `telegraph_context_kernel_enabled` (3826) is seeded
 * OFF and unapplied, and while the conversation surfaces (B58 TM-6) do not read
 * the kernel.
 */
import type { MessageVerdict } from "../../../lib/messagingPermissions.js";
import type { ProximityBucket } from "../../../lib/proximityBuckets.js";
import { redactForWire, isTelegraphReason, type TelegraphReason } from "./telegraphReasonCodes.js";
import type { TelegraphRelationshipOrigin, TelegraphRelationshipState } from "./telegraphRelationship.js";

/** The capability flag (3826, seeded FALSE). */
export const CONTEXT_KERNEL_FLAG = "telegraph_context_kernel_enabled";

/** §30A.19's five inputs, in the spec's order. */
export const CONTEXT_INPUTS = ["relationship", "time", "proximity", "intent", "sharedObjects"] as const;
export type ContextInputName = (typeof CONTEXT_INPUTS)[number];

/**
 * Inputs that are a statement about ONE other person. They exist only in a
 * direct conversation with exactly one other active member; anywhere else they
 * are `not_consulted` (§18.3: a member's relationships with third parties are
 * never exposed, and a group has no single "other").
 */
export const PAIRWISE_INPUTS: readonly ContextInputName[] = ["relationship", "proximity"];

export const CONTEXT_INPUT_STATUSES = ["read", "degraded", "not_consulted", "withheld"] as const;
export type ContextInputStatus = (typeof CONTEXT_INPUT_STATUSES)[number];

/**
 * The kernel's own reasons, for the states the §14.1 vocabulary has no word
 * for. Membership, the block and unreadable gates use telegraphReasonCodes.ts.
 */
export const CONTEXT_KERNEL_REASONS = [
  /** The input's own source is switched off (relationship: 3662's flag; proximity: Nearby's). */
  "KERNEL_SOURCE_OFF",
  /** A pairwise input, in a conversation that is not direct with exactly one other active member. */
  "KERNEL_PAIRWISE_ONLY",
  /**
   * The source published nothing for this viewer. ONE undifferentiated reason:
   * Nearby's own rule — per-reason answers told a viewer, in a small crew, that
   * a named person had sharing off or was inside a protected zone.
   */
  "KERNEL_NOT_SHOWN",
  /** Proximity only: Nearby's own per-viewer rate limit, which the kernel shares. */
  "KERNEL_RATE_LIMITED",
  /** A read this input rests on failed (returned an error, or threw). */
  "KERNEL_SOURCE_UNREADABLE",
] as const;
export type ContextKernelReason = (typeof CONTEXT_KERNEL_REASONS)[number];

export type ContextReason = TelegraphReason | ContextKernelReason;

const KERNEL_REASONS = new Set<string>(CONTEXT_KERNEL_REASONS);
export function isContextReason(code: string): code is ContextReason {
  return KERNEL_REASONS.has(code) || isTelegraphReason(code);
}

/** One input. A value exists only when it was read. */
export type ContextInput<T> =
  | { readonly status: "read"; readonly reason: null; readonly value: T }
  | { readonly status: "degraded" | "not_consulted" | "withheld"; readonly reason: ContextReason; readonly value: null };

export function readInput<T>(value: T): ContextInput<T> {
  return { status: "read", reason: null, value };
}
export function degradedInput(reason: ContextReason): ContextInput<never> {
  return { status: "degraded", reason, value: null };
}
export function notConsultedInput(reason: ContextReason): ContextInput<never> {
  return { status: "not_consulted", reason, value: null };
}
export function withheldInput(reason: ContextReason): ContextInput<never> {
  return { status: "withheld", reason, value: null };
}

// ── the five value shapes ────────────────────────────────────────────────────
// Strings where the vocabulary lives in a service module this domain package
// may not import (check:telegraph-package-boundaries); the readers narrow them.

/**
 * RELATIONSHIP — §30A.1's canonical relationship between the viewer and the
 * other member (services/telegraph/telegraphRelationship.ts), plus the one term
 * the POLICY reads from it.
 */
export interface KernelRelationshipValue {
  readonly state: TelegraphRelationshipState;
  readonly origins: readonly TelegraphRelationshipOrigin[];
  readonly expiredOrigins: readonly TelegraphRelationshipOrigin[];
  /**
   * The other person's own message-privacy door applied to this relationship:
   * lib/messagingPermissions.ts#canMessage's verdict for viewer → other, read in
   * the same pass as the origins. The call door's messaging floor is exactly
   * this verdict (lib/calls/callGatewayAdapter.ts: `verdict.allowed === true`).
   * POLICY-INTERNAL: never put on the wire (contextForWire drops it).
   */
  readonly messagingFloor: MessageVerdict;
}

/** TIME — the conversation's plan timeline (§9) and the viewer's own §14.3 window. */
export interface KernelTimeValue {
  readonly coordination: {
    readonly planId: string;
    /** §9's derived state, or null when the plan has no state yet. Derived, never declared. */
    readonly state: string | null;
    readonly coordinating: boolean;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly leaveByAt: string | null;
  } | null;
  /** The instant the viewer's own history starts (§14.3), or null when unbounded. */
  readonly historyVisibleFrom: string | null;
}

/** PROXIMITY — a bucket name, never finer. */
export interface KernelProximityValue {
  readonly bucket: ProximityBucket;
  readonly precision: "bucket";
  readonly freshness: string;
}

/** INTENT — the planning intents already detected for this viewer in this conversation. */
export interface KernelIntentValue {
  readonly detected: readonly string[];
}

/**
 * SHARED OBJECTS — §3's rail for this viewer, as counts per array and the §11.2
 * mode. A rail any of whose reads failed is not a smaller rail: the input is
 * `degraded` and carries no counts.
 */
export interface KernelSharedObjectsValue {
  readonly now: number;
  readonly upcoming: number;
  readonly unresolved: number;
  readonly past: number;
  readonly railMode: string;
}

export interface KernelInputs {
  readonly relationship: ContextInput<KernelRelationshipValue>;
  readonly time: ContextInput<KernelTimeValue>;
  readonly proximity: ContextInput<KernelProximityValue>;
  readonly intent: ContextInput<KernelIntentValue>;
  readonly sharedObjects: ContextInput<KernelSharedObjectsValue>;
}

// ── the gate ─────────────────────────────────────────────────────────────────

export type ConversationGate =
  /** Active member. `pairwise`: direct, with exactly one other active member. */
  | { readonly kind: "member"; readonly pairwise: boolean; readonly pairBlock: "clear" | "blocked" | "unreadable" | "not_applicable" }
  /** Not an active member, or no such conversation — indistinguishable on purpose. */
  | { readonly kind: "not_member"; readonly reason: "TELEGRAPH_AUTH_NOT_MEMBER" | "TELEGRAPH_AUTH_LEFT_THREAD" }
  /** The thread, the membership row or the roster could not be read. */
  | { readonly kind: "unreadable"; readonly reason: TelegraphReason };

export interface ConversationContext {
  readonly conversationId: string;
  readonly conversationType: string;
  readonly inputs: KernelInputs;
  readonly degraded: boolean;
  readonly degradedReasons: readonly ContextReason[];
}

function every(make: (name: ContextInputName) => ContextInput<never>): KernelInputs {
  return {
    relationship: make("relationship"),
    time: make("time"),
    proximity: make("proximity"),
    intent: make("intent"),
    sharedObjects: make("sharedObjects"),
  };
}

function finish(conversationId: string, conversationType: string, inputs: KernelInputs, extra: ContextReason[] = []): ConversationContext {
  const reasons: ContextReason[] = [...extra];
  for (const name of CONTEXT_INPUTS) {
    const i = inputs[name];
    if (i.status === "degraded" && !reasons.includes(i.reason)) reasons.push(i.reason);
  }
  return { conversationId, conversationType, inputs, degraded: reasons.length > 0, degradedReasons: reasons };
}

/** Every input withheld for one reason: the shape a non-member and a blocked pair get. */
export function minimalContext(conversationId: string, conversationType: string, reason: ContextReason, degraded = false): ConversationContext {
  return finish(conversationId, conversationType, every(() => withheldInput(reason)), degraded ? [reason] : []);
}

/**
 * Compose the kernel's answer from the gate and the five readings.
 *
 * The gate decides first and wholly. For a member, each reading is taken as
 * given, with three corrections that hold whatever a reader returned:
 *   1. a reading that is MISSING is `degraded` — an input nobody supplied is
 *      never "read", and never "nothing there";
 *   2. a PAIRWISE reading in a conversation that is not pairwise is
 *      `not_consulted` — it is never served, even if a reader produced one;
 *   3. a relationship read whose state is BLOCKED (the resolver saw a block the
 *      gate's read did not — a race) withholds all five, exactly as the gate's
 *      block does: across a block nothing about the relationship is stated.
 */
export function composeConversationContext(args: {
  conversationId: string;
  conversationType: string;
  gate: ConversationGate;
  readings?: Partial<KernelInputs>;
}): ConversationContext {
  const { conversationId, conversationType, gate } = args;
  // A non-member and a blocked pair are told nothing — not even the conversation's type.
  if (gate.kind === "not_member") return minimalContext(conversationId, "unknown", gate.reason);
  if (gate.kind === "unreadable") {
    return finish(conversationId, conversationType, every(() => degradedInput(gate.reason)));
  }
  if (gate.pairBlock === "blocked") return minimalContext(conversationId, "unknown", "TELEGRAPH_AUTH_BLOCKED");
  if (gate.pairBlock === "unreadable") {
    return minimalContext(conversationId, conversationType, "TELEGRAPH_DEGRADED_BLOCKS_UNREADABLE", true);
  }

  const r = args.readings ?? {};
  const pick = <K extends ContextInputName>(name: K): KernelInputs[K] => {
    if (!gate.pairwise && PAIRWISE_INPUTS.includes(name)) return notConsultedInput("KERNEL_PAIRWISE_ONLY") as KernelInputs[K];
    return (r[name] ?? degradedInput("KERNEL_SOURCE_UNREADABLE")) as KernelInputs[K];
  };
  const inputs: KernelInputs = {
    relationship: pick("relationship"),
    time: pick("time"),
    proximity: pick("proximity"),
    intent: pick("intent"),
    sharedObjects: pick("sharedObjects"),
  };
  if (inputs.relationship.status === "read" && inputs.relationship.value.state === "BLOCKED") {
    return minimalContext(conversationId, "unknown", "TELEGRAPH_AUTH_BLOCKED");
  }
  return finish(conversationId, conversationType, inputs);
}

// ── the wire ─────────────────────────────────────────────────────────────────

/** A reason as it may be told: internal-only Telegraph codes are redacted, and a member who LEFT is told a stranger's reason (one refused shape). */
export function contextReasonForWire(reason: ContextReason): ContextReason {
  return reason === "TELEGRAPH_AUTH_LEFT_THREAD" ? "TELEGRAPH_AUTH_NOT_MEMBER" : isTelegraphReason(reason) ? redactForWire(reason) : reason;
}

function wireInput<T, W>(input: ContextInput<T>, project: (v: T) => W): { status: ContextInputStatus; reason: ContextReason | null; value: W | null } {
  if (input.status === "read") return { status: "read", reason: null, value: project(input.value) };
  return { status: input.status, reason: contextReasonForWire(input.reason), value: null };
}

/**
 * The one wire projection. Named fields only, copied: whatever else a reader
 * put on a value does not leave. `messagingFloor` is the policy's and stays here.
 */
export function contextForWire(ctx: ConversationContext) {
  const i = ctx.inputs;
  return {
    conversationId: ctx.conversationId,
    conversationType: ctx.conversationType,
    inputs: {
      relationship: wireInput(i.relationship, (v) => ({ state: v.state, origins: [...v.origins], expiredOrigins: [...v.expiredOrigins] })),
      time: wireInput(i.time, (v) => ({
        coordination: v.coordination === null ? null : {
          planId: v.coordination.planId,
          state: v.coordination.state,
          coordinating: v.coordination.coordinating,
          startsAt: v.coordination.startsAt,
          endsAt: v.coordination.endsAt,
          leaveByAt: v.coordination.leaveByAt,
        },
        historyVisibleFrom: v.historyVisibleFrom,
      })),
      proximity: wireInput(i.proximity, (v) => ({ bucket: v.bucket, precision: "bucket" as const, freshness: v.freshness })),
      intent: wireInput(i.intent, (v) => ({ detected: [...v.detected] })),
      sharedObjects: wireInput(i.sharedObjects, (v) => ({
        now: v.now, upcoming: v.upcoming, unresolved: v.unresolved, past: v.past, railMode: v.railMode,
      })),
    },
    degraded: ctx.degraded,
    degradedReasons: [...new Set(ctx.degradedReasons.map(contextReasonForWire))],
  };
}
