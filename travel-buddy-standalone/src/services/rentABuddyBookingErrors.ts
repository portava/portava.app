/**
 * Rent a Buddy — booking refusal classification and human copy.
 *
 * The service layer's apiFetch surfaces the server's error CODE and drops its
 * human-readable `message`. That is fine for genuine failures, but Rent a Buddy
 * is deliberately CLOSED for launch: identity verification and payments are
 * both stubbed, `rent_buddy_allow_bookings_without_kyc` stays false, and every
 * booking-creating endpoint answers 503 `verification_unavailable`
 * (api-server/src/lib/rentBuddyKycGate.ts). Without the mapping below, a
 * traveller who has just filled in the whole checkout form is shown an alert
 * reading "verification_unavailable" — a raw enum, framed as a failure they
 * caused.
 *
 * These codes are a STATE of the feature, not a rejection of the request.
 *
 * A THIRD class was added 2026-09-16 (census-trust TV-2a) and the two are not
 * interchangeable: `verification_required` is neither a closed feature nor a
 * failure, it is something the traveller can CLEAR, and it carries the route to
 * the screen that clears it. `classifyBookingRefusal` at the bottom of this file
 * is the single place that decides which of the three a code is.
 *
 * Kept free of imports (no react-native, no supabase) so it can be unit-tested
 * under node:test; re-exported from rentABuddy.ts, which is where callers
 * import it from.
 */
import { errorCopy } from '../lib/errorCopy.ts';

/** Refusal codes meaning "this feature is not open", not "your request was wrong". */
export const BOOKING_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'verification_unavailable',
  'feature_disabled',
  'waitlist_only',
  'globally_paused',
  'city_not_launched',
]);

export function isBookingUnavailable(code: string | null | undefined): boolean {
  return typeof code === 'string' && BOOKING_UNAVAILABLE_CODES.has(code);
}

const BOOKING_UNAVAILABLE_COPY: Record<string, string> = {
  // Honest, not coy: name the reason and say plainly that it is not open yet.
  verification_unavailable:
    "Rent a Buddy isn't open yet. We're still setting up identity verification, and we won't take bookings until we can confirm who you're meeting.",
  feature_disabled:
    "Rent a Buddy isn't available yet. We'll open bookings once it's ready.",
  waitlist_only:
    "Rent a Buddy isn't open for bookings in this city yet. Join the waitlist and we'll let you know the moment it is.",
  globally_paused:
    'Rent a Buddy bookings are paused at the moment. Nothing is wrong with your request — please check back soon.',
  city_not_launched:
    "Rent a Buddy hasn't launched in this city yet. Join the waitlist to hear when it does.",
};

const GENERIC_BOOKING_ERROR =
  "Something went wrong on our side and we couldn't complete that. Please try again.";

// ── The third class: a refusal the traveller can actually clear ──────────────
//
// census-trust TV-2a: *"the server-side gate exists … but a user it refuses is
// given no route to satisfy it."*
//
// `routes/rentABuddyRollout.ts` refuses an MVP-mode booking with
// `verification_required` when the traveller's ID is not verified. That code
// was in NEITHER map above, so `bookingErrorCopy` fell through to
// `GENERIC_BOOKING_ERROR` and a person who had just filled in the whole
// checkout form read "Something went wrong on our side … Please try again."
// Nothing went wrong, it was not on our side, and trying again does the same
// thing forever: the gate is a fact about the account, not a transient failure.
//
// WHY THIS IS NOT JUST ANOTHER `BOOKING_UNAVAILABLE_CODES` ENTRY. Those five
// mean "the feature is closed, wait" — the checkout screen disables the Book
// button under the heading "Not available yet". That is the wrong sentence for
// something the person can clear themselves in one sitting, and it would hide
// the only fact that helps them. This class says what is missing AND where to
// go and get it.
const BOOKING_ACTIONABLE_COPY: Record<string, string> = {
  verification_required:
    "Your ID isn't verified yet, and Rent a Buddy needs it before a booking can go through — it's how we can tell you who you're meeting. Verify once and you can come straight back here.",
};

/** A refusal the user can clear, and the screen that clears it. */
export interface BookingRefusalAction {
  /** Button text. Human copy, never a code. */
  label: string;
  /** An app route, as registered in `src/navigation/portavaRoutes.ts`. */
  route: string;
}

const BOOKING_REFUSAL_ACTIONS: Record<string, BookingRefusalAction> = {
  verification_required: { label: 'Verify my ID', route: '/profile/verification' },
};

/**
 * The screen that satisfies this refusal, or `null` when there is nothing the
 * user can do about it.
 *
 * `null` is the answer for every feature-closed code on purpose: sending a
 * person whose CITY has not launched off to photograph their passport would be
 * a worse dead end than the one this closes, because it looks like progress.
 */
export function bookingRefusalAction(
  code: string | null | undefined,
): BookingRefusalAction | null {
  if (!code) return null;
  return BOOKING_REFUSAL_ACTIONS[code] ?? null;
}

/**
 * Human copy for any Rent-a-Buddy refusal.
 *
 * Unknown codes fall back to generic copy rather than being echoed: apiFetch
 * yields either a server error code (`snake_case`, no spaces), an `HTTP <status>`
 * placeholder, or a caught network-error message. Only the last is human text,
 * so anything without a space is treated as a code and never shown raw.
 *
 * `fallback` is the caller's own sentence for "no usable copy from the server".
 * Many call sites already had one — `'Could not accept booking.'`, and in the
 * safety flow `'Please call local emergency services if you are in danger.'` —
 * and those are better than anything generic this module could invent, so they
 * are preserved rather than replaced. The rule this function enforces is only
 * that a raw code is never what a user reads.
 */
export function bookingErrorCopy(
  code: string | null | undefined,
  fallback?: string,
): string {
  // The Rent-a-Buddy map first — a feature-closed code has specific, honest
  // copy that must beat any caller fallback. Everything else is the general
  // "don't show a machine string" rule, which lives in lib/errorCopy so other
  // features can use it WITHOUT inheriting Rent-a-Buddy's wording.
  if (code) {
    const known = BOOKING_UNAVAILABLE_COPY[code];
    if (known) return known;
    const actionable = BOOKING_ACTIONABLE_COPY[code];
    if (actionable) return actionable;
  }
  return errorCopy(code, fallback ?? GENERIC_BOOKING_ERROR);
}

// ── The three-way decision, in ONE place ─────────────────────────────────────
//
// The checkout screen made this decision inline, as two `if`s and a fallthrough,
// and the ORDER of those `if`s is the whole behaviour: the actionable class must
// be tested before the feature-closed class and before the Alert, or the one
// refusal with a way out of it gets reported as one without. That ordering was
// invisible to every test, because it lived in a screen. It lives here now, and
// `__tests__/rentABuddy.verificationRoute.test.ts` pins all three arms.

export type BookingRefusal =
  /** The person can clear this themselves. Persistent, and it carries the route. */
  | { kind: 'actionable'; body: string; action: BookingRefusalAction }
  /** The feature is closed. Persistent, and the Book button goes down with it. */
  | { kind: 'unavailable'; body: string }
  /** Something actually failed. An Alert, and a retry is a reasonable thing to offer. */
  | { kind: 'failure'; body: string };

/**
 * Classify a refusal code into the one of three treatments it deserves.
 *
 * `fallback` is the caller's own sentence for the failure arm, preserved for the
 * same reason `bookingErrorCopy` preserves it: many call sites have a better
 * sentence than anything generic this module could invent.
 */
export function classifyBookingRefusal(
  code: string | null | undefined,
  fallback?: string,
): BookingRefusal {
  const action = bookingRefusalAction(code);
  if (action) return { kind: 'actionable', body: bookingErrorCopy(code), action };
  if (isBookingUnavailable(code)) return { kind: 'unavailable', body: bookingErrorCopy(code) };
  return { kind: 'failure', body: bookingErrorCopy(code, fallback) };
}
