import type { AcceptInviteResult } from '../services/trips';

/**
 * Possible actions the invite-accept handler can take after receiving a result
 * from the API.  Modelling these as a discriminated union lets the component
 * branch with a plain switch and lets unit tests verify each branch without
 * touching React Native, the router, or Alert.
 */
export type AcceptAction =
  | { kind: 'navigate'; tripId: string }
  | { kind: 'reload' }
  | { kind: 'set_gone'; message: string }
  | { kind: 'alert'; title: string; message: string };

/**
 * Maps an AcceptInviteResult to the UI action the invite screen should take.
 *
 * @param result       - Value returned by acceptInviteByToken().
 * @param previewTripId - The tripId from the loaded invite preview; used when
 *                        the server returns alreadyMember (no new tripId).
 */
export function mapAcceptResultToAction(
  result: AcceptInviteResult,
  previewTripId: string,
): AcceptAction {
  if (result.tripId) {
    return { kind: 'navigate', tripId: result.tripId };
  }
  if (result.alreadyMember) {
    return { kind: 'navigate', tripId: previewTripId };
  }
  if (result.error === 'gone' && result.reason === 'trip_full') {
    // Trip filled up between preview and accept — re-fetch the preview so the
    // screen transitions to the 'full' state instead of showing a generic error.
    return { kind: 'reload' };
  }
  if (result.error === 'gone') {
    return { kind: 'set_gone', message: 'This trip is no longer active.' };
  }
  const message =
    result.error === 'not_authenticated'
      ? 'Please sign in and try again.'
      : 'The invite link may have expired. Please ask the trip owner for a new one.';
  return { kind: 'alert', title: 'Could not join', message };
}
