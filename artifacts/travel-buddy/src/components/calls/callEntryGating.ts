/**
 * calls/callEntryGating — client-side call entry-point gating (Phase 3).
 *
 * Decides where the voice/video call buttons appear. This is UX only —
 * the server's permission engine remains the authorization for every call
 * attempt. Keep this in lockstep with the server's RAB eligibility rule
 * (api-server: lib/calls/callGatewayAdapter.ts).
 */

/**
 * Booking statuses whose Telegraph conversation shows call buttons.
 * Mirrors the server: a RAB thread exists from `confirmed` onward and stays
 * live through the active and dispute states. `completed` is intentionally
 * absent — post-completion calls are only allowed server-side when both
 * parties opted to stay connected, and the client cannot see those flags,
 * so it stays conservative and hides the buttons.
 */
export const RAB_CALL_ELIGIBLE_STATUSES: readonly string[] = [
  'confirmed',
  'scheduled',
  'in_progress',
  'completed_pending_traveler_confirmation',
  'disputed',
];

/** The contextType the server expects for a call started from this thread. */
export function threadCallContextType(
  threadType: string | undefined,
): 'telegraph_dm' | 'rent_a_buddy' {
  return threadType === 'rent_buddy_booking' ? 'rent_a_buddy' : 'telegraph_dm';
}

/**
 * Should the thread header (and Call back affordances) show call buttons?
 * - Plain DMs: yes, when we know the other party and no message request is
 *   still pending.
 * - RAB booking threads: additionally requires a call-eligible booking
 *   status. While the status is still loading (null/undefined) the buttons
 *   stay hidden — never flash a call button that a tap would deny.
 * - Group threads (trip/circle): never (1:1 calling only).
 */
export function canShowThreadCallButtons(opts: {
  threadType: string | undefined;
  otherUserId: string | null | undefined;
  isWaitingForReply: boolean;
  rabBookingStatus?: string | null;
}): boolean {
  const { threadType, otherUserId, isWaitingForReply, rabBookingStatus } = opts;
  if (!otherUserId || isWaitingForReply) return false;
  if (threadType === 'direct') return true;
  if (threadType === 'rent_buddy_booking') {
    return rabBookingStatus != null && RAB_CALL_ELIGIBLE_STATUSES.includes(rabBookingStatus);
  }
  return false;
}
