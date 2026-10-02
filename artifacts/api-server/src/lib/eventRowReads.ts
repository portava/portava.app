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

/**
 * census-discovery §117 (DV-83 round 20, B20): recount `going_count` and/or `waitlist_count` live for these event rows,
 * writing the live counts onto the rows a list is about to serve. A read that failed or was cut leaves that column as
 * cached on every row, and its table is answered so the list names it (`failedSources`); `[]` when every read asked for
 * answered whole. The cached counters are written by many paths, any of which can leave them stale (round 19's SW11
 * leaves a counter alone over a failed recount, by design), so a list that serves them recounts them.
 */
export async function liveEventCounters(sc: any, rows: any[], which: { going?: boolean; waitlist?: boolean } = { going: true, waitlist: true }): Promise<string[]> {
  const ids = [...new Set(rows.map((r) => r?.id).filter((x): x is string => typeof x === "string"))];
  if (ids.length === 0) return [];
  const [going, waitlist] = await Promise.all([
    which.going ? readGoingRsvpsForEvents(sc, ids) : null,
    which.waitlist ? readWaitlistForEvents(sc, ids) : null,
  ]);
  const failed: string[] = [];
  const apply = (read: PagedRead<{ event_id: string }> | null, table: string, column: string) => {
    if (!read) return;
    if (read.error || !Array.isArray(read.data)) { failed.push(table); return; }
    const counts = new Map<string, number>();
    for (const r of read.data) counts.set(r.event_id, (counts.get(r.event_id) ?? 0) + 1);
    for (const row of rows) if (row && typeof row.id === "string") row[column] = counts.get(row.id) ?? 0;
  };
  apply(going, "event_rsvps", "going_count");
  apply(waitlist, "event_waitlist", "waitlist_count");
  return failed;
}
