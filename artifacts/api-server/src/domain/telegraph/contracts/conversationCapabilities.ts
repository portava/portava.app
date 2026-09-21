/**
 * Telegraph §14.1 — `ConversationCapabilities`, the contract verbatim.
 *
 * THE SPEC, COPIED
 * ================
 *   type ConversationCapabilities = {
 *     canSendMessage: boolean
 *     canCall: boolean
 *     canCreatePlan: boolean
 *     canShareExactLocation: boolean
 *     canInvite: boolean
 *     canRequestPayment: boolean
 *     canCreateBooking: boolean
 *     canBroadcast: boolean
 *     canViewPreMembershipHistory: boolean
 *     canSeeGroupReadReceipts: boolean
 *   }
 *   "Capabilities are derived server-side from membership, block state,
 *    Trip/Crew membership, booking state, age/policy, location scope, safety
 *    state and conversation type. UI renders capabilities; it does not invent
 *    authorization."
 *
 * WHY A REASON PER CAPABILITY
 * ===========================
 * census-telegraph T199-T207 found the enforcement real and the MODEL absent:
 * plan creation is gated by a trip-membership re-check inside a command
 * handler, exact-location precision is a property of a location session, call
 * eligibility lives in the call permission engine — eight different places, no
 * single answer, and no way for a client to ask "what can I do here" without
 * attempting each operation and reading the failure. A bare boolean would fix
 * the shape and keep the silence: `canCreatePlan: false` is unactionable.
 * Every capability therefore carries the reason it is false, drawn from the one
 * declared vocabulary (`telegraphReasonCodes.ts`).
 *
 * A capability that is TRUE carries `reason: null`. There is no "allowed
 * because" code, because a permission that needs a justification string is a
 * permission somebody will be tempted to grant by writing one.
 *
 * THIS IS A PROJECTION, NOT THE GATE
 * ==================================
 * §14.1's last sentence is the load-bearing one. Nothing in the repository may
 * read a capability from a client, and nothing may replace an enforcement point
 * with a capability lookup: the send path still re-derives membership and the
 * block state itself, the command route still re-verifies trip membership at
 * execution. This contract exists so the UI can render the truth, and so the
 * census has one object to read instead of eight. `CAPABILITY_ENFORCEMENT_SITES`
 * below names, for each capability, the code that actually refuses — so the
 * claim "this is a projection of a real gate" is checkable rather than asserted.
 */

import type { TelegraphReason } from "./telegraphReasonCodes.js";

/** §14.1 verbatim. Field names are the spec's, not the repository's. */
export interface ConversationCapabilities {
  canSendMessage: boolean;
  canCall: boolean;
  canCreatePlan: boolean;
  canShareExactLocation: boolean;
  canInvite: boolean;
  canRequestPayment: boolean;
  canCreateBooking: boolean;
  canBroadcast: boolean;
  canViewPreMembershipHistory: boolean;
  canSeeGroupReadReceipts: boolean;
}

export type ConversationCapabilityName = keyof ConversationCapabilities;

export const CONVERSATION_CAPABILITY_NAMES: readonly ConversationCapabilityName[] = [
  "canSendMessage",
  "canCall",
  "canCreatePlan",
  "canShareExactLocation",
  "canInvite",
  "canRequestPayment",
  "canCreateBooking",
  "canBroadcast",
  "canViewPreMembershipHistory",
  "canSeeGroupReadReceipts",
] as const;

/** The eight inputs §14.1 names, as a closed set the resolver must account for. */
export const CAPABILITY_INPUTS = [
  "membership",
  "blockState",
  "tripCrewMembership",
  "bookingState",
  "agePolicy",
  "locationScope",
  "safetyState",
  "conversationType",
] as const;
export type CapabilityInput = (typeof CAPABILITY_INPUTS)[number];

/**
 * For each capability, WHERE the refusal actually happens. Not decoration: the
 * point of §14.1's final sentence is that this object never becomes the gate,
 * and a reader checking that needs to be able to find the gate.
 *
 * An entry of `null` means there is no operation to gate — the capability is
 * modelled and permanently false, and the census must read it as
 * declared-not-emitted rather than as a built capability.
 */
export const CAPABILITY_ENFORCEMENT_SITES: Record<ConversationCapabilityName, string | null> = {
  canSendMessage: "routes/messaging.ts POST /threads/:threadId/messages — membership, block guard, E2EE",
  canCall: "routes/calls.ts — canUserStartCall / canUserStartGroupCall / canUserJoinCall",
  canCreatePlan: "routes/telegraphCommands.ts — trip membership re-verified at execution",
  canShareExactLocation: "routes/safeReturn.ts + trip_crew_location_sessions.visibility_level",
  canInvite: null,          // §14.3: no add-participant operation exists on any thread
  canRequestPayment: null,  // §20: no in-chat payment request exists, by policy
  canCreateBooking: "routes/rentABuddy.ts — enforceBookingCreationGates / checkBookingKycGate",
  canBroadcast: null,       // §14.1 names it; no broadcast primitive exists
  canViewPreMembershipHistory: "routes/messaging.ts GET /threads/:threadId/messages — visible_from bound",
  canSeeGroupReadReceipts: "server/telegraph/readReceiptsRoute.ts GET /threads/:threadId/read-receipts",
};

/** One capability's answer: the boolean, and why when it is false. */
export interface CapabilityVerdict {
  allowed: boolean;
  reason: TelegraphReason | null;
}

/**
 * The resolved set: the §14.1 booleans, plus per-capability reasons, plus the
 * honesty fields.
 *
 * `degraded` is set when at least one input read FAILED. It is not cosmetic: a
 * capability set computed over an unreadable blocks table is a floor, not the
 * truth, and a client that renders it as the truth will show a user an action
 * that will then be refused. The route surfaces it; the UI is expected to
 * prefer "try again" over a confident false.
 */
export interface ResolvedConversationCapabilities {
  conversationId: string;
  viewerId: string;
  conversationType: string;
  capabilities: ConversationCapabilities;
  reasons: Record<ConversationCapabilityName, TelegraphReason | null>;
  /** Which of the eight §14.1 inputs were actually read for this answer. */
  inputsRead: CapabilityInput[];
  degraded: boolean;
  degradedReasons: TelegraphReason[];
}

/** Every capability false, with one reason. The shape a refusal returns. */
export function allDenied(reason: TelegraphReason): {
  capabilities: ConversationCapabilities;
  reasons: Record<ConversationCapabilityName, TelegraphReason | null>;
} {
  const capabilities = {} as ConversationCapabilities;
  const reasons = {} as Record<ConversationCapabilityName, TelegraphReason | null>;
  for (const name of CONVERSATION_CAPABILITY_NAMES) {
    capabilities[name] = false;
    reasons[name] = reason;
  }
  return { capabilities, reasons };
}
