/**
 * Pure helpers — event role action sets.
 *
 * Given a viewer's role in an event and the event lifecycle state, returns
 * which host/moderator and attendee actions are permitted.  Used to drive
 * HostDashboardPanel and to assert that banned users are fully locked out.
 */

export type EventRole = 'host' | 'co_host' | 'moderator' | 'banned' | null;

export type EventLifecycleState =
  | 'draft' | 'open' | 'full' | 'waitlist' | 'started'
  | 'completed' | 'cancelled' | 'archived';

export interface HostActionSet {
  canBanUser: boolean;
  canRemoveAttendee: boolean;
  canPromoteToCoHost: boolean;
  canCloseRsvps: boolean;
  canMarkComplete: boolean;
  canCancel: boolean;
}

export interface AttendeeActionSet {
  canRsvp: boolean;
  canLeave: boolean;
  canJoinWaitlist: boolean;
}

const ACTIVE_STATES: EventLifecycleState[] = ['open', 'full', 'waitlist', 'started'];

function isActive(state: EventLifecycleState): boolean {
  return ACTIVE_STATES.includes(state);
}

/**
 * Returns the state an event should DISPLAY as, correcting for events whose
 * date has passed while the stored `state` is still an active one (the
 * server never runs a background sweep to flip `open`/`full`/`waitlist`/
 * `started` rows to `completed` once `endsAt`/`startsAt` passes — see
 * events.ts CRUD, which only transitions state on explicit host action).
 * Terminal states (completed/cancelled/archived/draft) pass through untouched.
 *
 * Auto-promotion rules (evaluated in order):
 *  1. If `endsAt` has passed → `completed`.
 *  2. If `startsAt` has passed (and the event has not ended) → `started`
 *     ("Happening now"), regardless of whether `endsAt` is set.
 *  3. Otherwise → stored state unchanged.
 */
export function effectiveEventState(
  state: EventLifecycleState,
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  now: number = Date.now(),
): EventLifecycleState {
  if (!isActive(state)) return state;
  // Rule 1 — completed when endsAt has passed.
  if (endsAt) {
    const endMs = new Date(endsAt).getTime();
    if (!Number.isNaN(endMs) && endMs <= now) return 'completed';
  }
  // Rule 2 — in-progress when startsAt has passed (endsAt absent or in the future).
  if (startsAt) {
    const startMs = new Date(startsAt).getTime();
    if (!Number.isNaN(startMs) && startMs <= now) return 'started';
  }
  return state;
}

/**
 * Returns which host/mod management actions are available.
 * Returns all-false when the role is null, 'banned', or the event is closed.
 */
export function getHostActionSet(
  role: EventRole,
  state: EventLifecycleState,
): HostActionSet {
  const active = isActive(state);
  const isManager = role === 'host' || role === 'co_host';
  const isStaff   = isManager || role === 'moderator';

  return {
    canBanUser:         isStaff   && active,
    canRemoveAttendee:  isStaff   && active,
    canPromoteToCoHost: role === 'host' && active,
    canCloseRsvps:      isManager && active,
    canMarkComplete:    role === 'host' && active,
    canCancel:          role === 'host' && active,
  };
}

/**
 * Returns which attendee actions are available.
 * Banned users receive all-false regardless of event state.
 */
export function getAttendeeActionSet(
  role: EventRole,
  state: EventLifecycleState,
): AttendeeActionSet {
  if (role === 'banned') {
    return { canRsvp: false, canLeave: false, canJoinWaitlist: false };
  }

  // RSVP is allowed during open, waitlist, and started states.
  // 'started' is included so late arrivals can still RSVP while the event is live.
  const joinable     = state === 'open' || state === 'waitlist' || state === 'started';
  const cancellable  = isActive(state);
  const waitlistable = state === 'waitlist' || state === 'full';

  return {
    canRsvp:         joinable,
    canLeave:        cancellable,
    canJoinWaitlist: waitlistable,
  };
}
