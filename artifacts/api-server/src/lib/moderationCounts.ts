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
export function exactListCount(count: unknown, rows: unknown, offset = 0): number | null {
  // `offset` (wave 5): a page past the first holds `offset + rows.length` rows at least; an empty page past the end proves nothing more.
  if (!Array.isArray(rows) || typeof count !== "number" || !Number.isSafeInteger(count) || count < (rows.length > 0 ? offset + rows.length : 0)) return null;
  return count;
}

/**
 * ── THE STATUS FILTER A LEGACY-REPORT LIST MAY BE ASKED FOR (wave 5) ──────
 * GET /admin/media/reported and /admin/media/wrong-place took `status` raw and
 * matched it EXACTLY, defaulting to 'open'. So an in_review report — one a
 * moderator flagged (adminMedia) or whose content was hidden (hide-content), and
 * still unresolved — was in no media tab, and a misspelt status answered an
 * empty queue that read as "nothing reported".
 *
 * A list now asks for one of:
 *   unresolved   open + in_review — the default, the queue a moderator works
 *   all          no status filter
 *   <a word>     one word of LEGACY_REPORT_STATUSES
 * Anything else is refused by name (`ok: false`), never answered with an empty page.
 */
export const LEGACY_REPORT_LIST_FILTERS = ["unresolved", "all", ...LEGACY_REPORT_STATUSES] as const;
export type LegacyReportStatusFilter =
  | { readonly ok: true; readonly statuses: readonly LegacyReportStatus[] | null }
  | { readonly ok: false; readonly message: string };

export function parseLegacyReportStatusFilter(raw: unknown): LegacyReportStatusFilter {
  if (raw === undefined || raw === "" || raw === "unresolved") return { ok: true, statuses: UNRESOLVED_REPORT_STATUSES };
  if (raw === "all") return { ok: true, statuses: null };
  if (typeof raw === "string" && (LEGACY_REPORT_STATUSES as readonly string[]).includes(raw)) return { ok: true, statuses: [raw as LegacyReportStatus] };
  return { ok: false, message: `Unknown status '${typeof raw === "string" ? raw : JSON.stringify(raw)}'. One of: ${LEGACY_REPORT_LIST_FILTERS.join(", ")}` };
}

/** The refusal a paged admin list answers when exactListCount is null: named, never a page that reads as the whole queue. */
export function listTotalRefusal(list: string): string {
  return `The ${list} list answered without an exact total. A page with no total is not served: it would hide every item past it. Retry.`;
}

/**
 * ── Promise.allSettled ELEMENTS (wave 5, the Compass admin dashboard) ──────
 * A dashboard that reads many tables at once with Promise.allSettled folded
 * every element with `status === "fulfilled" ? data ?? [] : []` and
 * `count ?? 0`. So a rejected read, a read that answered an error (supabase-js
 * RESOLVES those, so they arrive "fulfilled"), and a read that answered no list
 * or no count all rendered as zero abuse flags, zero safety-filter fires, zero
 * pending posts. These answer null in every one of those cases — never [] or 0
 * — so the caller can name the section and refuse.
 */
export function settledRows(r: PromiseSettledResult<unknown>): any[] | null {
  if (r.status !== "fulfilled") return null;
  const v = r.value as { data?: unknown; error?: unknown } | null | undefined;
  return v && !v.error && Array.isArray(v.data) ? v.data : null;
}

export function settledCount(r: PromiseSettledResult<unknown>): number | null {
  if (r.status !== "fulfilled") return null;
  const v = r.value as { count?: unknown; error?: unknown } | null | undefined;
  return v && !v.error && typeof v.count === "number" && Number.isSafeInteger(v.count) && v.count >= 0 ? v.count : null;
}
