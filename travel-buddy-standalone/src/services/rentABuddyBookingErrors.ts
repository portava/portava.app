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
 * Kept free of imports (no react-native, no supabase) so it can be unit-tested
 * under node:test; re-exported from rentABuddy.ts, which is where callers
 * import it from.
 */

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
  const generic = fallback ?? GENERIC_BOOKING_ERROR;
  if (!code) return generic;
  const known = BOOKING_UNAVAILABLE_COPY[code];
  if (known) return known;
  const trimmed = code.trim();
  if (!trimmed || !/\s/.test(trimmed) || /^HTTP \d+$/.test(trimmed)) {
    return generic;
  }
  return trimmed;
}
