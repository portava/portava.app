/**
 * locateFriendsTtl — the bounded set of session lifetimes the §12 UI may offer.
 *
 * §12: "Temporary and auto-expiring." The server REQUIRES `ttlMinutes` and
 * bounds it to `MAX_SESSION_MS` (12h), rejecting anything outside `[1, 720]`
 * minutes and never defaulting. This module is the client's matching list of
 * CHOICES: the durations a person may pick when starting a session, every one
 * of which the server will accept.
 *
 * WHY A CLOSED LIST RATHER THAN A FREE FIELD
 * ==========================================
 * A free-form minutes field is one fat-finger away from "720000" and one
 * missing validation from a session that outlives the event. A closed list of
 * durations makes an out-of-bound TTL unpickable at the source, and a test
 * asserts every option is inside the server's own `[MIN, MAX]` window — so the
 * two cannot drift into a choice the server would reject.
 *
 * The hard-coded 120-minute chip this replaces was not wrong, it was FROZEN:
 * every session was two hours whatever the event needed. The point of §12 being
 * "temporary" is that the person choosing decides how temporary; a single baked
 * constant is the quiet way "temporary" becomes "whatever we shipped".
 *
 * Pure. No React, no clock. The screen renders these; it does not invent them.
 */

import { MAX_SESSION_MS, MIN_SESSION_MS } from './locateFriends.ts';

/** The server's bound, in the minutes the API actually takes. 12 hours. */
export const MAX_SESSION_MINUTES = Math.floor(MAX_SESSION_MS / 60_000);
/** The server's floor. A session must last at least this. */
export const MIN_SESSION_MINUTES = Math.max(1, Math.ceil(MIN_SESSION_MS / 60_000));

export interface LocateFriendsTtlOption {
  minutes: number;
  /** The chip label — the human duration. */
  label: string;
  /** Screen-reader phrasing, so the control reads as a duration not a number. */
  accessibilityLabel: string;
}

/**
 * The durations offered, shortest first.
 *
 * The span is one meal out (1h) to the 12-hour ceiling (a full festival day),
 * which is the range §12's "event or a day out" actually covers. Every value is
 * ≤ `MAX_SESSION_MINUTES`; the top option IS the ceiling, so the UI can express
 * the longest the server will allow without the user reaching for a free field.
 */
export const LOCATE_FRIENDS_TTL_OPTIONS: readonly LocateFriendsTtlOption[] = [
  { minutes: 60, label: '1h', accessibilityLabel: 'Locate my friends for one hour' },
  { minutes: 120, label: '2h', accessibilityLabel: 'Locate my friends for two hours' },
  { minutes: 240, label: '4h', accessibilityLabel: 'Locate my friends for four hours' },
  { minutes: 480, label: '8h', accessibilityLabel: 'Locate my friends for eight hours' },
  {
    minutes: MAX_SESSION_MINUTES,
    label: '12h',
    accessibilityLabel: 'Locate my friends for twelve hours, the maximum',
  },
] as const;

/**
 * The pre-selected duration. 2 hours — the same length the frozen chip used, so
 * the default behaviour is unchanged and only the ABILITY to choose is new.
 */
export const DEFAULT_LOCATE_FRIENDS_TTL_MINUTES = 120;

/**
 * Is a chosen TTL one the server will accept? Integer minutes inside `[MIN, MAX]`.
 *
 * The last line of defence before a session is started: even a UI bug that
 * offered an out-of-range value cannot get past this into `startLocateFriends`.
 */
export function isTtlWithinBound(minutes: unknown): minutes is number {
  return (
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= MIN_SESSION_MINUTES &&
    minutes <= MAX_SESSION_MINUTES
  );
}
