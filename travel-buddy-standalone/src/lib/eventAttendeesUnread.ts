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

// ── census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B24, B25) ─────────────────────────────

/** What the event screens read about who is going beyond `failedSources`. */
export interface EventAttendeeMarks extends EventReadMarks {
  goingAttendees?: unknown[] | null;
  counts?: { going?: number | null; maybe?: number | null } | null;
  goingAttendeesTruncated?: boolean;
  goingAttendeesTotal?: number | null;
}

/**
 * The going count could not be read live: the route served the cached counter in `counts.going` and named
 * `event_rsvps`. `event_rsvps` also names a failed full-RSVP read beside a live going count; the going/maybe read is the
 * one that failed when `counts.maybe` is null, which the route serves only then.
 */
export function goingCountUnread(e: EventAttendeeMarks | null | undefined): boolean {
  return named(e, 'event_rsvps') && e?.counts?.maybe == null;
}

/**
 * `goingAttendees` is a slice of who is going: the route says so (`goingAttendeesTruncated`), or the live going count
 * is more than the travellers listed (a body from a server that did not mark it). `total` is how many are going, when
 * known. An unread list is `attendeesUnread`'s, not a slice.
 */
export function attendeesListCut(e: EventAttendeeMarks | null | undefined): { cut: boolean; total: number | null } {
  if (!e || goingListUnread(e)) return { cut: false, total: null };  // census-discovery §119 (B29): only the going list's own failure steps aside
  const listed = Array.isArray(e.goingAttendees) ? e.goingAttendees.length : 0;
  const total = typeof e.goingAttendeesTotal === 'number' ? e.goingAttendeesTotal
    : typeof e.counts?.going === 'number' ? e.counts.going : null;
  if (e.goingAttendeesTruncated === true) return { cut: true, total };
  return { cut: total !== null && total > listed, total };
}

/** "Showing 4 of 6 going", or "Showing the first 4 going" when the total is not known. */
export function attendeesCutText(e: EventAttendeeMarks | null | undefined): string {
  const listed = Array.isArray(e?.goingAttendees) ? e!.goingAttendees!.length : 0;
  const { total } = attendeesListCut(e);
  return total !== null ? `Showing ${listed} of ${total} going` : `Showing the first ${listed} going`;
}

/** The waitlist count could not be read live: the route served the cached `waitlistCount` and named `event_waitlist`. */
export function waitlistCountUnread(e: EventReadMarks | null | undefined): boolean {
  return named(e, 'event_waitlist');
}

// ── census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B29) ──────────────────────────────────

/**
 * The going list ITSELF could not be read, so whether it is a slice is not known: the going/maybe read failed (the
 * route served the cached count, `goingCountUnread`), or nobody is listed beside a failed profiles read although
 * travellers are going or the going count is unknown. Another read named beside a list that arrived (the full RSVP
 * count's `event_rsvps`, the host's `profiles`) is not the list's: the route's slice mark still holds.
 */
export function goingListUnread(e: EventAttendeeMarks | null | undefined): boolean {
  if (!e) return false;
  if (goingCountUnread(e)) return true;
  const listed = Array.isArray(e.goingAttendees) ? e.goingAttendees.length : 0;
  const going = e.counts?.going;
  return listed === 0 && named(e, 'profiles') && !(typeof going === 'number' && going === 0);
}
