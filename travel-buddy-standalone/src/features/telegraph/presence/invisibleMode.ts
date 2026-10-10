/**
 * Telegraph §4.4 / lead ruling P-T1 (2026-10-07), on the device: WHEN a person is invisible, and
 * what being invisible does — said where they turn it on (census-telegraph T29 / T421).
 *
 * The server engages invisible mode from three location-consent columns
 * (artifacts/api-server/src/lib/invisibleMode.ts resolveInvisibleMode): location mode Off,
 * sharing paused, or a discovery visibility that names nobody. Under P-T1 it then withholds the
 * person's availability from EVERY other viewer, crew included — their Passport, the conversation
 * header, Compass, shared context, and the trip and circle availability lists and best days
 * (census-telegraph §52 F2) — while their own map keeps working. Before this, the Location screen's
 * "Pause sharing" switch said only "Temporarily stop all location sharing": a person pausing their
 * location had no way to learn that their friends and crew would also stop seeing when they are
 * free. A refusal nobody can read about is the thing lead ruling D-24 forbids; this is the same rule
 * for a withholding.
 *
 * `engagesInvisibleMode` mirrors the server rule exactly (a jest test reads the server file and fails
 * on any drift). It decides only what the screen SAYS; nothing on the device decides what anyone sees.
 */

/** The discovery visibilities that make a person invisible (server: HIDDEN_DISCOVERY_VALUES). */
export const INVISIBLE_DISCOVERY_VALUES: readonly string[] = ['nobody', 'no_location', 'none'];

export interface InvisibleModeInputs {
  locationMode: string | null | undefined;
  sharingPaused: boolean | null | undefined;
  discoveryVisibility: string | null | undefined;
}

/** True when the server will treat this person as invisible (lib/invisibleMode.ts resolveInvisibleMode). */
export function engagesInvisibleMode(p: InvisibleModeInputs): boolean {
  if (p.locationMode === 'off') return true;
  if (p.sharingPaused === true) return true;
  return typeof p.discoveryVisibility === 'string' && INVISIBLE_DISCOVERY_VALUES.includes(p.discoveryVisibility);
}

/** The "Pause sharing" switch's own line: what pausing does, before it is pressed. */
export const PAUSE_SHARING_SUBTITLE =
  "Temporarily stop all location sharing. While paused you're invisible: your availability is hidden from everyone, crew included.";

/** Shown while invisible mode is engaged, whichever setting engaged it. */
export const INVISIBLE_MODE_NOTICE =
  "You're invisible. Your availability is hidden from everyone, crew included: on your Passport, in conversations, in Compass and on trip and circle lists. Days you've marked on a trip's planner stay visible to that trip. Your own map keeps working.";
