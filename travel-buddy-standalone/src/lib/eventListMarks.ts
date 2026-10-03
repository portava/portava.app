/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): what an events list could not read, so no screen
 * says a list it could not read whole as "no events", or a count it could not recount as measured.
 *
 * Every events list the server answers recounts `goingCount` and `waitlistCount` live (B20, SW18). A live read that
 * failed or was cut keeps the cached count, which may be stale, and is named in `failedSources`: `event_rsvps` for the
 * going counts, `event_waitlist` for the waitlist counts. GET /events (and its city alias) also adds `truncated: true`
 * to an answer that is not whole: a page of several, a filled rank pool, or friends-only events withheld over a failed
 * friendship read (§115, B12). No screen read either: the cards said the cached count as the count, and an empty page
 * of a list that was not whole was "No events found".
 */

export interface EventListMarks {
  failedSources?: unknown;
  truncated?: unknown;
}

/** The counts on one listed event that the list could not recount live (the cached ones were served). */
export interface EventCountMarks {
  goingCountUnread?: boolean;
  waitlistCountUnread?: boolean;
}

const named = (b: EventListMarks | null | undefined, source: string): boolean =>
  Array.isArray(b?.failedSources) && (b!.failedSources as unknown[]).includes(source);

/**
 * The list's events, each marked with the counts the list could not recount live. A body that names neither read is
 * returned unchanged, so a healthy answer is byte-identical.
 */
export function markEventListCounts<B>(body: B): B {
  const b = body as (EventListMarks & { events?: unknown }) | null | undefined;
  if (!b || !Array.isArray(b.events)) return body;
  const going = named(b, 'event_rsvps');
  const waitlist = named(b, 'event_waitlist');
  if (!going && !waitlist) return body;
  return {
    ...b,
    events: (b.events as object[]).map((e) => ({
      ...e,
      ...(going ? { goingCountUnread: true } : {}),
      ...(waitlist ? { waitlistCountUnread: true } : {}),
    })),
  } as B;
}

/** `ApiResult` of a list, its events marked (`markEventListCounts`); a failed result is returned as is. */
export function markEventListResult<R extends { ok: boolean; data?: unknown }>(r: R): R {
  return r.ok && r.data ? ({ ...r, data: markEventListCounts(r.data) } as R) : r;
}

/** The list said it is not whole (`truncated: true`): an empty page of it is not "no events". */
export function eventListNotWhole(b: unknown): boolean {
  return (b as EventListMarks | null | undefined)?.truncated === true;
}

/** "12 going", or "12 going (last known)" when the count could not be recounted. */
export function goingText(count: number | null | undefined, unread?: boolean, max?: number | null): string {
  return `${count ?? 0} going${max ? `/${max}` : ''}${unread ? ' (last known)' : ''}`;
}

/**
 * "12 going/20 · 3 waiting" as the list cards say it, with a count the list could not recount said as last known. A
 * whole waitlist count of 0 is omitted, as before; an unread one is said, since the queue may not be empty.
 */
export function attendanceText(
  e: { goingCount: number; maxAttendees?: number | null; waitlistCount?: number } & EventCountMarks,
  opts: { waitlist?: boolean } = {},
): string {
  const going = goingText(e.goingCount, e.goingCountUnread, e.maxAttendees);
  if (!opts.waitlist) return going;
  const w = e.waitlistCount ?? 0;
  if (e.waitlistCountUnread) return `${going} · ${w} waiting (last known)`;
  return w > 0 ? `${going} · ${w} waiting` : going;
}
