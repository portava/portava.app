/**
 * Pure mapper — event waitlist UI state.
 *
 * Drives the action bar in the event detail screen so UI rendering and
 * business rules live in a testable function, not in JSX conditionals.
 */

export type WaitlistUiState =
  | 'not_on_waitlist'   // user is not on the waitlist; button "Join waitlist" shown
  | 'on_waitlist'       // user is queued; no offer yet ("You're #N in queue")
  | 'offer_pending'     // user has an active time-limited offer to accept
  | 'offer_expired'     // the offer window passed; user is still on waitlist (position kept)
  | 'promoted'          // user accepted the offer and is now going
  | 'event_closed';     // event is completed / cancelled / archived — no actions available

export interface WaitlistStateParams {
  myWaitlistPosition: number | null;
  myWaitlistOfferExpiresAt: string | null;
  eventState: string;
  myRsvp: string | null;
}

/**
 * Map raw event + attendee state to a single WaitlistUiState enum value.
 * The caller must pass `new Date()` or a fixed clock value for testability.
 */
export function getWaitlistUiState(
  params: WaitlistStateParams,
  now: Date = new Date(),
): WaitlistUiState {
  const { myWaitlistPosition, myWaitlistOfferExpiresAt, eventState, myRsvp } = params;

  if (['completed', 'cancelled', 'archived'].includes(eventState)) {
    return 'event_closed';
  }

  if (myRsvp === 'going') {
    return 'promoted';
  }

  if (myWaitlistPosition === null) {
    return 'not_on_waitlist';
  }

  if (!myWaitlistOfferExpiresAt) {
    return 'on_waitlist';
  }

  const offerExpiry = new Date(myWaitlistOfferExpiresAt);
  return offerExpiry > now ? 'offer_pending' : 'offer_expired';
}
