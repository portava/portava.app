/**
 * contentOwner — resolve the user accountable for a piece of reportable content.
 *
 * WHY THIS EXISTS
 * ---------------
 * `moderation_actions.target_user_id` is `NOT NULL REFERENCES profiles(id)`
 * (migration 0063). Every moderation audit row must therefore name a *user*.
 * But reports are filed against content — a post, a trip, a message — and
 * `reports.target_id` holds the CONTENT id. Writing that straight into
 * `target_user_id` violates the foreign key, the insert fails, and because the
 * audit is fail-closed the whole endpoint 500s before the report is resolved.
 *
 * Confirmed live 2026-08-09:
 *   moderation_actions_target_user_id_fkey
 *     FOREIGN KEY (target_user_id) REFERENCES profiles(id) ON DELETE CASCADE
 *
 * Before this module there were THREE different owner-resolution rules:
 *
 *   1. `resolveSubjectUserId` in routes/moderation.ts — 9 subject types,
 *      returns null when unknown. Used at report intake.
 *   2. An inline block in `/admin/reports/:id/hide-content` — 3 types only,
 *      falling back to the ADMIN's own id when the owner could not be found.
 *      That satisfies the FK but records a lie: the admin becomes the target
 *      of their own moderation action.
 *   3. An inline `post_media.user_id` read in routes/adminMedia.ts.
 *
 * And two endpoints (`/admin/reports/:id/resolve` and `/dismiss`) had no rule
 * at all — they passed the content id through and were the ones that 500'd.
 *
 * One rule now. The type vocabulary is the union of `reports.target_type` and
 * `moderation_reports.subject_type`, which are not the same set.
 *
 * A null return means "no accountable user", and callers must NOT invent one.
 * `place` is unowned by design; anything else returning null means the content
 * row is gone. Neither can honestly be attributed to a person.
 */

/** Union of reports.target_type and moderation_reports.subject_type, plus internal kinds. */
export type ContentEntityType =
  | "user" | "profile"
  | "post" | "post_media" | "comment"
  | "message" | "thread"
  | "trip" | "event"
  | "review" | "media" | "buddy_listing"
  | "hidden_gem" | "place"
  | (string & {});

/**
 * The user accountable for `entityId`, or null when there is none.
 *
 * Never throws: a lookup failure is indistinguishable from "not found" for the
 * caller's purposes, and this sits in front of audit writes that must not be
 * the thing that breaks a moderation action.
 */
export async function resolveContentOwner(
  sc: any,
  entityType: ContentEntityType,
  entityId: string,
): Promise<string | null> {
  if (!entityId) return null;

  // (table, column) pairs where the owner is a plain column lookup by id.
  const SIMPLE: Record<string, [table: string, column: string]> = {
    post:        ["posts",           "author_id"],
    post_media:  ["post_media",      "user_id"],
    comment:     ["posts_comments",  "user_id"],
    message:     ["messages",        "sender_id"],
    thread:      ["message_threads", "created_by"],
    trip:        ["trips",           "owner_id"],
    event:       ["events",          "host_id"],
    review:      ["reviews",         "reviewer_id"],
    media:       ["media_assets",    "owner_user_id"],
    hidden_gem:  ["hidden_gems",     "submitted_by"],
  };

  try {
    // The id IS the user.
    if (entityType === "user" || entityType === "profile") return entityId;

    // Canonical places belong to no one.
    if (entityType === "place") return null;

    const simple = SIMPLE[entityType];
    if (simple) {
      const [table, column] = simple;
      const { data } = await sc.from(table).select(column).eq("id", entityId).maybeSingle();
      return (data as any)?.[column] ?? null;
    }

    if (entityType === "buddy_listing") {
      // Preserves the two-step lookup from routes/moderation.ts: the id may be
      // the listing row's id, or the user id directly.
      const { data } = await sc
        .from("rent_buddy_profiles").select("user_id").eq("id", entityId).maybeSingle();
      if ((data as any)?.user_id) return (data as any).user_id;
      const { data: byUser } = await sc
        .from("rent_buddy_profiles").select("user_id").eq("user_id", entityId).maybeSingle();
      return (byUser as any)?.user_id ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * The `metadata` payload for a moderation_actions row.
 *
 * `moderation_actions` records only a target USER — there is no column for the
 * content item, and none for the report that prompted the action. So an action
 * cannot currently be traced back to the complaint that caused it, which is
 * exactly what "restrict based on complaints" needs to be able to evidence.
 *
 * `metadata jsonb` (added by migration 0164 and never used) carries both,
 * without a migration.
 */
export interface ModerationMetadata {
  /** The report this action answers, when there is one. */
  report_id?: string | null;
  /** The content the report named — NOT the same as target_user_id. */
  target_type?: string | null;
  target_id?: string | null;
  /** True when no accountable user could be resolved (see resolveContentOwner). */
  owner_unresolved?: boolean;
  [k: string]: unknown;
}
