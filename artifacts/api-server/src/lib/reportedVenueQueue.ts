/**
 * reportedVenueQueue — GET /admin/venues/reported's queue (routes/admin.ts),
 * read so that a reported venue never vanishes from it.
 *
 * ── WHAT WAS WRONG (census-trust, wave 5, the remaining seven) ─────────────
 * The route read the newest `limit` discovery_places with a
 * `discovery_place_reports(count)` embed and a
 * `.gt("discovery_place_reports.count", 0)` filter, mapped
 * `reportCount = row.discovery_place_reports[0]?.count ?? 0`, and DROPPED every
 * row whose reportCount was not above 0. So:
 *   1. a venue whose report-count embed answered without a count read as "0
 *      reports" and vanished from the moderation queue;
 *   2. the limit applied to ALL places, newest first, before anything knew
 *      which were reported: a reported venue older than the newest `limit`
 *      places was never in the queue, however many reports it had;
 *   3. `total` was the page's length;
 *   4. the filter names `count` on the embedded table as if it were a column.
 *      The schema-strict double reads it as a column of discovery_places
 *      (42703). Whether PostgREST accepts a filter on an aggregate embed was
 *      not measured; the queue no longer depends on it.
 *
 * ── NOW ─────────────────────────────────────────────────────────────────────
 * The queue starts from the REPORTS. Every discovery_place_reports row is read
 * (paged past the row cap: lib/moderationCounts.ts readEveryRow) and grouped by
 * place, so a venue's reportCount is the number of its report rows — never an
 * embed's say-so. Then the reported places are read by id, 100 at a time.
 * Ordered by reportCount (most first), then the newest report, then id; the
 * route serves the first `limit` and `total` counts every reported venue.
 *
 * A reported place the places read does not return (removed after its reports
 * were read; reports cascade with their place, so only a race does this) is
 * KEPT, flagged `venueMissing: true`, as the trips and events queues keep a
 * report whose parent is gone.
 *
 * NEVER REJECTS. A read that fails, throws, or answers no list or no exact
 * count is `ok: false` with a message naming it: the route refuses the page —
 * its own convention for a returned error — rather than serve a queue a
 * reported venue could be missing from.
 */
import { readEveryRow } from "./moderationCounts.js";

/** discovery_places columns the queue shows (all live: test/generated/liveColumns.json). */
export const REPORTED_VENUE_COLUMNS = "id, name, place_type, category, city, neighborhood, blurb, status, submitted_by, created_at";

export interface ReportedVenue {
  id: string;
  name: string | null;
  placeType: string | null;
  category: string | null;
  city: string | null;
  neighborhood: string | null;
  blurb: string | null;
  status: string | null;
  submittedBy: string | null;
  createdAt: string | null;
  /** How many discovery_place_reports rows name this place: every row was read. */
  reportCount: number;
  /** The newest report's reason, and when it was filed (an upsert re-stamps created_at). */
  latestReason: string | null;
  latestReportAt: string | null;
  /** Present only when the place itself could not be found: its reports were read, the place was gone. */
  venueMissing?: true;
}

export type ReportedVenueQueue =
  | { readonly ok: true; readonly venues: ReportedVenue[] }
  | { readonly ok: false; readonly message: string };

const PLACE_CHUNK = 100;

/** Every reported venue, most-reported first. */
export async function readReportedVenueQueue(sc: any): Promise<ReportedVenueQueue> {
  const reports = await readEveryRow((from, to) => sc
    .from("discovery_place_reports")
    .select("id, place_id, reason, created_at", { count: "exact" })
    .order("id", { ascending: true })
    .range(from, to));
  if (reports.error || !reports.data) {
    return { ok: false, message: `The venue reports could not be read (discovery_place_reports): ${reports.error?.message ?? "no rows answered"}. A venue missing from this queue would read as "not reported". Retry.` };
  }

  const byPlace = new Map<string, { reportCount: number; latestReason: string | null; latestReportAt: string | null }>();
  for (const r of reports.data) {
    const placeId = r?.place_id;
    if (typeof placeId !== "string" || placeId === "") continue; // NOT NULL in the schema
    const g = byPlace.get(placeId) ?? { reportCount: 0, latestReason: null, latestReportAt: null };
    g.reportCount++;
    const at = typeof r.created_at === "string" ? r.created_at : null;
    if (g.latestReportAt === null || (at !== null && at > g.latestReportAt)) {
      g.latestReportAt = at;
      g.latestReason = typeof r.reason === "string" ? r.reason : null;
    }
    byPlace.set(placeId, g);
  }

  const ids = [...byPlace.keys()];
  const places = new Map<string, any>();
  for (let i = 0; i < ids.length; i += PLACE_CHUNK) {
    // Paged too: a chunk of ids under a server cap smaller than the chunk would otherwise read as "place missing".
    const chunk = ids.slice(i, i + PLACE_CHUNK);
    const got = await readEveryRow((from, to) => sc
      .from("discovery_places")
      .select(REPORTED_VENUE_COLUMNS, { count: "exact" })
      .in("id", chunk)
      .order("id", { ascending: true })
      .range(from, to));
    if (got.error || !got.data) {
      return { ok: false, message: `The reported venues could not be read (discovery_places): ${got.error?.message ?? "no rows answered"}. A venue missing from this queue would read as "not reported". Retry.` };
    }
    for (const p of got.data) places.set(p.id, p);
  }

  const venues: ReportedVenue[] = ids.map((id) => {
    const g = byPlace.get(id)!;
    const p = places.get(id);
    const base = {
      id,
      name: p?.name ?? null,
      placeType: p?.place_type ?? null,
      category: p?.category ?? null,
      city: p?.city ?? null,
      neighborhood: p?.neighborhood ?? null,
      blurb: p?.blurb ?? null,
      status: p?.status ?? null,
      submittedBy: p?.submitted_by ?? null,
      createdAt: p?.created_at ?? null,
      reportCount: g.reportCount,
      latestReason: g.latestReason,
      latestReportAt: g.latestReportAt,
    };
    return p ? base : { ...base, venueMissing: true as const };
  });
  venues.sort((a, b) =>
    b.reportCount - a.reportCount ||
    String(b.latestReportAt ?? "").localeCompare(String(a.latestReportAt ?? "")) ||
    a.id.localeCompare(b.id));
  return { ok: true, venues };
}
