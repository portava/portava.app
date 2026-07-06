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

  const joinable     = state === 'open' || state === 'waitlist';
  const cancellable  = isActive(state);
  const waitlistable = state === 'waitlist' || state === 'full';

  return {
    canRsvp:         joinable,
    canLeave:        cancellable,
    canJoinWaitlist: waitlistable,
  };
}
