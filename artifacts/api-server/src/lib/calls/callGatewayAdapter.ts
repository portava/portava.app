/**
 * calls/callGatewayAdapter — real-data implementation of CallContextGateway.
 *
 * Binds the permission engine's port to the live systems per the Phase-0
 * audit binding table:
 *  - thread participants     → message_thread_members (left_at IS NULL)
 *  - messaging floor         → the existing canMessage() verdict (allowed only)
 *  - blocks                  → blocks table, both directions
 *  - calling preferences     → call_preferences PK lookup, defaults for absent rows
 *  - RAB eligibility         → rent_buddy_bookings matched by telegraph_thread_id
 *  - trip crew membership    → requireTripMember (accepted members only)
 *  - event room eligibility  → the canonical checkEventEligibility() + attendance
 *  - moderation restriction  → getRestrictionState().canMessage
 *  - session/removal/decline/rate lookups → the call tables
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { canMessage as canMessageVerdict } from "../messagingPermissions";
import { getRestrictionState } from "../../services/trust/TrustRestrictionService";
import { requireTripMember } from "../http";
import { checkEventEligibility } from "../../routes/events";
import { isTerminal } from "./callStateMachine";
import type { CallStatus } from "./callTypes";
import { CALL_CONFIG } from "./callTypes";
import type { CallContextGateway, CallPreferences } from "./callPermissionEngine";

export const DEFAULT_CALL_PREFERENCES: CallPreferences & { incomingCallNotifications: boolean } = {
  whoCanCall: "people_i_message",
  allowRentABuddyCalls: true,
  allowVideoCalls: true,
  incomingCallNotifications: true,
};

/**
 * Booking states in which a RAB conversation is unconditionally call-eligible.
 * Mirrors the real thread lifecycle (routes/rentABuddy.ts): a Telegraph thread
 * only exists from `confirmed` onward, remains live through `scheduled`,
 * `in_progress`, `completed_pending_traveler_confirmation`, and stays open
 * for `disputed` bookings (messaging remains permitted during a dispute).
 * Note: there is no pre-confirmation ("inquiry"/"requested") RAB conversation
 * in this codebase — pending bookings have no thread, so calls (like
 * messages) begin at confirmation.
 */
export const RAB_CALL_ELIGIBLE_STATUSES = [
  "confirmed",
  "scheduled",
  "in_progress",
  "completed_pending_traveler_confirmation",
  "disputed",
] as const;

/**
 * POLICY — mid-call booking cancellation ("ride it out"):
 * RAB call eligibility is enforced only at call START (and re-checked on
 * JOIN for blocks/termination). If a booking is cancelled or disputed while
 * a call is already active, the live call is deliberately NOT terminated —
 * it rides out until someone hangs up (or the reconciler's ring-timeout /
 * 4h-cap sweeps end it). Only the NEXT start attempt is denied, with
 * `rab_context_ineligible`. This mirrors messaging: the cancel handler
 * itself posts a system message into the still-open thread, and disputed
 * bookings intentionally keep both messaging and calling available.
 * (Also note: the cancel route only accepts pending/confirmed/scheduled
 * bookings, so a cancellation can only race a pre-meetup coordination call
 * — exactly the call where the parties may need to discuss the change.)
 * If this ever changes to "end on cancel", the booking cancel handler must
 * trigger a CAS transition via the call reconciler for sessions anchored to
 * the booking's telegraph thread.
 *
 * Full RAB call-eligibility rule for one booking row.
 * Post-booking: a `completed` booking stays callable ONLY while both parties
 * opted to stay connected — otherwise the thread was archived at completion
 * and calls end with messaging.
 */
export function isRabBookingCallEligible(b: {
  status: string;
  stay_connected_traveler?: boolean | null;
  stay_connected_buddy?: boolean | null;
}): boolean {
  if ((RAB_CALL_ELIGIBLE_STATUSES as readonly string[]).includes(b.status)) return true;
  return b.status === "completed" && !!b.stay_connected_traveler && !!b.stay_connected_buddy;
}

export async function getFullCallPreferences(
  sc: SupabaseClient,
  userId: string,
): Promise<CallPreferences & { incomingCallNotifications: boolean }> {
  try {
    const { data, error } = await sc
      .from("call_preferences")
      .select("who_can_call, allow_rent_a_buddy_calls, allow_video_calls, incoming_call_notifications")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error; // caught below → fail closed
    if (!data) return { ...DEFAULT_CALL_PREFERENCES }; // absent row = new user, use defaults
    const r = data as any;
    return {
      whoCanCall: r.who_can_call ?? "people_i_message",
      allowRentABuddyCalls: r.allow_rent_a_buddy_calls ?? true,
      allowVideoCalls: r.allow_video_calls ?? true,
      incomingCallNotifications: r.incoming_call_notifications ?? true,
    };
  } catch (err) {
    // Fail closed: return a deny-all preferences struct so a DB outage never
    // silently grants video calls or RAB calls that the user may have disabled.
    console.warn("[callGateway] getFullCallPreferences failed — failing closed", err);
    return {
      whoCanCall: "nobody" as const,
      allowRentABuddyCalls: false,
      allowVideoCalls: false,
      incomingCallNotifications: false,
    };
  }
}

export function makeCallGateway(sc: SupabaseClient): CallContextGateway {
  return {
    async getThreadParticipants(threadId) {
      const { data, error } = await sc
        .from("message_thread_members")
        .select("user_id")
        .eq("thread_id", threadId)
        .is("left_at", null);
      if (error || !data || data.length === 0) return null;
      return (data as any[]).map((r) => r.user_id as string);
    },

    async canMessage(userA, userB, _threadId) {
      // The existing Telegraph permission is the floor. Only a full allow
      // permits calling — `requires_request` does NOT (audit M2).
      try {
        const verdict = await canMessageVerdict(sc, userA, userB);
        return verdict.allowed === true;
      } catch {
        return false; // fail closed
      }
    },

    async isBlockedEither(userA, userB) {
      try {
        const { data, error } = await sc
          .from("blocks")
          .select("blocker_id")
          .or(
            `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`,
          )
          .limit(1);
        if (error) return true; // fail closed
        return ((data as any[]) ?? []).length > 0;
      } catch {
        return true; // fail closed
      }
    },

    async getCallPreferences(userId) {
      const full = await getFullCallPreferences(sc, userId);
      return {
        whoCanCall: full.whoCanCall,
        allowRentABuddyCalls: full.allowRentABuddyCalls,
        allowVideoCalls: full.allowVideoCalls,
      };
    },

    async isEligibleRabConversation(threadId, userA, userB) {
      // rent_buddy_bookings.buddy_id is the buddy PROFILE id — resolve the
      // buddy's user id via rent_buddy_profiles (audit gotcha).
      const { data: rows, error } = await sc
        .from("rent_buddy_bookings")
        .select("traveler_id, buddy_id, status, stay_connected_traveler, stay_connected_buddy")
        .eq("telegraph_thread_id", threadId);
      if (error || !rows || rows.length === 0) return false;
      const bookings = (rows as any[]).filter((b) => isRabBookingCallEligible(b));
      if (bookings.length === 0) return false;

      const buddyProfileIds = [...new Set((bookings as any[]).map((b) => b.buddy_id).filter(Boolean))];
      const buddyUserByProfile = new Map<string, string>();
      if (buddyProfileIds.length > 0) {
        const { data: profiles } = await sc
          .from("rent_buddy_profiles")
          .select("id, user_id")
          .in("id", buddyProfileIds);
        for (const p of (profiles as any[]) ?? []) buddyUserByProfile.set(p.id, p.user_id);
      }

      const pair = new Set([userA, userB]);
      return (bookings as any[]).some((b) => {
        const buddyUserId = buddyUserByProfile.get(b.buddy_id);
        return buddyUserId != null && pair.has(b.traveler_id) && pair.has(buddyUserId);
      });
    },

    async isActiveCrewMember(tripId, userId) {
      try {
        const member = await requireTripMember(sc, tripId, userId, { status: "accepted" });
        return member != null;
      } catch (err) {
        // Fail closed: a DB outage must never silently grant crew membership.
        console.warn("[callGateway] isActiveCrewMember failed — failing closed", err);
        return false;
      }
    },

    async eventRoomIneligibility(eventId, userId) {
      try {
        const { data: ev } = await sc.from("events").select("*").eq("id", eventId).maybeSingle();
        if (!ev) return "not_event_eligible";

        // Delegate to the canonical event participation gates (block/ban/
        // verified/trust/age). Map the failure onto the engine's stable reasons.
        const elig = await checkEventEligibility(sc, ev as any, userId);
        if (!elig.ok) {
          const m = elig.message.toLowerCase();
          if (m.includes("trust score")) return "trust_ineligible";
          if (m.includes("age") || m.includes("at least") || m.includes("up to")) return "age_ineligible";
          return "not_event_eligible";
        }

        // Attendance: host and staff always eligible; everyone else must have
        // an RSVP (going/maybe) on the event.
        if (userId === (ev as any).host_id) return null;
        const { data: staff } = await sc
          .from("event_roles")
          .select("role")
          .eq("event_id", eventId)
          .eq("user_id", userId)
          .in("role", ["co_host", "moderator"])
          .maybeSingle();
        if (staff) return null;
        const { data: rsvp } = await sc
          .from("event_rsvps")
          .select("status")
          .eq("event_id", eventId)
          .eq("user_id", userId)
          .maybeSingle();
        const s = (rsvp as any)?.status;
        return s === "going" || s === "maybe" ? null : "not_event_eligible";
      } catch (err) {
        // Fail closed: a DB outage must never silently grant event room access.
        console.warn("[callGateway] eventRoomIneligibility failed — failing closed", err);
        return "not_event_eligible";
      }
    },

    async eventStaffRole(eventId, userId) {
      try {
        const { data: ev } = await sc
          .from("events")
          .select("host_id")
          .eq("id", eventId)
          .maybeSingle();
        if (!ev) return null;
        if ((ev as any).host_id === userId) return "host";
        const { data: staff } = await sc
          .from("event_roles")
          .select("role")
          .eq("event_id", eventId)
          .eq("user_id", userId)
          .in("role", ["co_host", "moderator"])
          .maybeSingle();
        return staff ? "cohost" : null;
      } catch {
        return null; // fail closed — no staff powers on error
      }
    },

    async isCallRestricted(userId) {
      const state = await getRestrictionState(sc, userId);
      // audit M3: messaging restriction implies calling restriction. A
      // fail-closed degraded read also makes canMessage false — carry that
      // forward so the engine denies with 'degraded_unavailable', not
      // 'caller_restricted'. A fail-open degraded read leaves canMessage
      // true, so it never reaches here restricted at all.
      return {
        restricted: !state.canMessage,
        degraded: state.degradedReason === "fail_closed",
      };
    },

    async isSessionTerminated(callId) {
      const { data, error } = await sc
        .from("call_sessions")
        .select("status")
        .eq("id", callId)
        .maybeSingle();
      if (error || !data) return true; // unknown session admits no one
      return isTerminal((data as any).status as CallStatus);
    },

    async wasRemovedFromCall(callId, userId) {
      try {
        const { data, error } = await sc
          .from("call_participants")
          .select("status")
          .eq("call_id", callId)
          .eq("user_id", userId)
          .maybeSingle();
        if (error) {
          // Fail closed: treat as removed so a DB outage never lets a kicked
          // participant back into a room.
          console.warn("[callGateway] wasRemovedFromCall query failed — failing closed", error);
          return true;
        }
        return (data as any)?.status === "removed";
      } catch (err) {
        console.warn("[callGateway] wasRemovedFromCall threw — failing closed", err);
        return true;
      }
    },

    async lastDeclineAt(callerId, _calleeId, threadId) {
      try {
        const { data, error } = await sc
          .from("call_sessions")
          .select("ended_at, started_at")
          .eq("thread_id", threadId)
          .eq("started_by", callerId)
          .eq("status", "declined")
          .order("started_at", { ascending: false })
          .limit(1);
        if (error) {
          // Fail closed: treat as if a decline just happened so the caller
          // must wait out the full cooldown — a DB outage must not lift it.
          console.warn("[callGateway] lastDeclineAt query failed — failing closed", error);
          return Date.now();
        }
        const row = ((data as any[]) ?? [])[0];
        if (!row) return null;
        const ms = new Date(row.ended_at ?? row.started_at).getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch (err) {
        console.warn("[callGateway] lastDeclineAt threw — failing closed", err);
        return Date.now();
      }
    },

    async startsInLastHour(userId) {
      const sinceIso = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
      const { count, error } = await sc
        .from("call_sessions")
        .select("id", { count: "exact", head: true })
        .eq("started_by", userId)
        .gte("started_at", sinceIso);
      if (error) {
        // Fail closed: returning the ceiling denies new starts during a DB
        // outage rather than lifting the spam guard entirely.
        console.error("[callGateway] startsInLastHour count query failed — failing closed", error);
        return CALL_CONFIG.MAX_STARTS_PER_HOUR;
      }
      return count ?? 0;
    },
  };
}
