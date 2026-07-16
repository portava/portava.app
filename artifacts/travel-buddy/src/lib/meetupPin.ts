/**
 * Meetup-pin privacy helpers.
 *
 * Privacy contract for the buddy meetup-base pin:
 *  - Coordinates are rounded to ~3 decimal places (≈110 m) so the stored
 *    pin is neighbourhood-level, never an exact address.
 *  - Saves are all-or-nothing: both coordinates or both null. A half-set
 *    pin (one coordinate present, the other missing) must never be sent.
 *  - The PATCH payload uses exactly the keys `meetupBaseLat` / `meetupBaseLng`.
 */

/** Decimal places kept on a stored meetup coordinate (~110 m precision). */
export const MEETUP_PIN_DECIMALS = 3;

const FACTOR = 10 ** MEETUP_PIN_DECIMALS;

/** Round a raw coordinate to the privacy-preserving precision. */
export function roundMeetupCoord(value: number): number {
  return Math.round(value * FACTOR) / FACTOR;
}

/**
 * Round a picked lat/lng pair for the draft pin. Returns null when either
 * coordinate is missing — a partial pick must not produce a half-set pin.
 */
export function roundMeetupPin(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  return { lat: roundMeetupCoord(lat), lng: roundMeetupCoord(lng) };
}

/**
 * Build the profile PATCH payload for saving the meetup pin.
 * Enforces both-or-null: if either coordinate is null/undefined, both are
 * cleared. Keys are the exact API contract keys.
 */
export function buildMeetupPinPatch(
  lat: number | null,
  lng: number | null,
): { meetupBaseLat: number | null; meetupBaseLng: number | null } {
  if (lat == null || lng == null) {
    return { meetupBaseLat: null, meetupBaseLng: null };
  }
  return { meetupBaseLat: lat, meetupBaseLng: lng };
}
