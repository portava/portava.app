/**
 * Rent a Buddy — which lifecycle controls a viewer is offered, per status.
 *
 * Testing mode (lane tm-rab, WP-01 / PLAT-F45): a booking could never be
 * started or completed from the app, because nothing called startBooking,
 * completeBooking or travelerConfirmComplete. The booking screen and the
 * buddy's sessions list now offer those controls, and this module decides
 * WHICH — mirroring the server's own guards, so the app never offers a button
 * the server would answer with 409 `invalid_transition`:
 *
 *   start               buddy, from scheduled / confirmed            (POST /start)
 *   complete            either party, from in_progress               (POST /complete:
 *                       the buddy's completion opens the traveller's confirmation
 *                       window; the traveller's completes directly)
 *   confirm completion  traveller, from completed_pending_traveler_confirmation
 *                                                                     (POST /traveler-confirm)
 *   emergency phrase    traveller only, while in_progress            (POST /safety/emergency-phrase)
 *   check-in            either party, from acceptance through the session
 *   suggest / respond   before the session starts                    (POST /suggest, /respond-change-request)
 *
 * The server stays the authority: every control still posts to a route that
 * re-checks party and status. Kept import-free so it runs under node:test.
 */

export type BookingParty = 'traveler' | 'buddy';

/** Statuses a booking can be in before it starts (server: UPCOMING_STATUSES). */
const BEFORE_START = new Set(['pending', 'requested', 'confirmed', 'scheduled']);
/** Accepted and not yet started (server: ACCEPTED_STATUSES). */
const ACCEPTED = new Set(['confirmed', 'scheduled']);

const LABELS: Record<string, string> = {
  pending: 'Requested',
  requested: 'Requested',
  confirmed: 'Confirmed',
  scheduled: 'Confirmed',
  in_progress: 'Active',
  completed_pending_traveler_confirmation: 'Awaiting confirmation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  cancelled_by_traveler: 'Cancelled by traveller',
  cancelled_by_buddy: 'Cancelled by buddy',
  declined: 'Declined',
  disputed: 'Disputed',
  expired: 'Expired',
  no_show_pending: 'No-show review',
};

/** A human label for any booking status; an unknown one is de-snake-cased, never shown raw. */
export function bookingStatusLabel(status: string): string {
  const known = LABELS[status];
  if (known) return known;
  const words = status.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which side of the booking the viewer is on. The server has already refused
 * anyone who is neither (GET /bookings/:id is party-only), so a signed-in
 * viewer who is not the traveller is the buddy.
 */
export function bookingParty(
  booking: { travelerId: string },
  viewerUserId: string | null | undefined,
): BookingParty | null {
  if (!viewerUserId) return null;
  return booking.travelerId === viewerUserId ? 'traveler' : 'buddy';
}

export interface LifecycleActions {
  start: boolean;
  complete: boolean;
  confirmCompletion: boolean;
  checkIn: boolean;
  emergencyPhrase: boolean;
  suggestChange: boolean;
  respondToChange: boolean;
}

export function lifecycleActions(status: string, party: BookingParty | null): LifecycleActions {
  if (!party) {
    return {
      start: false, complete: false, confirmCompletion: false, checkIn: false,
      emergencyPhrase: false, suggestChange: false, respondToChange: false,
    };
  }
  const isBuddy = party === 'buddy';
  const isTraveler = party === 'traveler';
  return {
    start: isBuddy && ACCEPTED.has(status),
    complete: status === 'in_progress',
    confirmCompletion: isTraveler && status === 'completed_pending_traveler_confirmation',
    checkIn: ACCEPTED.has(status) || status === 'in_progress',
    emergencyPhrase: isTraveler && status === 'in_progress',
    suggestChange: BEFORE_START.has(status),
    respondToChange: BEFORE_START.has(status),
  };
}

// ── Suggested changes ─────────────────────────────────────────────────────────

export interface ChangeRequestLike {
  changeField: string;
  currentValue: Record<string, unknown>;
  proposedValue: Record<string, unknown>;
}

const FIELD_LABEL: Record<string, { label: string; key: string; suffix?: string }> = {
  date: { label: 'Date', key: 'date' },
  start_time: { label: 'Start time', key: 'start_time' },
  duration_h: { label: 'Duration', key: 'duration_h', suffix: 'h' },
  service: { label: 'Service', key: 'service_id' },
  price_usd: { label: 'Price', key: 'price_usd' },
};

function fmt(v: unknown, suffix?: string): string {
  if (v === undefined || v === null || v === '') return '(not set)';
  return `${String(v)}${suffix ?? ''}`;
}

/** "Start time: 10:00 → 14:00" — a suggestion in plain words. */
export function describeChangeRequest(cr: ChangeRequestLike): string {
  const f = FIELD_LABEL[cr.changeField];
  if (!f) {
    return `${bookingStatusLabel(cr.changeField)}: ${JSON.stringify(cr.currentValue ?? {})} → ${JSON.stringify(cr.proposedValue ?? {})}`;
  }
  return `${f.label}: ${fmt(cr.currentValue?.[f.key], f.suffix)} → ${fmt(cr.proposedValue?.[f.key], f.suffix)}`;
}
