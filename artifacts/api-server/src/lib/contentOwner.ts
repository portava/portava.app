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
 *
 * ── WHY A THIRD MEANING OF null WAS A DEFECT, AND WHAT CHANGED ─────────────
 * There is a third way this used to return null, and it was invisible.
 * supabase-js RESOLVES on a database error — it does not throw — so
 * `const { data } = await …` binds `data: null` for an unreadable table exactly
 * as it does for a row that is not there. The `try/catch` below never fired for
 * it. So "this content has no owner" and "I could not look the owner up"
 * arrived at every caller as the same value, with nothing logged anywhere:
 *
 *   • routes/moderation.ts intake wrote `subject_user_id: null` and logged
 *     "the content row is missing OR the owner lookup failed" — it could not
 *     tell which, because this function had not told it.
 *   • lib/moderationAudit.ts set `metadata.owner_unresolved = true`, a claim
 *     recorded into the audit trail as a FACT about the content.
 *   • routes/adminMedia.ts skips the audit row entirely on a null owner —
 *     silently, with no log — after the content status change has already been
 *     committed. A moderation action with no audit row, because a lookup
 *     blinked, and nobody is told.
 *
 * The DIRECTION stays as it was, deliberately: this sits in front of audit
 * writes and a report-intake path where refusing loses the report, and both
 * call sites document that a null must not fail the action. What changes is
 * that the failure is now OBSERVED — every read checks `.error`, logs it, and
 * `resolveContentOwnerDetailed` reports `outcome: "lookup_failed"` so a caller
 * can record and answer the truth instead of a plausible-looking fact.
 *
 * FOLLOW-UP (not this module's file to change): moderationAudit.ts should carry
 * `owner_lookup_failed` into `ModerationMetadata` — the field is declared below
 * — and adminMedia.ts should log its skipped audit rather than dropping them.
 */

import { logger } from "./logger.js";

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
 * Why a null was returned. `resolveContentOwner` collapses all four to
 * `string | null`; `resolveContentOwnerDetailed` keeps them apart.
 *
 *   resolved      an accountable user was found.
 *   unowned       `place` — unowned BY DESIGN, and not a failure of any kind.
 *   not_found     the lookup ran and the content row is not there.
 *   unknown_type  the entity type has no owner rule in this module.
 *   lookup_failed the lookup could not run. NOT a fact about the content.
 */
export type ContentOwnerOutcome =
  | "resolved"
  | "unowned"
  | "not_found"
  | "unknown_type"
  | "lookup_failed";

export interface ContentOwnerResolution {
  ownerUserId: string | null;
  outcome: ContentOwnerOutcome;
  /** The resolved PostgREST error, when `outcome` is "lookup_failed". */
  error?: unknown;
}

/** (table, column) pairs where the owner is a plain column lookup by id. */
const SIMPLE_OWNER_COLUMNS: Readonly<Record<string, [table: string, column: string]>> = {
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

/**
 * The user accountable for `entityId`, WITH the reason when there is none.
 *
 * Never throws, for the same reason `resolveContentOwner` does not: this sits
 * in front of audit writes and a report-intake path that must not be broken by
 * an owner lookup. It differs only in telling the truth about why it answered
 * null — see the "third meaning of null" note in the module header.
 */
export async function resolveContentOwnerDetailed(
  sc: any,
  entityType: ContentEntityType,
  entityId: string,
): Promise<ContentOwnerResolution> {
  if (!entityId) return { ownerUserId: null, outcome: "not_found" };

  /** One owner read. `.error` is the ONLY failure signal — supabase-js resolves. */
  const readOwner = async (
    table: string,
    column: string,
    filterColumn: string,
  ): Promise<ContentOwnerResolution> => {
    const { data, error } = await sc
      .from(table).select(column).eq(filterColumn, entityId).maybeSingle();
    if (error) {
      logger.error(
        { err: error, table, column, filterColumn, entityType, entityId },
        "contentOwner: owner lookup FAILED — the caller is told 'no accountable user', " +
          "which is not a fact about this content; see outcome lookup_failed",
      );
      return { ownerUserId: null, outcome: "lookup_failed", error };
    }
    const owner = (data as any)?.[column] ?? null;
    return owner
      ? { ownerUserId: owner as string, outcome: "resolved" }
      : { ownerUserId: null, outcome: "not_found" };
  };

  try {
    // The id IS the user.
    if (entityType === "user" || entityType === "profile") {
      return { ownerUserId: entityId, outcome: "resolved" };
    }

    // Canonical places belong to no one.
    if (entityType === "place") return { ownerUserId: null, outcome: "unowned" };

    const simple = SIMPLE_OWNER_COLUMNS[entityType];
    if (simple) {
      const [table, column] = simple;
      return await readOwner(table, column, "id");
    }

    if (entityType === "buddy_listing") {
      // Preserves the two-step lookup from routes/moderation.ts: the id may be
      // the listing row's id, or the user id directly. A FAILED first read must
      // not fall through to the second and report the second's "not found" as
      // the answer — that would launder an outage into a fact.
      const byListing = await readOwner("rent_buddy_profiles", "user_id", "id");
      if (byListing.outcome !== "not_found") return byListing;
      return await readOwner("rent_buddy_profiles", "user_id", "user_id");
    }

    return { ownerUserId: null, outcome: "unknown_type" };
  } catch (err) {
    // Not the PostgREST error path (that resolves and is handled above); this
    // catches a client that is not a query builder at all.
    logger.error({ err, entityType, entityId }, "contentOwner: owner lookup threw");
    return { ownerUserId: null, outcome: "lookup_failed", error: err };
  }
}

/**
 * The user accountable for `entityId`, or null when there is none.
 *
 * Never throws: this sits in front of audit writes that must not be the thing
 * that breaks a moderation action.
 *
 * A null still collapses "unowned", "not found" and "could not look up" into
 * one value — that is the shape every existing caller is written against, and
 * changing it here would change the direction rather than the honesty. A caller
 * that needs to tell them apart calls `resolveContentOwnerDetailed`; either way
 * the failure is now logged rather than swallowed.
 */
export async function resolveContentOwner(
  sc: any,
  entityType: ContentEntityType,
  entityId: string,
): Promise<string | null> {
  return (await resolveContentOwnerDetailed(sc, entityType, entityId)).ownerUserId;
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
  /**
   * True when the owner lookup could not RUN (`outcome: "lookup_failed"`), as
   * opposed to running and finding nothing. `owner_unresolved` alone reads as a
   * fact about the content; this says the audit row is missing a subject
   * because the database was unreadable, which is an operations event.
   */
  owner_lookup_failed?: boolean;
  [k: string]: unknown;
}
