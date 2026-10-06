/**
 * listedHours — the label stored opening hours carry wherever a live open-now
 * status can sit beside them.
 *
 * Lead ruling D-67 (2026-10-06): "verified live" belongs only to a place whose
 * identity the server confirmed. "Listing hours may still be shown if labelled
 * as listed hours." Hours a card or sheet reads from the place record are a
 * listing — somebody's statement of the schedule, not a check of the door — so
 * they never appear bare next to an "Open now — verified live" pill, and they
 * say so when the server answered that it could not verify the place live.
 *
 * One module so the list card, the detail sheet and the place screen cannot
 * drift into three wordings of the same fact.
 */

export const LISTED_HOURS_LABEL = 'Listed hours';

/** Appended when the live lookup answered but could not confirm this place. */
export const LISTED_HOURS_UNVERIFIED_NOTE = "can't verify live";

/** The visible text for stored hours: always labelled as a listing. */
export function listedHoursText(hours: string): string {
  return `${LISTED_HOURS_LABEL}: ${hours}`;
}
