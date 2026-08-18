/**
 * calls/callTypes — shared types + configuration for the Portava calling
 * system (ONE canonical call service; Telegraph / Rent-a-Buddy / Trip Crew /
 * Event rooms are contexts that consume it — spec §35).
 */

export type CallType = 'voice' | 'video' | 'group_voice';

export type CallContextType = 'telegraph_dm' | 'rent_a_buddy' | 'trip_crew' | 'event';

export type CallStatus =
  | 'ringing'   // created, callee(s) being alerted
  | 'active'    // at least one remote participant connected
  | 'ended'     // completed normally (or force-ended)
  | 'missed'    // ring window expired with no answer
  | 'declined'  // callee declined
  | 'canceled'  // caller hung up before answer
  | 'failed';   // infrastructure failure

export type ParticipantRole =
  | 'caller' | 'callee'                     // direct calls
  | 'host' | 'cohost' | 'speaker' | 'listener' | 'participant'; // group rooms

export type ParticipantStatus =
  | 'invited' | 'ringing' | 'joined' | 'declined' | 'missed' | 'left' | 'removed';

export interface CallSession {
  id: string;
  callType: CallType;
  contextType: CallContextType;
  /** Booking id / trip id / event id — the context anchor. */
  contextId: string;
  /** Telegraph thread the call belongs to (null for event rooms without one). */
  threadId: string | null;
  startedBy: string;
  status: CallStatus;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
}

export interface CallParticipant {
  callId: string;
  userId: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  invitedAt: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  /** Event voice rooms: when the listener raised a hand (null = not raised). */
  handRaisedAt?: string | null;
}

/** Moderation actions recorded in the audit log (event voice rooms). */
export type CallModerationAction =
  | 'promote_speaker' | 'demote_speaker' | 'mute' | 'remove' | 'end_room';

// ── Central configuration (spec addendum B: no scattered magic numbers) ──────

export const CALL_CONFIG = {
  /** Unanswered direct calls become `missed` after this window. */
  RING_TIMEOUT_MS: 45_000,
  /** Hard cost/resource cap — rooms are force-ended at this duration. */
  MAX_CALL_DURATION_MS: 4 * 60 * 60 * 1_000,
  /** Warn connected participants this long before the max-duration cut. */
  MAX_DURATION_WARNING_MS: 5 * 60 * 1_000,
  /** LiveKit access tokens are minted with this TTL. */
  TOKEN_TTL_SECONDS: 15 * 60,
  /** Server-side redial guard: min gap after a decline from the same caller. */
  REDIAL_COOLDOWN_MS: 60_000,
  /** Max call starts per caller per hour (rate-limit backstop). */
  MAX_STARTS_PER_HOUR: 30,
  /** Cadence of the periodic open-session sweep (ring expiry / 4h cap). */
  SWEEP_INTERVAL_MS: 30_000,
  /**
   * Ghost healing: an `active` session whose LiveKit room no longer exists is
   * force-ended once it has been active at least this long. The grace period
   * covers room-creation latency (LiveKit creates rooms lazily on first join),
   * so a just-accepted call is never reaped before its room materializes.
   */
  GHOST_ACTIVE_GRACE_MS: 2 * 60_000,
  /** Delay before the first sweep after server boot. */
  SWEEP_STARTUP_DELAY_MS: 20_000,
} as const;

/** Reasons the permission engine can deny with — stable codes for clients/tests. */
export type CallDenyReason =
  | 'unauthenticated'
  | 'context_not_found'
  | 'not_a_participant'
  | 'callee_not_participant'
  | 'messaging_not_permitted'
  | 'blocked'
  | 'callee_calls_disabled'
  | 'video_calls_disabled'
  | 'rab_context_ineligible'
  | 'rab_calls_disabled'
  | 'not_crew_member'
  | 'not_event_eligible'
  | 'age_ineligible'
  | 'trust_ineligible'
  | 'caller_restricted'
  | 'degraded_unavailable'
  | 'room_terminated'
  | 'removed_from_room'
  | 'not_event_host'
  | 'not_room_moderator'
  | 'redial_cooldown'
  | 'rate_limited';

export type CallPermissionResult =
  | { allowed: true }
  | { allowed: false; reason: CallDenyReason };

export const deny = (reason: CallDenyReason): CallPermissionResult => ({ allowed: false, reason });
export const ALLOW: CallPermissionResult = { allowed: true };
