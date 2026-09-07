/**
 * Admin Featured by Portava routes
 *
 * Role-gated (profiles.role = 'admin' required).
 *
 *   POST   /admin/featured/shortlist         — AI-assisted shortlisting per category
 *   GET    /admin/featured                   — list all featured items with status
 *   POST   /admin/featured/approve/:postId   — approve a post for featuring
 *   POST   /admin/featured/revoke/:postId    — revoke a pending/live feature
 *   DELETE /admin/featured/:id              — hard-remove a feature record
 *
 * Permission flow:
 *   Non-video posts → immediately set to 'live' + increment featured_count.
 *   Video posts (primary_media_type = 'video') authored by someone other than
 *   @portava → set to 'pending_permission' and send a creator notification.
 *
 *   When the creator accepts via the notification action, the caller is
 *   expected to hit POST /admin/featured/accept-permission/:postId (handled
 *   by a notification action handler below).
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { rankCandidates, type RankCandidate, type ViewerContext } from "../lib/portavaRank.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { logger as rootLogger } from "../lib/logger.js";

const router = Router();

const logger = rootLogger.child({ route: "adminFeatured" });

// ── featured_count: the atomic counter writer ────────────────────────────────
//
// WHY THIS EXISTS
// ---------------
// All four sites below used to move `profiles.featured_count` with a
// read-modify-write across two round trips — select the current value, then
// `update({ featured_count: current + 1 })`. supabase-js issues each statement
// in its own implicit transaction, so two admins featuring two different posts
// by the same author interleave as read(3)/read(3)/write(4)/write(4): two
// features, one increment. The decrement sites are worse, because
// `Math.max(0, current - 1)` clamps against a value another writer may already
// have moved, so the counter drifts in both directions and never self-corrects
// — nothing anywhere recounts it from `portava_featured`.
//
// `.agents/memory/counter-update-atomicity.md` records this exact pattern as
// REJECTED in completion review and names the required form, which is what
// migration 2331 creates: a SECURITY DEFINER SQL function with a column
// allowlist and `GREATEST(0, col + delta)`, granted to service_role only. One
// UPDATE statement is atomic under Postgres row locking, so N concurrent
// adjustments land exactly N.
//
// WHY THE FALLBACK IS KEPT
// ------------------------
// Same reason `services/rentBuddy/ReliabilityCounters.ts` keeps one: the RPC is
// absent until 2331 is applied out-of-band (docs/architecture/12 §5.2 —
// migrations land BEFORE the PR that adds them can go green), and the route
// suites drive this router through partial fake clients that implement `from`
// and not `rpc`. The fallback is the OLD, lossy path and is documented as such;
// it is correct on the single-request path and it is not what production runs
// once the function exists.

/** The columns migration 2331's allowlist admits. Keep in step with its IN-list. */
export type ProfileCounterColumn = "featured_count";

/** The SECURITY DEFINER writer created by migration 2331. */
export const PROFILE_COUNTER_RPC = "portava_adjust_profile_counter";

/**
 * Adjust an allowlisted `profiles` counter by `delta`, clamped at >= 0.
 *
 * Best-effort by design — a counter update must never fail an admin's feature
 * or revoke — but never SILENT: every path that fails to move the counter logs
 * why, because a featured post whose author's count did not move is invisible
 * otherwise.
 */
export async function adjustProfileCounter(
  sc:      any,
  userId:  string,
  column:  ProfileCounterColumn,
  delta:   number,
): Promise<void> {
  if (!sc || !userId || !delta) return;

  // Preferred path: one atomic statement, DB-side.
  if (typeof sc.rpc === "function") {
    try {
      // supabase-js RESOLVES on a failed query — the failure exists only in
      // `error`, so this destructure is the whole difference between a lost
      // increment we know about and one we do not.
      const { data, error } = await sc.rpc(PROFILE_COUNTER_RPC, {
        p_user_id: userId,
        p_column:  column,
        p_delta:   delta,
      });
      if (!error) {
        // NULL means the UPDATE matched no profile row (author deleted between
        // the post read and here). Not a failure of the RPC — but not a counted
        // adjustment either, so it is said out loud rather than inferred.
        if (data === null || data === undefined) {
          logger.warn({ userId, column, delta }, "featured counter: no profile row matched");
        }
        return;
      }
      logger.warn(
        { err: error, userId, column, delta },
        "featured counter: atomic RPC unavailable — falling back to read-modify-write",
      );
    } catch (err) {
      logger.warn({ err, userId, column, delta }, "featured counter: atomic RPC threw — falling back");
    }
  }

  // Fallback: read-modify-write. LOSSY UNDER CONCURRENCY — this is the pattern
  // 2331 exists to replace. It runs only where the RPC is absent (before the
  // migration is applied, or under a partial test client).
  try {
    const { data: profileRow, error: readErr } = await sc
      .from("profiles")
      .select(column)
      .eq("id", userId)
      .maybeSingle();
    // Do not write a bogus count off a failed read: an unreadable profile row
    // and a profile row holding 0 are different facts, and `?? 0` used to make
    // them the same one — a failed read would have RESET the counter to 1.
    if (readErr) {
      logger.warn({ err: readErr, userId, column }, "featured counter: profile read failed — counter not moved");
      return;
    }
    if (!profileRow) {
      logger.warn({ userId, column, delta }, "featured counter: no profile row matched");
      return;
    }
    const current = Number((profileRow as any)[column] ?? 0);
    const next    = Math.max(0, current + delta);
    const { error: writeErr } = await sc
      .from("profiles")
      .update({ [column]: next })
      .eq("id", userId);
    if (writeErr) {
      logger.warn({ err: writeErr, userId, column, delta }, "featured counter: update failed");
    }
  } catch (err) {
    logger.warn({ err, userId, column, delta }, "featured counter: read-modify-write threw");
  }
}

// ── Category → content signal mapping ────────────────────────────────────────

const PORTAVA_FEATURED_CATEGORY = [
  "best_video",
  "best_hidden_gem",
  "best_nightlife",
  "best_restaurant",
  "best_adventure",
  "best_photo",
] as const;

type FeaturedCategory = typeof PORTAVA_FEATURED_CATEGORY[number];

/**
 * Returns the content signal filters for each category so we can narrow
 * candidate posts before scoring.
 */
function categoryFilters(category: FeaturedCategory): {
  mediaType?: string;
  categories?: string[];
  tags?: string[];
} {
  switch (category) {
    case "best_video":
      return { mediaType: "video" };
    case "best_hidden_gem":
      return { categories: ["hidden_gem", "gems", "gem"], tags: ["hiddengem", "hiddenplace", "secretspot"] };
    case "best_nightlife":
      return { categories: ["nightlife", "party", "bar", "club"], tags: ["nightlife", "party", "bar", "club"] };
    case "best_restaurant":
      return { categories: ["food", "restaurant", "dining", "cafe"], tags: ["food", "restaurant", "foodie", "dining"] };
    case "best_adventure":
      return { categories: ["adventure", "outdoor", "sports", "hiking"], tags: ["adventure", "hiking", "outdoors", "nature"] };
    case "best_photo":
      return { mediaType: "image" };
  }
}

// ── POST /admin/featured/shortlist ────────────────────────────────────────────

/**
 * Trigger AI shortlisting for all 6 categories.
 * For each category, selects top candidate posts from the past 7 days,
 * scores them using portavaRank signals + media engagement metrics,
 * and returns the top 5 per category with rationale snippets.
 *
 * No LLM call — purely ranking-signal derived (§ task spec).
 */
router.post("/admin/featured/shortlist", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const nowMs = Date.now();
  const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
  const TOP_N = 5;

  const shortlist: Record<string, any[]> = {};

  await Promise.all(
    PORTAVA_FEATURED_CATEGORY.map(async (category) => {
      const filters = categoryFilters(category);

      // Base query: active posts from last 7 days with basic stats
      let query = sc
        .from("posts")
        .select(
          "id, author_id, content, category, media_urls, primary_media_type, has_video, " +
          "location_city, created_at, like_count, save_count, " +
          "post_status, status",
        )
        .eq("status", "active")
        .eq("post_status", "published")
        .gte("created_at", sevenDaysAgo)
        .limit(100);

      // Filter by media type when the category requires it
      if (filters.mediaType === "video") {
        query = query.eq("has_video", true);
      } else if (filters.mediaType === "image") {
        query = query.eq("has_video", false);
      }

      // Filter by category when applicable (partial match — posts may not
      // always be well-categorized, so we check tags too via OR logic)
      if (filters.categories && filters.categories.length > 0) {
        query = query.in("category", filters.categories);
      }

      const { data: posts, error } = await query;
      if (error || !posts || posts.length === 0) {
        shortlist[category] = [];
        return;
      }

      // Build RankCandidates for scoring
      const candidates: RankCandidate[] = (posts as any[]).map((p) => ({
        id:           p.id,
        kind:         "post" as const,
        createdAt:    p.created_at,
        city:         p.location_city ?? null,
        authorId:     p.author_id,
        category:     p.category ?? null,
        likeCount:    p.like_count ?? 0,
        joinCount:    p.save_count ?? 0,   // saves act like joins for posts
      }));

      // Use a neutral viewer context (no personalization — editorial signal)
      const viewerCtx: ViewerContext = {
        userId: "admin-shortlist",
        nowMs: Date.now(),
      };

      const ranked = rankCandidates(candidates, viewerCtx, {
        diversity: { authorPenalty: 0.5, window: 3 },
        exploration: false,
      });

      const top = ranked.slice(0, TOP_N);

      // Build rationale snippets from top feature contributions
      shortlist[category] = top.map((r) => {
        const topFeatures = Object.entries(r.features)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([k]) => k);

        const post = (posts as any[]).find((p) => p.id === r.candidate.id);
        return {
          postId:    r.candidate.id,
          score:     Math.round(r.score * 1000) / 1000,
          rationale: topFeatures,
          authorId:  r.candidate.authorId,
          city:      r.candidate.city,
          likeCount: r.candidate.likeCount ?? 0,
          saveCount: (post?.save_count ?? 0),
          content:   post?.content ? (post.content as string).slice(0, 120) : null,
          createdAt: r.candidate.createdAt ?? null,
        };
      });
    }),
  );

  res.json({ shortlist, generatedAt: new Date(nowMs).toISOString() });
}));

// ── GET /admin/featured ───────────────────────────────────────────────────────

router.get("/admin/featured", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const status = req.query.status as string | undefined;

  let query = sc
    .from("portava_featured")
    .select(
      "id, post_id, category, featured_at, approved_by, status, " +
      "creator_permission_requested_at, creator_permission_granted_at, created_at, " +
      "posts!inner(id, content, author_id, primary_media_type, location_city, created_at, like_count, save_count)",
      { count: "exact" },
    )
    .order("featured_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;

  if (error) { sendError(res, "db_error", error.message); return; }

  const items = (data ?? []).map((row: any) => ({
    id:                          row.id,
    postId:                      row.post_id,
    category:                    row.category,
    featuredAt:                  row.featured_at,
    approvedBy:                  row.approved_by,
    status:                      row.status,
    creatorPermissionRequestedAt: row.creator_permission_requested_at,
    creatorPermissionGrantedAt:  row.creator_permission_granted_at,
    createdAt:                   row.created_at,
    post: row.posts
      ? {
          id:              (row.posts as any).id,
          content:         (row.posts as any).content?.slice(0, 120) ?? null,
          authorId:        (row.posts as any).author_id,
          primaryMediaType: (row.posts as any).primary_media_type ?? null,
          city:            (row.posts as any).location_city ?? null,
          likeCount:       (row.posts as any).like_count ?? 0,
          saveCount:       (row.posts as any).save_count ?? 0,
        }
      : null,
  }));

  res.json({ items, total: count ?? 0, page });
}));

// ── POST /admin/featured/approve/:postId ──────────────────────────────────────

const ApproveSchema = z.object({
  category: z.enum(PORTAVA_FEATURED_CATEGORY),
});

router.post("/admin/featured/approve/:postId", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;

  const { postId } = req.params;

  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { category } = parsed.data;

  // Load the post to determine video + authorship
  const { data: post, error: postErr } = await sc
    .from("posts")
    .select("id, author_id, primary_media_type, has_video, status, post_status")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (postErr) { sendError(res, "db_error", postErr.message); return; }
  if (!post)  { sendError(res, "not_found", "Post not found"); return; }

  // Load any existing featured row for this (post_id, category) pair.
  // This prevents double-incrementing featured_count when the admin re-approves
  // a row that is already live (idempotency guard).
  const { data: existingFeatured } = await sc
    .from("portava_featured")
    .select("id, status")
    .eq("post_id", postId)
    .eq("category", category)
    .maybeSingle();

  const wasAlreadyLive = (existingFeatured as any)?.status === "live";

  // If already live, return the existing row unchanged — no side-effects.
  if (wasAlreadyLive) {
    res.status(200).json({
      featured: existingFeatured,
      needsPermission: false,
      status: "live",
      idempotent: true,
    });
    return;
  }

  // Determine whether we need creator permission
  const isVideo = (post as any).has_video || (post as any).primary_media_type === "video";

  // Resolve @portava's user id to exempt own-account videos
  let portavaUserId: string | null = null;
  if (isVideo) {
    const { data: portavaProfile } = await sc
      .from("profiles")
      .select("id")
      .eq("handle", "portava")
      .maybeSingle();
    portavaUserId = portavaProfile ? (portavaProfile as any).id : null;
  }

  const needsPermission = isVideo && (post as any).author_id !== portavaUserId;
  const now = new Date().toISOString();
  const initialStatus = needsPermission ? "pending_permission" : "live";

  // Upsert (handles new rows and re-approving previously declined/pending rows).
  // Safe: we already returned early when the row was live, so the count below
  // will increment at most once per (post_id, category) pair.
  const { data: featured, error: insertErr } = await sc
    .from("portava_featured")
    .upsert(
      {
        post_id:                         postId,
        category,
        featured_at:                     now,
        approved_by:                     adminUserId,
        status:                          initialStatus,
        creator_permission_requested_at: needsPermission ? now : null,
        creator_permission_granted_at:   null,
      },
      { onConflict: "post_id,category" },
    )
    .select()
    .single();

  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  // Increment featured_count when transitioning to live immediately.
  // (The wasAlreadyLive guard above ensures this runs at most once per
  // (post_id, category) pair regardless of how many times approve is called.)
  if (initialStatus === "live") {
    await adjustProfileCounter(sc, (post as any).author_id, "featured_count", +1);
  }

  // Send creator-permission notification via NotificationService (privacy guard +
  // dedup + proper channel routing — never raw-insert into notifications).
  if (needsPermission) {
    const categoryLabel = category.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const notifSvc    = new NotificationService(sc);
    const notifRouter = new NotifRouter(sc);
    const notifRow = await notifSvc.create({
      userId:     (post as any).author_id,
      eventType:  "featured.permission_request",
      params:     { categoryLabel, postId },
      sourceType: "portava_featured",
      sourceId:   (featured as any).id,
      metadata:   { featuredId: (featured as any).id, postId, category },
    });
    if (notifRow) void notifRouter.route(notifRow).catch(() => {});
  }

  res.status(201).json({
    featured,
    needsPermission,
    status: initialStatus,
  });
}));

// ── POST /admin/featured/accept-permission/:postId ────────────────────────────
// Called when the creator taps "Accept" on the permission notification.
// Accepts optional `featuredId` or `category` in the body to disambiguate when
// the same post has multiple pending_permission rows (one per category).
// The notification metadata always carries both fields, so the mobile CTA can
// include them without any extra work.

const PermissionActionSchema = z.object({
  /** Primary-key disambiguation — most precise, preferred when available. */
  featuredId: z.string().uuid().optional(),
  /** Category disambiguation — used when featuredId is absent. */
  category:   z.enum(PORTAVA_FEATURED_CATEGORY).optional(),
}).optional();

router.post("/admin/featured/accept-permission/:postId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { postId } = req.params;

  const parsed = PermissionActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { featuredId, category } = parsed.data ?? {};

  // Verify that the requesting user is the post author
  const { data: post } = await sc
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (!post || (post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post author can grant permission");
    return;
  }

  const now = new Date().toISOString();

  // Build the update query, adding disambiguation when provided.
  // A post may have multiple pending_permission rows (one per category), so we
  // must narrow to exactly one row to avoid maybeSingle() conflicts.
  let updateQ = (sc as any)
    .from("portava_featured")
    .update({
      status:                        "live",
      creator_permission_granted_at: now,
      updated_at:                    now,
    });

  if (featuredId) {
    // Exact row by primary key — most precise path.
    updateQ = updateQ.eq("id", featuredId).eq("post_id", postId).eq("status", "pending_permission");
  } else if (category) {
    updateQ = updateQ.eq("post_id", postId).eq("category", category).eq("status", "pending_permission");
  } else {
    // Fallback: post_id + status only. Safe when there is exactly one pending row;
    // returns an error via maybeSingle() when multiple rows match.
    updateQ = updateQ.eq("post_id", postId).eq("status", "pending_permission");
  }

  const { data: featured, error: updateErr } = await updateQ.select().maybeSingle();

  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }
  if (!featured) { sendError(res, "not_found", "Featured record not found or not pending permission"); return; }

  // Increment featured_count on the author's profile
  await adjustProfileCounter(sc, user.id, "featured_count", +1);

  res.json({ ok: true, featured });
}));

// ── POST /admin/featured/decline-permission/:postId ──────────────────────────
// Called when the creator taps "Decline" on the permission notification.
// Accepts optional `featuredId` or `category` to disambiguate multi-category rows.

router.post("/admin/featured/decline-permission/:postId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { postId } = req.params;

  const parsed = PermissionActionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { featuredId, category } = parsed.data ?? {};

  // Verify that the requesting user is the post author
  const { data: post } = await sc
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .maybeSingle();

  if (!post || (post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post author can decline permission");
    return;
  }

  const now = new Date().toISOString();

  let updateQ = (sc as any)
    .from("portava_featured")
    .update({ status: "declined", updated_at: now });

  if (featuredId) {
    updateQ = updateQ.eq("id", featuredId).eq("post_id", postId).eq("status", "pending_permission");
  } else if (category) {
    updateQ = updateQ.eq("post_id", postId).eq("category", category).eq("status", "pending_permission");
  } else {
    updateQ = updateQ.eq("post_id", postId).eq("status", "pending_permission");
  }

  const { data: declined, error: updateErr } = await updateQ.select().maybeSingle();

  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }
  if (!declined) { sendError(res, "not_found", "Featured record not found or not pending permission"); return; }

  res.json({ ok: true });
}));

// ── POST /admin/featured/revoke/:postId ───────────────────────────────────────

router.post("/admin/featured/revoke/:postId", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { postId } = req.params;
  const { category } = req.body ?? {};

  if (!category || !PORTAVA_FEATURED_CATEGORY.includes(category)) {
    sendError(res, "invalid_payload", "Valid category required");
    return;
  }

  const now = new Date().toISOString();

  // Load current state to know if we need to decrement featured_count
  const { data: existing } = await sc
    .from("portava_featured")
    .select("id, status, post_id")
    .eq("post_id", postId)
    .eq("category", category)
    .maybeSingle();

  if (!existing) {
    sendError(res, "not_found", "Featured record not found");
    return;
  }

  const wasLive = (existing as any).status === "live";

  const { data: revoked, error: revokeErr } = await sc
    .from("portava_featured")
    .update({ status: "declined", updated_at: now })
    .eq("post_id", postId)
    .eq("category", category)
    .select()
    .maybeSingle();

  if (revokeErr) { sendError(res, "db_error", revokeErr.message); return; }

  // Decrement featured_count if the post was live
  if (wasLive) {
    const { data: post } = await sc
      .from("posts")
      .select("author_id")
      .eq("id", postId)
      .maybeSingle();
    if (post) {
      await adjustProfileCounter(sc, (post as any).author_id, "featured_count", -1);
    }
  }

  res.json({ ok: true, featured: revoked });
}));

// ── POST /admin/featured/reseed ───────────────────────────────────────────────
//
// Repopulates portava_featured from @Portava's own top posts without a deploy.
// Useful when an admin accidentally revokes all featured rows or the table is
// otherwise empty.  Skips posts that already have a live row for the assigned
// category (idempotent).
//
// Strategy:
//   1. Fetch the top MAX_RESEED @Portava posts ordered by like_count.
//   2. Distribute them round-robin across the 6 standard categories.
//   3. Upsert with status = 'live', respecting the existing (post_id, category)
//      unique constraint — existing live rows are left unchanged.
//
// Returns { seeded: number, skipped: number } so callers can tell whether the
// table actually needed repopulation.

const MAX_RESEED = 18; // 3 posts per category across 6 categories

router.post("/admin/featured/reseed", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;

  // Resolve @portava's profile id by handle at request time — never hardcode
  // it, since seeding flows can assign @portava a different id per environment.
  const { data: portavaProfile } = await sc
    .from("profiles")
    .select("id")
    .eq("handle", "portava")
    .maybeSingle();

  if (!portavaProfile) {
    res.json({ seeded: 0, skipped: 0, message: "@portava profile not found — nothing to seed from" });
    return;
  }

  // 1. Fetch @Portava's top posts by like_count.
  const { data: portavaPosts, error: postsErr } = await sc
    .from("posts")
    .select("id, author_id, like_count, primary_media_type, has_video, status, post_status")
    .eq("author_id", (portavaProfile as any).id)
    .eq("status", "active")
    .eq("post_status", "published")
    .order("like_count", { ascending: false })
    .limit(MAX_RESEED);

  if (postsErr) { sendError(res, "db_error", postsErr.message); return; }

  const posts = (portavaPosts ?? []) as any[];
  if (posts.length === 0) {
    res.json({ seeded: 0, skipped: 0, message: "@Portava has no published posts to seed from" });
    return;
  }

  // 2. Load existing live rows to skip them (idempotency).
  const { data: liveRows } = await sc
    .from("portava_featured")
    .select("post_id, category")
    .eq("status", "live");

  const liveSet = new Set(
    ((liveRows ?? []) as any[]).map((r: any) => `${r.post_id}::${r.category}`),
  );

  const now = new Date().toISOString();

  // 3. Distribute posts round-robin across the 6 categories.
  const toUpsert: any[] = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const category = PORTAVA_FEATURED_CATEGORY[i % PORTAVA_FEATURED_CATEGORY.length];
    const key = `${post.id}::${category}`;
    if (liveSet.has(key)) continue;   // already live — skip
    toUpsert.push({
      post_id:     post.id,
      category,
      featured_at: now,
      approved_by: adminUserId,
      status:      "live",
      creator_permission_requested_at: null,
      creator_permission_granted_at:   null,
    });
  }

  if (toUpsert.length === 0) {
    res.json({ seeded: 0, skipped: posts.length, message: "All posts already have live featured rows" });
    return;
  }

  const { error: upsertErr } = await sc
    .from("portava_featured")
    .upsert(toUpsert, { onConflict: "post_id,category" });

  if (upsertErr) { sendError(res, "db_error", upsertErr.message); return; }

  res.json({
    seeded:  toUpsert.length,
    skipped: posts.length - toUpsert.length,
    categories: [...new Set(toUpsert.map((r) => r.category))],
    seededAt: now,
  });
}));

// ── DELETE /admin/featured/:id ────────────────────────────────────────────────

router.delete("/admin/featured/:id", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { id } = req.params;

  // Load before delete to maybe decrement featured_count
  const { data: existing } = await sc
    .from("portava_featured")
    .select("id, status, post_id")
    .eq("id", id)
    .maybeSingle();

  if (!existing) {
    sendError(res, "not_found", "Featured record not found");
    return;
  }

  const wasLive = (existing as any).status === "live";

  const { error: deleteErr } = await sc
    .from("portava_featured")
    .delete()
    .eq("id", id);

  if (deleteErr) { sendError(res, "db_error", deleteErr.message); return; }

  // Decrement featured_count if the deleted record was live
  if (wasLive) {
    const { data: post } = await sc
      .from("posts")
      .select("author_id")
      .eq("id", (existing as any).post_id)
      .maybeSingle();
    if (post) {
      await adjustProfileCounter(sc, (post as any).author_id, "featured_count", -1);
    }
  }

  res.status(204).end();
}));

export default router;
