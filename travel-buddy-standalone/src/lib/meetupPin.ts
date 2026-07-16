/**
 * Meetup-pin privacy helpers.
 *
 * The buddy "Meetup spot" screen stores an APPROXIMATE pin only:
 *  - coordinates are rounded to 3 decimal places (~110 m) so the stored
 *    point is neighbourhood-level, never an exact address;
 *  - the profile PATCH always carries both coordinates or both null —
 *    a half-cleared pin (one coordinate set, the other null) is invalid.
 *
 * Keep the screen (app/(rent-a-buddy)/buddy-dashboard/meetup-pin.tsx) using
 * these helpers so the contract stays testable.
 */

/** Round a coordinate to ~3 decimal places (≈110 m). */
export function roundMeetupCoord(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface MeetupPinPatch {
  meetupBaseLat: number | null;
  meetupBaseLng: number | null;
}

/**
 * Build the profile PATCH payload for a meetup pin.
 * Enforces both-or-null: if either coordinate is missing, both are cleared.
 */
export function buildMeetupPinPatch(
  lat: number | null | undefined,
  lng: number | null | undefined,
): MeetupPinPatch {
  if (lat == null || lng == null) {
    return { meetupBaseLat: null, meetupBaseLng: null };
  }
  return { meetupBaseLat: lat, meetupBaseLng: lng };
}
