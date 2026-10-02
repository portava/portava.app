/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19): what GET /events/:id could not read
 * about who is going, so no screen says a failed read as nobody.
 *
 * The route names a failed read in `failedSources`: `event_rsvps` when an RSVP read failed (the going/maybe list the
 * attendees are drawn from, or the full RSVP count), `profiles` when the going travellers' or the host's profiles could
 * not be read. Either way `goingAttendees` may be empty only because the read failed. `event_rsvps` also covers the full
 * RSVP count, so a whole attendee list can arrive beside it: consumers say "couldn't load" only where they would
 * otherwise say the list is empty, and still list what arrived.
 */

export interface EventReadMarks {
  failedSources?: string[] | null;
  host?: unknown;
}

const named = (e: EventReadMarks | null | undefined, source: string): boolean =>
  Array.isArray(e?.failedSources) && e!.failedSources!.includes(source);

/** The attendee list may be empty because a read failed. */
export function attendeesUnread(e: EventReadMarks | null | undefined): boolean {
  return named(e, 'event_rsvps') || named(e, 'profiles');
}

/** The host is missing because its profile read failed. */
export function hostUnread(e: EventReadMarks | null | undefined): boolean {
  return !e?.host && named(e, 'profiles');
}
