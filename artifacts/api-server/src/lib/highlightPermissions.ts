/**
 * highlightPermissions — THE Highlight access rule. One implementation, no forks.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §23 "Authorization and RLS" names policy FUNCTIONS — canReadMemory,
 *        canEditMemory, canPublishMemory … — precisely so that a surface has one
 *        place where a verdict is reached rather than one per handler.
 *   §12 "Highlights Architecture" — Highlights are audience-specific
 *        projections; the audience predicate is the projection's whole meaning.
 *   §21 "Deletion, Forgetting, and Revocation" — Archive and Delete are
 *        DIFFERENT operations and "must remain separate in both data model and
 *        UX". Both remove a Highlight from normal browsing; only one is
 *        reversible. `isHighlightActive` is where that shows up in code.
 *
 * ── THE FORK THIS FILE EXISTS TO CLOSE (measured 2026-09-08) ────────────────
 * `canEngageHighlight` was exported here with ZERO callers anywhere in the
 * repository, tests included, while every engagement route re-derived its own
 * copy of the rule inline. The two disagreed:
 *
 *   | action | this file said            | routes/highlights.ts did          |
 *   |--------|---------------------------|-----------------------------------|
 *   | like   | owner MAY like their own  | 400 "Cannot like your own …"      |
 *   | reply  | owner MAY reply to own    | 400 "Cannot reply to your own …"  |
 *   | report | owner may NOT report own  | 400 "Cannot report your own …"  ✓ |
 *   | view   | not in the action union   | allowed, owner included           |
 *   | unlike | not in the action union   | allowed, owner included           |
 *
 * WHICH BEHAVIOUR WAS KEPT, AND WHY. The routes'. This is not a product
 * question and was not escalated as one: the helper had never decided anything
 * — no caller, no test — so its permissive answer is not a shipped behaviour
 * that someone chose, it is a stub that was never wired. The refusals in the
 * routes ARE shipped behaviour; adopting the helper's answer would have SILENTLY
 * ADDED self-like and self-reply to a live product. Widening is a product
 * decision, keeping what ships is not. So the helper was corrected to the
 * routes, `view` and `unlike` were added to the union (they were missing, not
 * permitted-by-omission), and every route now calls this function instead of
 * restating it.
 *
 * Similarly `canViewHighlight` had two real callers while GET /highlights/active
 * and GET /highlights/following-feed each carried an inline switch over
 * `visibility`. Those two inline copies had ONE substantive divergence from this
 * function: following-feed had no owner short-circuit, so an owner who follows
 * their own account would not see their own circle_only / trip_only highlight in
 * their own feed while the profile route and the single-highlight gate both show
 * it. Reconciled ONTO this function (owner short-circuit kept) — that is the
 * majority behaviour, the behaviour of the gate in front of every engagement
 * action, and it cannot leak anything: the subject is the viewer's own row.
 *
 * ── NO I/O ─────────────────────────────────────────────────────────────────
 * Still pure. Blocks, circle membership and trip membership are resolved by the
 * caller and passed in, because each has its own fail-closed read shape and
 * mixing them into a predicate would hide which one failed. What this file
 * guarantees is that once those facts are in hand, exactly one rule turns them
 * into a verdict.
 */

export type HighlightVisibility = "public" | "travelers_nearby" | "circle_only" | "trip_only" | "private";

export interface HighlightRecord {
  id: string;
  owner_id: string;
  visibility: HighlightVisibility;
  expires_at: string;
  deleted_at: string | null;
  /**
   * §21 Archive. Present on `public.highlights` since migration 0026 and, until
   * this change, referenced by NO TypeScript in the repository — measured
   * against the committed production snapshot (20260908) and by grep.
   *
   * OPTIONAL on this type on purpose: a caller that does not project the column
   * passes a row without it, and `undefined` means "not asked for", which is
   * NOT "not archived". Reads that must honour archive state project the column
   * explicitly; see `isHighlightActive`.
   */
  archived_at?: string | null;
}

/**
 * Is the highlight in NORMAL BROWSING — i.e. may it appear on a feed, a profile
 * or behind an engagement action?
 *
 * §21's table, applied to this surface:
 *   deleted_at  Delete   — terminal. The row is a tombstone; nothing may reach it.
 *   archived_at Archive  — REVERSIBLE. "Retain … remove from normal browsing
 *                          unless explicitly requested." Retrievable by the
 *                          owner through the explicit archive endpoints, which
 *                          deliberately do not route through this predicate.
 *   expires_at           — §12 lifetime. Expiry is not a user act at all.
 *
 * These three are separate columns answering separate questions and the spec is
 * emphatic that they stay separate. This function is the only place they are
 * collapsed into one boolean, and it is collapsed only for the browsing
 * question.
 */
export function isHighlightActive(h: HighlightRecord, now: Date = new Date()): boolean {
  if (h.deleted_at != null) return false;
  if (h.archived_at != null) return false;
  return new Date(h.expires_at) > now;
}

/**
 * Can `viewerId` view this highlight?
 *
 * Rules (blocks are NOT checked here — callers must exclude blocked users before
 * calling; every caller in routes/highlights.ts does, fail-closed):
 *   - Expired, archived or deleted → never
 *   - Owner → always
 *   - public | travelers_nearby → any authenticated user
 *   - circle_only → viewerId must be in the owner's circle (resolved by caller)
 *   - trip_only → viewerId must share an ACCEPTED trip with the owner (caller)
 *   - private → owner only
 *
 * @param viewerFollowsOwner  True when the viewer is in the owner's circle.
 * @param sharesTrip          True when viewer and owner share an accepted trip.
 * @param now                 Injected for tests; defaults to the wall clock.
 */
export function canViewHighlight(
  viewerId: string,
  h: HighlightRecord,
  opts: {
    viewerFollowsOwner?: boolean;
    sharesTrip?: boolean;
    now?: Date;
  } = {},
): boolean {
  if (!isHighlightActive(h, opts.now ?? new Date())) return false;
  if (viewerId === h.owner_id) return true;

  switch (h.visibility) {
    case "public":
    case "travelers_nearby":
      return true;
    case "circle_only":
      return opts.viewerFollowsOwner === true;
    case "trip_only":
      return opts.sharesTrip === true;
    case "private":
      return false;
    default:
      // An unrecognised visibility is not a permission. A value that arrived
      // from the database and is not in the CHECK constraint means the row or
      // the constraint has drifted; withhold.
      return false;
  }
}

/** The engagement verbs this surface actually exposes. */
export type HighlightEngagement = "view" | "like" | "unlike" | "reply" | "report";

/**
 * Why an engagement was refused. The route maps this to an API error code; the
 * reason is part of the rule, not part of the handler, so two routes cannot
 * refuse the same act for two different stated reasons.
 */
export type HighlightEngagementVerdict =
  | { allowed: true }
  | { allowed: false; reason: "not_visible" }
  | { allowed: false; reason: "own_highlight" };

/**
 * Actions an owner may NOT perform on their own Highlight.
 *
 * `view` and `unlike` are absent deliberately: recording a view of your own
 * Highlight is how the owner's own viewer list stays consistent, and `unlike`
 * is idempotent cleanup — refusing it would strand a like that a widened rule
 * had previously allowed. `like`, `reply` and `report` are the three the routes
 * have always refused.
 */
const OWNER_FORBIDDEN: ReadonlySet<HighlightEngagement> = new Set<HighlightEngagement>([
  "like",
  "reply",
  "report",
]);

/**
 * May `userId` perform `action` on `h`?
 *
 * `viewerCanView` is the OUTPUT of `canViewHighlight` for this same viewer and
 * row — passed rather than recomputed because the caller already holds the
 * block / circle / trip facts and this function must not silently reach a
 * different visibility answer than the gate that ran first.
 *
 * Blocks are NOT checked here.
 */
export function canEngageHighlight(
  userId: string,
  h: HighlightRecord,
  action: HighlightEngagement,
  viewerCanView: boolean,
): HighlightEngagementVerdict {
  if (!viewerCanView) return { allowed: false, reason: "not_visible" };
  if (userId === h.owner_id && OWNER_FORBIDDEN.has(action)) {
    return { allowed: false, reason: "own_highlight" };
  }
  return { allowed: true };
}

/** The message the routes send for an owner-forbidden engagement. */
export function ownHighlightRefusal(action: HighlightEngagement): string {
  switch (action) {
    case "like":
      return "Cannot like your own highlight";
    case "reply":
      return "Cannot reply to your own highlight";
    case "report":
      return "Cannot report your own highlight";
    default:
      return "Cannot perform this action on your own highlight";
  }
}
