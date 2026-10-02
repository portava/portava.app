/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B21): the RSVP and waitlist reads every
 * event count is computed from, read whole through `readAllPages` (lib/pagedRead.ts) so PostgREST's db-max-rows can
 * never cut them silently. Each answers `{ data, error }` as the unbounded read did; a cut read is an error, so the
 * caller's failed-read arm (keep the cached count and name the read, or leave the counter alone) takes it.
 *
 * Every read is ordered by a key that partitions the set (`event_rsvps` and `event_waitlist` are unique on
 * `(event_id, user_id)`), so the pages neither overlap nor skip rows.
 */
import { readAllPages, type PagedRead } from "./pagedRead.js";

/** The going RSVPs of these events (`event_id, user_id`): the list's live going recount. */
export function readGoingRsvpsForEvents(sc: any, eventIds: string[]): Promise<PagedRead<{ event_id: string; user_id: string }>> {
  return readAllPages((from, to) => sc.from("event_rsvps").select("event_id, user_id", { count: "exact" })
    .in("event_id", eventIds).eq("status", "going").order("event_id").order("user_id").range(from, to));
}

/** The waitlist rows of these events (`event_id, user_id`): the list's live waitlist recount. */
export function readWaitlistForEvents(sc: any, eventIds: string[]): Promise<PagedRead<{ event_id: string; user_id: string }>> {
  return readAllPages((from, to) => sc.from("event_waitlist").select("event_id, user_id", { count: "exact" })
    .in("event_id", eventIds).order("event_id").order("user_id").range(from, to));
}

/** One event's RSVPs (`user_id, status`): of one status (`eq`), of several (`in`), or all. */
export function readEventRsvps(sc: any, eventId: string, only: { status?: string; statuses?: string[] } = {}): Promise<PagedRead<{ user_id: string; status: string }>> {
  return readAllPages((from, to) => {
    let q = sc.from("event_rsvps").select("user_id, status", { count: "exact" }).eq("event_id", eventId);
    if (only.status !== undefined) q = q.eq("status", only.status);
    if (only.statuses !== undefined) q = q.in("status", only.statuses);
    return q.order("user_id").range(from, to);
  });
}

/** One event's waitlist rows (`user_id`). */
export function readEventWaitlist(sc: any, eventId: string): Promise<PagedRead<{ user_id: string }>> {
  return readAllPages((from, to) => sc.from("event_waitlist").select("user_id", { count: "exact" })
    .eq("event_id", eventId).order("user_id").range(from, to));
}
