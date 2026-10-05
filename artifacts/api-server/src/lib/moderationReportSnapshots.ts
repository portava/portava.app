/**
 * moderationReportSnapshots — what a moderator is shown about the thing a
 * `moderation_reports` row names (census-trust TV-4a, "view subject content
 * snapshot").
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `GET /admin/moderation/reports` enriched only `place` reports. A reported
 * post, comment, message, event, review, buddy listing, media item or user
 * arrived as a bare UUID, so a moderator could not judge a report without
 * leaving the queue — and the one enrichment that existed discarded its read
 * error, so an unreadable `places` table showed every place report with no
 * name, as if the place had none.
 *
 * ── THREE STATES, NEVER TWO ─────────────────────────────────────────────────
 * Every subject gets exactly one of:
 *   ok           the row was read; the fields below are what it says now;
 *   not_found    the read ran and the row is gone (deleted content is a real,
 *                common answer for a report — say it);
 *   unavailable  the read FAILED. Not a fact about the content: a moderator
 *                must not dismiss a report because its snapshot looked empty.
 *   unsupported  a subject type this module has no reader for.
 * A failed read is reported for every row of that type, and reads are batched
 * per subject type (one query per type per page, never one per report).
 *
 * ── WHAT IS SHOWN, AND WHAT IS NOT ──────────────────────────────────────────
 * The minimum a moderator needs to judge the report: the text (truncated to
 * SNAPSHOT_EXCERPT_CHARS), who is accountable for it, and whether it has since
 * been deleted. Never a coordinate, never an email or phone, never media URLs.
 * A DELETED message or comment shows no text: the author removed it, and the
 * report row still carries the reporter's own `details`.
 *
 * Columns are the schema's (baseline 20260819 + migrations), not the generated
 * types: posts.content/author_id/deleted_at, posts_comments.body/user_id/
 * deleted_at, messages.body/sender_id/deleted_at, events.title/host_id/
 * starts_at/city/state, reviews.body/rating/reviewer_id/entity_type/state,
 * rent_buddy_profiles.display_name/tagline/user_id/status, media_assets.
 * media_type/caption/owner_user_id/moderation_status, profiles.name/handle/
 * account_status, places.name/address.
 */

export const SNAPSHOT_EXCERPT_CHARS = 280;

/** moderation_reports.category CHECK (baseline 20260819; 2029 widened it). */
export const MODERATION_REPORT_CATEGORIES = [
  "impersonation", "harassment", "scam_fraud", "inappropriate_content", "safety_concern",
  "underage", "spam", "other", "wrong_place", "wrong_photo", "duplicate", "closed",
  "incorrect_address", "incorrect_category", "outdated_image",
] as const;

/** moderation_reports.status CHECK. */
export const MODERATION_REPORT_STATUSES = ["open", "reviewing", "actioned", "dismissed"] as const;
export type ModerationReportStatus = (typeof MODERATION_REPORT_STATUSES)[number];

/** Which status a moderator may move a report to, from which. Terminal states move nowhere. */
export const MODERATION_REPORT_TRANSITIONS: Readonly<Record<ModerationReportStatus, readonly ModerationReportStatus[]>> = {
  open: ["reviewing", "actioned", "dismissed"],
  reviewing: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export type SubjectSnapshot =
  | ({ state: "ok" } & Record<string, unknown>)
  | { state: "not_found" }
  | { state: "unavailable" }
  | { state: "unsupported" };

interface ReportLike { id: string; subject_type: string; subject_id: string | null }

function excerpt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > SNAPSHOT_EXCERPT_CHARS ? `${t.slice(0, SNAPSHOT_EXCERPT_CHARS - 1)}…` : t;
}

interface Reader {
  table: string;
  select: string;
  /** The column the subject_id is matched against. */
  key: string;
  shape: (row: any) => Record<string, unknown>;
}

const READERS: Readonly<Record<string, Reader>> = {
  user: {
    table: "profiles", select: "id, name, handle, account_status", key: "id",
    shape: (r) => ({ name: r.name ?? null, handle: r.handle ?? null, accountStatus: r.account_status ?? null, accountableUserId: r.id }),
  },
  post: {
    table: "posts", select: "id, author_id, content, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.content), createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.author_id ?? null }),
  },
  comment: {
    table: "posts_comments", select: "id, post_id, user_id, body, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.body), postId: r.post_id ?? null, createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.user_id ?? null }),
  },
  message: {
    table: "messages", select: "id, thread_id, sender_id, body, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.body), threadId: r.thread_id ?? null, createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.sender_id ?? null }),
  },
  event: {
    table: "events", select: "id, host_id, title, starts_at, city, state", key: "id",
    shape: (r) => ({ title: excerpt(r.title), startsAt: r.starts_at ?? null, city: r.city ?? null, eventState: r.state ?? null, accountableUserId: r.host_id ?? null }),
  },
  review: {
    table: "reviews", select: "id, reviewer_id, entity_type, entity_id, rating, body, state", key: "id",
    shape: (r) => ({ excerpt: excerpt(r.body), rating: r.rating ?? null, reviewedEntityType: r.entity_type ?? null, reviewedEntityId: r.entity_id ?? null, reviewState: r.state ?? null, accountableUserId: r.reviewer_id ?? null }),
  },
  buddy_listing: {
    table: "rent_buddy_profiles", select: "id, user_id, display_name, tagline, status", key: "id",
    shape: (r) => ({ displayName: r.display_name ?? null, tagline: excerpt(r.tagline), listingStatus: r.status ?? null, accountableUserId: r.user_id ?? null }),
  },
  media: {
    table: "media_assets", select: "id, owner_user_id, media_type, caption, moderation_status", key: "id",
    shape: (r) => ({ mediaType: r.media_type ?? null, caption: excerpt(r.caption), moderationStatus: r.moderation_status ?? null, accountableUserId: r.owner_user_id ?? null }),
  },
  place: {
    table: "places", select: "id, name, address", key: "id",
    shape: (r) => ({ name: r.name ?? null, address: r.address ?? null, accountableUserId: null }),
  },
};

export const SNAPSHOT_SUBJECT_TYPES: readonly string[] = Object.freeze(Object.keys(READERS));

/**
 * One snapshot per report id. Never throws; a failed read becomes
 * `unavailable` for that subject type and is returned in `failedTypes` so the
 * route can say the page is incomplete.
 */
export async function loadModerationSubjectSnapshots(
  sc: any,
  reports: readonly ReportLike[],
): Promise<{ snapshots: Map<string, SubjectSnapshot>; failedTypes: string[] }> {
  const snapshots = new Map<string, SubjectSnapshot>();
  const failedTypes: string[] = [];
  const byType = new Map<string, ReportLike[]>();
  for (const r of reports) {
    if (!READERS[r.subject_type]) { snapshots.set(r.id, { state: "unsupported" }); continue; }
    if (!r.subject_id) { snapshots.set(r.id, { state: "not_found" }); continue; }
    const list = byType.get(r.subject_type) ?? [];
    list.push(r);
    byType.set(r.subject_type, list);
  }

  for (const [type, list] of byType) {
    const reader = READERS[type]!;
    const ids = [...new Set(list.map((r) => r.subject_id as string))];
    let rows: any[] | null = null;
    try {
      const { data, error } = await sc.from(reader.table).select(reader.select).in(reader.key, ids);
      if (!error) rows = (data ?? []) as any[];
    } catch {
      rows = null;
    }
    // buddy_listing: a subject id may name the listing row OR its user
    // (lib/contentOwner.ts keeps the same two-step). Only ids the first read
    // did not find are tried again, and a failed second read fails the type.
    if (rows && type === "buddy_listing") {
      const found = new Set(rows.map((r) => String(r.id)));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        try {
          const { data, error } = await sc.from(reader.table).select(reader.select).in("user_id", missing);
          if (error) rows = null;
          else rows = [...rows, ...((data ?? []) as any[]).map((r) => ({ ...r, __matchedBy: String(r.user_id) }))];
        } catch {
          rows = null;
        }
      }
    }
    if (!rows) {
      failedTypes.push(type);
      for (const r of list) snapshots.set(r.id, { state: "unavailable" });
      continue;
    }
    const index = new Map<string, any>();
    for (const row of rows) index.set(String(row.__matchedBy ?? row[reader.key]), row);
    for (const r of list) {
      const row = index.get(String(r.subject_id));
      snapshots.set(r.id, row ? { state: "ok", ...reader.shape(row) } : { state: "not_found" });
    }
  }
  return { snapshots, failedTypes };
}
