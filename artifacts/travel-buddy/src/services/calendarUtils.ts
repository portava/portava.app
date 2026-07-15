/**
 * calendarUtils — pure date-derivation helpers extracted from calendar.ts.
 *
 * These functions carry zero native-module dependencies and can be imported
 * and tested in any JavaScript environment (Node.js, Jest, node:test).
 */

export interface MeetupDateInput {
  startsAt: string | null;
  endsAt: string | null;
}

export interface DerivedMeetupDates {
  /** null when startsAt is absent — caller should surface an error to the user. */
  startDate: Date | null;
  /** endDate + 1-hour default when endsAt is null; Date(0) sentinel when startDate is null. */
  endDate: Date;
}

/**
 * Derives startDate and endDate from a meetup record.
 *
 * Rules (mirrors the logic in addMeetupToCalendar):
 *   - startDate = new Date(startsAt) when startsAt is present, null otherwise.
 *   - endDate   = new Date(endsAt)   when endsAt is present,
 *                 startDate + 1 hour  when endsAt is absent but startDate is present,
 *                 Date(0)             when startDate is also absent (sentinel; caller
 *                 never uses endDate in that case because it checks startDate first).
 */
export function deriveMeetupDates(meetup: MeetupDateInput): DerivedMeetupDates {
  const startDate = meetup.startsAt ? new Date(meetup.startsAt) : null;
  if (!startDate) {
    return { startDate: null, endDate: new Date(0) };
  }
  const endDate = meetup.endsAt
    ? new Date(meetup.endsAt)
    : new Date(startDate.getTime() + 60 * 60 * 1000);
  return { startDate, endDate };
}
