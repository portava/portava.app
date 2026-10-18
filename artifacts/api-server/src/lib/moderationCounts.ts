/**
 * moderationCounts — a count that a moderation record states, read so that a
 * count nobody measured is never shown as 0.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The admin user detail (GET /admin/users?email=… | ?handle=…, routes/admin.ts)
 * read `reports` inline — a HEAD read with `{ count: "exact" }` — and rendered
 * `openReports: count ?? 0`. failedModerationReads refused the record on a
 * RETURNED error, but an answer with no error and no count (or a count that is
 * not a count: negative, fractional, a string) showed an operator "no open
 * reports" on a user whose reports were never counted, and a THROWN read took
 * the whole route down as a bare 500.
 *
 * The same class lib/exclusionSet.ts countRestrictRows closed for the moderation
 * dossier's restrictCount (census-telegraph T220d). This is that count form for
 * the legacy `reports` table, which is not an exclusion table and so does not
 * belong in that module.
 *
 * NEVER REJECTS: a returned error, a thrown read, or an answer whose count is
 * not a non-negative safe integer is `ok: false` — never `count ?? 0`. The
 * caller answers `ok: false` the way it answers any unreadable moderation fact;
 * the user detail refuses the record and names the field.
 */
export type ModerationCount =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string };

function countUnavailable(reason: unknown): Extract<ModerationCount, { ok: false }> {
  const r = reason as { message?: unknown; code?: unknown } | null;
  return { ok: false, reason: String(r?.message ?? r?.code ?? reason ?? "moderation count unreadable") };
}

/**
 * How many UNRESOLVED legacy `reports` rows name `userId` as their target — the
 * user detail's `openReports`. A HEAD read with an exact count (Postgres counts,
 * so the row cap does not apply), `target_id = userId`, status one of
 * UNRESOLVED_REPORT_STATUSES (below): open, or in_review — a report a moderator touched but did not close.
 */
export async function countOpenReportsAgainst(sc: any, userId: string): Promise<ModerationCount> {
  if (!sc || !userId) return countUnavailable("no client or user");
  try {
    const res = await sc.from("reports").select("id", { count: "exact", head: true }).eq("target_id", userId).in("status", UNRESOLVED_REPORT_STATUSES);
    if (res?.error) return countUnavailable(res.error);
    if (typeof res?.count !== "number" || !Number.isSafeInteger(res.count) || res.count < 0) return countUnavailable("a reports count read answered without its count");
    return { ok: true, count: res.count };
  } catch (err) {
    return countUnavailable(err);
  }
}

/**
 * ── THE LEGACY `reports` STATUS VOCABULARY ─────────────────────────────────
 * One list for every writer and reader of `public.reports.status`.
 *
 * The column is TEXT with DEFAULT 'open' and NO CHECK (production catalog, read
 * 2026-10-18), so nothing in the database keeps a writer and a reader on the
 * same word, and they drifted apart:
 *   - every intake (POST /reports, thread, message and post reports) files with
 *     the default, 'open';
 *   - POST /reviews/:id/report wrote 'pending' — the word of docs/sql/0071, a
 *     design that was never applied (migration 0063, which created the live
 *     table, declares open | reviewed | resolved | dismissed);
 *   - hide-content wrote 'in_review', which is what the admin client
 *     (travel-buddy-standalone/app/admin/content-reports.tsx) lists and acts on;
 *     adminMedia's flag/delete on a report wrote 'reviewed', which no admin
 *     screen lists;
 *   - and four admin reads — the reported-trips and reported-events queues, trip
 *     report-resolve, and the event moderate route's report close — asked ONLY
 *     for 'pending'. A report filed through /reports never reached them: trip
 *     report-resolve answered resolvedCount: 0 for every trip, and a moderator
 *     could not clear a real report.
 *
 * The vocabulary is the one the admin client already speaks:
 *   open       filed; nobody has acted (the column default, written by every intake)
 *   in_review  a moderator acted without closing it (hide-content; adminMedia flag/delete)
 *   resolved   closed: upheld / actioned
 *   dismissed  closed: not upheld
 * UNRESOLVED is open and in_review. Only an unresolved report may move; a closed
 * one is never re-resolved, re-dismissed or reopened.
 *
 * No alias is read for 'pending' or 'reviewed': production held no `reports` row
 * on 2026-10-18, so there is no row in either word to strand, and no migration
 * number was available to normalise one on another database.
 */
export const LEGACY_REPORT_STATUSES = ["open", "in_review", "resolved", "dismissed"] as const;
export type LegacyReportStatus = (typeof LEGACY_REPORT_STATUSES)[number];
export const UNRESOLVED_REPORT_STATUSES: readonly LegacyReportStatus[] = ["open", "in_review"];

/**
 * A list read's exact `count`, or null when the answer carried no count a
 * moderator can rely on: not a non-negative safe integer, or smaller than the
 * page it came with. A queue whose total is unknown is refused rather than shown
 * as `count ?? 0`, which paginates the queue down to nothing.
 */
export function exactListCount(count: unknown, rows: unknown): number | null {
  if (!Array.isArray(rows) || typeof count !== "number" || !Number.isSafeInteger(count) || count < rows.length) return null;
  return count;
}
