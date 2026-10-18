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
 * How many OPEN legacy `reports` rows name `userId` as their target — the user
 * detail's `openReports`. The read is the one the route always made, unchanged:
 * a HEAD read with an exact count (Postgres counts, so the row cap does not
 * apply), `target_id = userId`, `status = 'open'`.
 */
export async function countOpenReportsAgainst(sc: any, userId: string): Promise<ModerationCount> {
  if (!sc || !userId) return countUnavailable("no client or user");
  try {
    const res = await sc.from("reports").select("id", { count: "exact", head: true }).eq("target_id", userId).eq("status", "open");
    if (res?.error) return countUnavailable(res.error);
    if (typeof res?.count !== "number" || !Number.isSafeInteger(res.count) || res.count < 0) return countUnavailable("a reports count read answered without its count");
    return { ok: true, count: res.count };
  } catch (err) {
    return countUnavailable(err);
  }
}
