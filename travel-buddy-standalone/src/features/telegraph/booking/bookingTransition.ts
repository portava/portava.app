/**
 * census-telegraph T320 — "Buddy booking cancelled → booking-only actions disabled immediately".
 *
 * A Rent-a-Buddy booking owns its Telegraph thread, and every status transition writes a booking
 * card into that very thread (routes/rentABuddy.ts `emitBookingCard`, "cancelled" included); the
 * older Rent-a-Buddy milestones are system notices with a `rent_buddy_*` subtype. The thread screen
 * read the booking ONCE, on mount, so its booking-only controls — the call buttons, the booking
 * header's Safety and Add Time — outlived a cancellation until the screen was reopened. The newest
 * transition in the thread is the key those reads depend on: when the cancellation's card arrives,
 * the booking is read again and the controls follow it.
 */
export interface BookingTransitionMessage {
  id?: string | null;
  msgType?: string | null;
  subtype?: string | null;
}

/** The id of the newest booking transition in the thread (messages oldest-first), or null. */
export function latestBookingTransitionKey(messages: ReadonlyArray<BookingTransitionMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m.id !== 'string' || m.id.length === 0) continue;
    if (m.msgType === 'booking_card') return m.id;
    if (m.msgType === 'system' && typeof m.subtype === 'string' && m.subtype.startsWith('rent_buddy_')) return m.id;
  }
  return null;
}
