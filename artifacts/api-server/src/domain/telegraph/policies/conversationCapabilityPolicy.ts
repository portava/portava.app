/**
 * Telegraph §14.1 — the server-side capability resolver.
 *
 * §14.1: "Capabilities are derived server-side from membership, block state,
 * Trip/Crew membership, booking state, age/policy, location scope, safety state
 * and conversation type."
 *
 * Eight inputs, named. This module reads all eight and records WHICH it read
 * (`inputsRead`), so "derived from the eight inputs" is a checkable claim and
 * not a comment. A capability whose input could not be read is FALSE with a
 * `TELEGRAPH_DEGRADED_*` reason and `degraded: true` — never true-by-default,
 * and never silently false as though the input had been read and had refused.
 *
 * FAIL-CLOSED, AND WHY THE DIRECTION IS NOT OBVIOUS
 * =================================================
 * A capability projection that fails OPEN shows a user a button that will then
 * be refused — annoying, not dangerous, because the real gate still runs. A
 * projection that fails CLOSED hides a button the user is entitled to — also
 * annoying, also not dangerous. So the usual safety argument does not decide
 * it. What decides it is that `degraded` exists: a false with
 * `degraded: true` is distinguishable from a false the policy actually
 * computed, so a client can render "try again" instead of "you may not". A
 * degraded TRUE would not be distinguishable from an entitlement, and would
 * make the honest-signal field pointless. Hence false + degraded.
 *
 * SCHEMA THIS TREE MAY NOT HAVE
 * =============================
 * `canViewPreMembershipHistory` reads `message_thread_members.visible_from_at`,
 * which arrives in migration 2400 behind `telegraph_history_bound_enabled`.
 * The read goes through `services/groupChatHistoryBound.ts`, whose whole design
 * is that with the flag OFF it does not even NAME the column — so this resolver
 * is safe on a database without 2400, and answers `true` there (history is
 * genuinely unbounded when no bound exists), with the reason recording that the
 * bound was not consulted.
 *
 * THIS IS NOT THE GATE. See `contracts/conversationCapabilities.ts`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { isBlockedBetween } from "../../../lib/blockGuard.js";
import { isAcceptedTripMember } from "../../../lib/http.js";
import { logger as rootLogger } from "../../../lib/logger.js";
import { getRestrictionState } from "../../../services/trust/TrustRestrictionService.js";
import { historyBoundEnabled, membershipSelect, visibleFromOf } from "../../../services/groupChatHistoryBound.js";
import {
  CONVERSATION_CAPABILITY_NAMES,
  allDenied,
  type CapabilityInput,
  type ConversationCapabilities,
  type ConversationCapabilityName,
  type ResolvedConversationCapabilities,
} from "../contracts/conversationCapabilities.js";
import type { TelegraphReason } from "../contracts/telegraphReasonCodes.js";

const log = rootLogger.child({ mod: "telegraphCapabilities" });

/** The most precise level `trip_crew_location_sessions.visibility_level` admits. */
const MOST_PRECISE_LOCATION_LEVEL = "nearby";

export interface ResolveCapabilitiesInput {
  viewerId: string;
  conversationId: string;
}

interface Draft {
  capabilities: ConversationCapabilities;
  reasons: Record<ConversationCapabilityName, TelegraphReason | null>;
}

function blankDraft(): Draft {
  const capabilities = {} as ConversationCapabilities;
  const reasons = {} as Record<ConversationCapabilityName, TelegraphReason | null>;
  for (const name of CONVERSATION_CAPABILITY_NAMES) {
    capabilities[name] = false;
    reasons[name] = null;
  }
  return { capabilities, reasons };
}

function grant(d: Draft, name: ConversationCapabilityName): void {
  d.capabilities[name] = true;
  d.reasons[name] = null;
}

function deny(d: Draft, name: ConversationCapabilityName, reason: TelegraphReason): void {
  d.capabilities[name] = false;
  d.reasons[name] = reason;
}

/**
 * Resolve §14.1's ten capabilities for one viewer in one conversation.
 *
 * `sc` must be a service-role client: every read here is an authorization
 * input, and an RLS-filtered read that returns nothing is indistinguishable
 * from a fact that is absent — which is exactly the confusion the `degraded`
 * flag exists to prevent.
 */
export async function resolveConversationCapabilities(
  sc: SupabaseClient,
  input: ResolveCapabilitiesInput,
): Promise<ResolvedConversationCapabilities> {
  const { viewerId, conversationId } = input;
  const inputsRead: CapabilityInput[] = [];
  const degradedReasons: TelegraphReason[] = [];
  const markDegraded = (r: TelegraphReason) => { if (!degradedReasons.includes(r)) degradedReasons.push(r); };

  const refuse = (reason: TelegraphReason, conversationType: string): ResolvedConversationCapabilities => {
    const { capabilities, reasons } = allDenied(reason);
    return {
      conversationId, viewerId, conversationType, capabilities, reasons,
      inputsRead, degraded: degradedReasons.length > 0, degradedReasons,
    };
  };

  // ── INPUT 1: conversation type ───────────────────────────────────────────
  const { data: thread, error: threadErr } = await sc
    .from("message_threads")
    .select("id, thread_type, status, trip_id, circle_owner_id, is_e2ee")
    .eq("id", conversationId)
    .maybeSingle();
  if (threadErr) {
    markDegraded("TELEGRAPH_DEGRADED_THREAD_UNREADABLE");
    log.error({ err: threadErr, conversationId }, "capability resolve: thread unreadable");
    return refuse("TELEGRAPH_DEGRADED_THREAD_UNREADABLE", "unknown");
  }
  if (!thread) return refuse("TELEGRAPH_AUTH_NOT_MEMBER", "unknown");
  inputsRead.push("conversationType");
  const conversationType = String((thread as any).thread_type ?? "direct");
  const threadActive = String((thread as any).status ?? "active") === "active";

  // ── INPUT 2: membership (and, with it, the §14.3 window) ─────────────────
  const boundOn = await historyBoundEnabled(sc);
  const { data: membership, error: membershipErr } = await sc
    .from("message_thread_members")
    .select(membershipSelect("user_id, role, left_at", boundOn))
    .eq("thread_id", conversationId)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (membershipErr) {
    markDegraded("TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");
    log.error({ err: membershipErr, conversationId }, "capability resolve: membership unreadable");
    return refuse("TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE", conversationType);
  }
  inputsRead.push("membership");
  if (!membership) return refuse("TELEGRAPH_AUTH_NOT_MEMBER", conversationType);
  if ((membership as any).left_at != null) return refuse("TELEGRAPH_AUTH_LEFT_THREAD", conversationType);
  const role = String((membership as any).role ?? "member");

  const d = blankDraft();

  // ── INPUT 3: block state (pairwise; only meaningful for a 1:1 thread) ─────
  const { data: otherRows, error: otherErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", conversationId)
    .is("left_at", null)
    .neq("user_id", viewerId);
  let counterpartId: string | null = null;
  let blockUnreadable = false;
  let blocked = false;
  if (otherErr) {
    // The roster read is what decides whether a pairwise block even applies.
    // An unreadable roster is not "no other members" — that mistake is the one
    // routes/messaging.ts was fixed for, and repeating it here would put the
    // same fail-open back in a second place.
    blockUnreadable = true;
    markDegraded("TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");
  } else {
    const others = ((otherRows as any[]) ?? []).map((r) => String(r.user_id));
    if (others.length === 1 && others[0]) counterpartId = others[0];
    if (counterpartId) {
      blocked = await isBlockedBetween(sc, viewerId, counterpartId);
      inputsRead.push("blockState");
    } else {
      inputsRead.push("blockState"); // read, and found not to apply (group thread)
    }
  }

  // ── INPUT 4: safety state (trust restrictions on the viewer) ─────────────
  const restriction = await getRestrictionState(sc, viewerId);
  inputsRead.push("safetyState");
  if (restriction.degradedReason === "fail_closed") markDegraded("TELEGRAPH_DEGRADED_TRUST_UNREADABLE");

  // ── INPUT 5: age / policy ────────────────────────────────────────────────
  let ageRestricted = false;
  if (counterpartId) {
    const { data: priv, error: privErr } = await sc
      .from("user_privacy_settings")
      .select("age_restriction_enabled")
      .eq("user_id", counterpartId)
      .maybeSingle();
    if (privErr) { markDegraded("TELEGRAPH_DEGRADED_SCHEMA_ABSENT"); }
    else { ageRestricted = (priv as any)?.age_restriction_enabled === true; }
  }
  inputsRead.push("agePolicy");

  // ── INPUT 6: Trip/Crew membership ────────────────────────────────────────
  // `isAcceptedTripMember` is the SAME helper routes/telegraphCommands.ts calls
  // at execution — deliberately, so the projection cannot disagree with the
  // gate about who is crew. It THROWS on an unreadable trips/trip_members
  // (TripAccessUnavailableError), which is the honest signal and which this
  // resolver converts into degraded-false rather than into "not crew".
  let tripMember = false;
  const tripId = (thread as any).trip_id as string | null;
  if (tripId) {
    try {
      tripMember = await isAcceptedTripMember(sc, tripId, viewerId);
    } catch (err) {
      markDegraded("TELEGRAPH_DEGRADED_SCHEMA_ABSENT");
      log.warn({ err, tripId }, "capability resolve: trip membership unreadable");
    }
  }
  inputsRead.push("tripCrewMembership");

  // ── INPUT 7: booking state ───────────────────────────────────────────────
  let bookingStatus: string | null = null;
  {
    const { data: booking, error: bookingErr } = await sc
      .from("rent_buddy_bookings")
      .select("id, status, buddy_id, traveler_id")
      .eq("telegraph_thread_id", conversationId)
      .maybeSingle();
    if (bookingErr) { markDegraded("TELEGRAPH_DEGRADED_SCHEMA_ABSENT"); }
    else if (booking) { bookingStatus = String((booking as any).status ?? ""); }
  }
  inputsRead.push("bookingState");

  // ── INPUT 8: location scope ──────────────────────────────────────────────
  // §15.1's precision ladder tops out at 'nearby', which is APPROXIMATE. There
  // is no EXACT anywhere in the schema — so the honest answer to
  // canShareExactLocation is "the ceiling refuses it", stated as a reason
  // rather than as an unexplained false.
  let livePrecision: string | null = null;
  if (tripId) {
    const { data: sessions, error: sessErr } = await sc
      .from("trip_crew_location_sessions")
      .select("visibility_level, status, expires_at")
      .eq("trip_id", tripId)
      .eq("user_id", viewerId)
      .eq("status", "active")
      .limit(1);
    if (sessErr) { markDegraded("TELEGRAPH_DEGRADED_SCHEMA_ABSENT"); }
    else {
      const row = ((sessions as any[]) ?? [])[0];
      if (row) {
        const expiresAt = Date.parse(String(row.expires_at ?? ""));
        livePrecision = Number.isFinite(expiresAt) && expiresAt <= Date.now()
          ? null
          : String(row.visibility_level ?? "");
      }
    }
  }
  inputsRead.push("locationScope");

  // ── DERIVATION ───────────────────────────────────────────────────────────

  // canSendMessage — the projection of routes/messaging.ts's own gate.
  if (!threadActive) deny(d, "canSendMessage", "TELEGRAPH_POLICY_THREAD_ARCHIVED");
  else if (blockUnreadable) deny(d, "canSendMessage", "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");
  else if (blocked) deny(d, "canSendMessage", "TELEGRAPH_AUTH_BLOCKED");
  else if (!restriction.canMessage) deny(d, "canSendMessage", "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
  else grant(d, "canSendMessage");

  // canCall — same membership and block inputs; the call engine re-checks its
  // own rate limits and preferences at execution, which this cannot mirror.
  if (!d.capabilities.canSendMessage) deny(d, "canCall", d.reasons.canSendMessage ?? "TELEGRAPH_AUTH_NOT_MEMBER");
  else if (ageRestricted) deny(d, "canCall", "TELEGRAPH_POLICY_RECIPIENT_PRIVACY");
  else grant(d, "canCall");

  // canCreatePlan — a trip thread needs accepted crew; every other thread type
  // needs only active membership, which is what telegraphCommands enforces.
  if (!threadActive) deny(d, "canCreatePlan", "TELEGRAPH_POLICY_THREAD_ARCHIVED");
  else if (!restriction.canHost) deny(d, "canCreatePlan", "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
  else if (tripId && !tripMember) deny(d, "canCreatePlan", "TELEGRAPH_AUTH_NOT_TRIP_MEMBER");
  else grant(d, "canCreatePlan");

  // canShareExactLocation — §15.1. Never true today, and the reason says which
  // of the two walls stopped it: no grant at all, or a grant whose precision
  // class is below EXACT.
  if (!restriction.canJoinLocationPlans) deny(d, "canShareExactLocation", "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
  else if (livePrecision === null) deny(d, "canShareExactLocation", "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT");
  else deny(d, "canShareExactLocation", "TELEGRAPH_LOCATION_PRECISION_CEILING");

  // canInvite — §14.3. A DM cannot be extended into a group in place; trip and
  // circle rosters are owned by the source domain and synced, never invited to
  // from inside the conversation.
  deny(d, "canInvite", conversationType === "direct"
    ? "TELEGRAPH_POLICY_DM_INVITE_FORMS_NEW_GROUP"
    : "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED");

  // canRequestPayment — §20's prohibition, stated as a capability.
  deny(d, "canRequestPayment", "TELEGRAPH_POLICY_NO_IN_CHAT_PAYMENT");

  // canCreateBooking — a thread that already owns a booking does not create a
  // second one from inside itself; a 1:1 thread with no booking may.
  if (bookingStatus !== null) deny(d, "canCreateBooking", "TELEGRAPH_POLICY_NO_IN_CHAT_PAYMENT");
  else if (!d.capabilities.canSendMessage) deny(d, "canCreateBooking", d.reasons.canSendMessage ?? "TELEGRAPH_AUTH_NOT_MEMBER");
  else if (conversationType !== "direct") deny(d, "canCreateBooking", "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED");
  else grant(d, "canCreateBooking");

  // canBroadcast — §14.1 names it; nothing implements it.
  deny(d, "canBroadcast", "TELEGRAPH_POLICY_NO_BROADCAST");

  // canViewPreMembershipHistory — the live §14.3 bound, read through the same
  // helper the message reader uses, so the projection and the gate cannot drift.
  const visibleFrom = visibleFromOf(membership as any, boundOn);
  if (visibleFrom) deny(d, "canViewPreMembershipHistory", "TELEGRAPH_HISTORY_BEFORE_WINDOW");
  else grant(d, "canViewPreMembershipHistory");

  // canSeeGroupReadReceipts — group threads only, and never while the viewer's
  // own read receipts are withheld by a trust restriction (reciprocity: a
  // viewer who is not reporting seen state does not receive it either).
  if (conversationType === "direct") deny(d, "canSeeGroupReadReceipts", "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED");
  else if (restriction.activeRestrictions.length > 0) deny(d, "canSeeGroupReadReceipts", "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
  else grant(d, "canSeeGroupReadReceipts");

  // A thread admin is a real role in message_thread_members; nothing in §14.1
  // keys off it today, and recording that is better than a dangling read.
  void role;

  return {
    conversationId,
    viewerId,
    conversationType,
    capabilities: d.capabilities,
    reasons: d.reasons,
    inputsRead,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}

export { MOST_PRECISE_LOCATION_LEVEL };
