/**
 * calls/callPermissionEngine — THE canonical calling authorization (spec §6).
 *
 * canUserStartCall / canUserJoinCall are the only two ways anything in
 * Portava is allowed to open a media path between users. Routes must call
 * these; buttons being hidden client-side is never authorization.
 *
 * Ports-and-adapters: the engine is pure decision logic over a
 * CallContextGateway interface. The route layer implements the gateway with
 * real queries (message_threads, canMessage, blocks, RAB booking state, trip
 * crew membership, event eligibility, preferences) — so this file stays
 * fully unit-testable and there is exactly ONE decision matrix.
 */
import {
  ALLOW, deny, CALL_CONFIG,
  type CallContextType, type CallPermissionResult, type CallType,
} from './callTypes';

/**
 * Shared by both start paths: a real restriction and a degraded (could-not-
 * check) read must deny with different reasons, or a transient DB hiccup
 * gets shown to the caller as "you are restricted from calling."
 */
async function denyIfCallRestricted(
  gw: Pick<CallContextGateway, 'isCallRestricted'>,
  userId: string,
): Promise<CallPermissionResult | null> {
  const check = await gw.isCallRestricted(userId);
  if (!check.restricted) return null;
  return deny(check.degraded ? 'degraded_unavailable' : 'caller_restricted');
}

// ── Gateway (implemented by the route layer with real queries) ───────────────

export interface CallPreferences {
  /** 'people_i_message' | 'rab_contacts' | 'nobody' */
  whoCanCall: 'people_i_message' | 'rab_contacts' | 'nobody';
  allowRentABuddyCalls: boolean;
  allowVideoCalls: boolean;
}

export interface CallContextGateway {
  /** Thread exists → its participant user ids; null when not found. */
  getThreadParticipants(threadId: string): Promise<string[] | null>;
  /** Existing Telegraph permission: may A message B in this thread context? */
  canMessage(userA: string, userB: string, threadId: string): Promise<boolean>;
  /** True when either user blocks the other. */
  isBlockedEither(userA: string, userB: string): Promise<boolean>;
  /** Callee's calling preferences (defaults applied by the adapter). */
  getCallPreferences(userId: string): Promise<CallPreferences>;
  /**
   * Rent-a-Buddy: is this thread an eligible RAB conversation (inquiry /
   * request / accepted / active / permitted post-booking) between the two?
   */
  isEligibleRabConversation(threadId: string, userA: string, userB: string): Promise<boolean>;
  /** Trip crew: active membership (not removed/banned). */
  isActiveCrewMember(tripId: string, userId: string): Promise<boolean>;
  /**
   * Event room eligibility — MUST delegate to the canonical event
   * participation service (attendance, privacy, age, trust). Returns a deny
   * reason string when ineligible, null when eligible.
   */
  eventRoomIneligibility(eventId: string, userId: string):
    Promise<null | 'not_event_eligible' | 'age_ineligible' | 'trust_ineligible'>;
  /**
   * Event staff role from the canonical event tables: 'host' for the event's
   * host, 'cohost' for co_host/moderator rows, null otherwise. Drives the
   * host-only room start rule and the moderation matrix.
   */
  eventStaffRole(eventId: string, userId: string): Promise<'host' | 'cohost' | null>;
  /**
   * Platform moderation: is the user suspended/restricted from calling?
   * `degraded: true` means the underlying check could not be performed (a
   * failed-closed guess) rather than a real restriction — the engine must
   * deny with a different reason in that case, never `caller_restricted`.
   */
  isCallRestricted(userId: string): Promise<{ restricted: boolean; degraded?: boolean }>;
  /** Active session lookups for join/anti-abuse checks. */
  isSessionTerminated(callId: string): Promise<boolean>;
  wasRemovedFromCall(callId: string, userId: string): Promise<boolean>;
  /** Most recent decline of caller by callee in this thread (ms since epoch), null if none. */
  lastDeclineAt(callerId: string, calleeId: string, threadId: string): Promise<number | null>;
  /** Call starts by this user in the past hour (rate limiting). */
  startsInLastHour(userId: string): Promise<number>;
}

// ── Start (direct calls: telegraph_dm / rent_a_buddy) ────────────────────────

export interface StartDirectCallInput {
  callerId: string | null;
  calleeId: string;
  threadId: string;
  contextType: Extract<CallContextType, 'telegraph_dm' | 'rent_a_buddy'>;
  callType: Extract<CallType, 'voice' | 'video'>;
  nowMs: number;
}

export async function canUserStartCall(
  gw: CallContextGateway, input: StartDirectCallInput,
): Promise<CallPermissionResult> {
  const { callerId, calleeId, threadId, contextType, callType, nowMs } = input;

  // 1. Authenticated
  if (!callerId) return deny('unauthenticated');

  // 10. Platform restriction
  const restrictedDeny = await denyIfCallRestricted(gw, callerId);
  if (restrictedDeny) return restrictedDeny;

  // Rate limiting (spec §27) — before heavier checks
  if ((await gw.startsInLastHour(callerId)) >= CALL_CONFIG.MAX_STARTS_PER_HOUR) {
    return deny('rate_limited');
  }

  // 2–4. Thread exists; both parties belong to it
  const participants = await gw.getThreadParticipants(threadId);
  if (!participants) return deny('context_not_found');
  if (!participants.includes(callerId)) return deny('not_a_participant');
  if (!participants.includes(calleeId)) return deny('callee_not_participant');

  // 6. Blocks — checked early and absolutely
  if (await gw.isBlockedEither(callerId, calleeId)) return deny('blocked');

  // 5. Messaging permission is the floor for calling
  if (!(await gw.canMessage(callerId, calleeId, threadId))) {
    return deny('messaging_not_permitted');
  }

  // 9. Rent-a-Buddy context eligibility
  if (contextType === 'rent_a_buddy') {
    if (!(await gw.isEligibleRabConversation(threadId, callerId, calleeId))) {
      return deny('rab_context_ineligible');
    }
  }

  // 7. Callee preferences
  const prefs = await gw.getCallPreferences(calleeId);
  if (prefs.whoCanCall === 'nobody') return deny('callee_calls_disabled');
  if (contextType === 'rent_a_buddy') {
    if (!prefs.allowRentABuddyCalls) return deny('rab_calls_disabled');
    // 'rab_contacts' and 'people_i_message' both admit eligible RAB threads.
  } else if (prefs.whoCanCall === 'rab_contacts') {
    // Callee only accepts RAB calls; this is a plain DM call.
    return deny('callee_calls_disabled');
  }
  if (callType === 'video' && !prefs.allowVideoCalls) return deny('video_calls_disabled');

  // Redial harassment guard (spec §27): cooldown after a decline
  const declined = await gw.lastDeclineAt(callerId, calleeId, threadId);
  if (declined != null && nowMs - declined < CALL_CONFIG.REDIAL_COOLDOWN_MS) {
    return deny('redial_cooldown');
  }

  return ALLOW;
}

// ── Start (group rooms: trip_crew / event) ───────────────────────────────────

export interface StartGroupCallInput {
  userId: string | null;
  contextType: Extract<CallContextType, 'trip_crew' | 'event'>;
  /** tripId or eventId. */
  contextId: string;
  nowMs: number;
}

export async function canUserStartGroupCall(
  gw: CallContextGateway, input: StartGroupCallInput,
): Promise<CallPermissionResult> {
  if (!input.userId) return deny('unauthenticated');
  const groupRestrictedDeny = await denyIfCallRestricted(gw, input.userId);
  if (groupRestrictedDeny) return groupRestrictedDeny;
  if ((await gw.startsInLastHour(input.userId)) >= CALL_CONFIG.MAX_STARTS_PER_HOUR) {
    return deny('rate_limited');
  }
  const membership = await checkGroupMembership(gw, input.contextType, input.contextId, input.userId);
  if (!membership.allowed) return membership;
  // Event rooms are never opened by attendees: only the event's host or
  // co-hosts may start the room (spec Phase 5). Trip crew rooms stay open
  // to any active member.
  if (input.contextType === 'event') {
    const staff = await gw.eventStaffRole(input.contextId, input.userId);
    if (!staff) return deny('not_event_host');
  }
  return ALLOW;
}

// ── Moderate (event voice rooms) ─────────────────────────────────────────────

export interface ModerateCallInput {
  userId: string | null;
  callId: string;
  contextType: CallContextType;
  /** eventId for event rooms. */
  contextId: string;
  nowMs: number;
}

/**
 * THE moderation authorization — added additively beside canUserStartCall /
 * canUserJoinCall so routes keep exactly ONE decision matrix. Moderation
 * rights exist only inside event voice rooms, only for that event's own
 * host/co-hosts, and only while the room is alive.
 */
export async function canUserModerateCall(
  gw: CallContextGateway, input: ModerateCallInput,
): Promise<CallPermissionResult> {
  if (!input.userId) return deny('unauthenticated');
  if (await gw.isSessionTerminated(input.callId)) return deny('room_terminated');
  if (input.contextType !== 'event') return deny('not_room_moderator');
  // Full event eligibility still applies to moderators (bans, blocks, trust).
  const ineligible = await gw.eventRoomIneligibility(input.contextId, input.userId);
  if (ineligible) return deny(ineligible);
  const staff = await gw.eventStaffRole(input.contextId, input.userId);
  return staff ? ALLOW : deny('not_room_moderator');
}

// ── Join (any call/room) ─────────────────────────────────────────────────────

export interface JoinCallInput {
  userId: string | null;
  callId: string;
  contextType: CallContextType;
  contextId: string;
  threadId: string | null;
  /** For direct calls: the other party (block re-check on join). */
  otherPartyId?: string | null;
  nowMs: number;
}

export async function canUserJoinCall(
  gw: CallContextGateway, input: JoinCallInput,
): Promise<CallPermissionResult> {
  if (!input.userId) return deny('unauthenticated');

  // 9. Room state first — a terminated session admits no one, ever.
  if (await gw.isSessionTerminated(input.callId)) return deny('room_terminated');
  // 4. Removed participants cannot rejoin.
  if (await gw.wasRemovedFromCall(input.callId, input.userId)) return deny('removed_from_room');

  if (input.contextType === 'telegraph_dm' || input.contextType === 'rent_a_buddy') {
    if (!input.threadId) return deny('context_not_found');
    const participants = await gw.getThreadParticipants(input.threadId);
    if (!participants) return deny('context_not_found');
    if (!participants.includes(input.userId)) return deny('not_a_participant');
    // Blocks re-validated at join time (accept ≠ immune to a block landed mid-ring).
    if (input.otherPartyId && (await gw.isBlockedEither(input.userId, input.otherPartyId))) {
      return deny('blocked');
    }
    return ALLOW;
  }

  return checkGroupMembership(gw, input.contextType, input.contextId, input.userId);
}

// ── Shared group eligibility ─────────────────────────────────────────────────

async function checkGroupMembership(
  gw: CallContextGateway,
  contextType: Extract<CallContextType, 'trip_crew' | 'event'>,
  contextId: string,
  userId: string,
): Promise<CallPermissionResult> {
  if (contextType === 'trip_crew') {
    return (await gw.isActiveCrewMember(contextId, userId)) ? ALLOW : deny('not_crew_member');
  }
  // event — canonical event participation service decides (spec §5)
  const ineligible = await gw.eventRoomIneligibility(contextId, userId);
  return ineligible ? deny(ineligible) : ALLOW;
}
