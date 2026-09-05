/**
 * Engagement routes
 *
 * GET /api/engagement/likes — paginated list of users who liked/reacted to content.
 *
 * Query params:
 *   targetType  post_like | post_reaction | comment_like | highlight_like | memory_like
 *   targetId    UUID of the target entity
 *   reactionType  (optional, ignored for post_like/post_reaction — stamps are emoji-agnostic)
 *   cursor      (optional) ISO timestamp — exclusive lower bound for cursor pagination
 *   limit       (optional) 1-50, default 20
 *   q           (optional) search string — filters by display_name or username
 *
 * Response:
 *   { ok: true, users: LikerUser[], nextCursor: string|null, hasMore: boolean }
 *
 * Privacy guarantee: the `total` field is intentionally omitted to avoid leaking
 * like counts from blocked or filtered users. Callers should use the count they
 * already hold from the parent entity (e.g. post.like_count).
 *
 * Access control per targetType:
 *   post_like / post_reaction  — reads content_stamps; post must be public OR viewer is the author
 *                                (trip_only: viewer must be a trip member)
 *   comment_like               — same as the comment's parent post
 *   highlight_like             — viewer must be the highlight owner OR highlight is public
 *   memory_like                — viewer must be the memory owner OR memory is public
 *
 * Access denied returns 403 (forbidden) — not 404 — so callers can distinguish
 * "content does not exist" (which should be handled upstream) from "not allowed".
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

const VALID_TYPES = [
  "post_like",
  "post_reaction",
  "comment_like",
  "highlight_like",
  "memory_like",
] as const;
type TargetType = typeof VALID_TYPES[number];

// ── Access control helpers ─────────────────────────────────────────────────────

async function checkPostAccess(sc: any, viewerId: string, postId: string): Promise<boolean> {
  const { data: post } = await sc
    .from("posts")
    .select("id, author_id, visibility, status, trip_id")
    .eq("id", postId)
    .maybeSingle();
  if (!post || (post as any).status === "deleted") return false;
  const { author_id: authorId, visibility, trip_id: tripId } = post as any;
  if (authorId === viewerId) return true;
  if (visibility === "public") return true;
  if (visibility === "trip_only" && tripId) {
    const { data: member } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("user_id", viewerId)
      .maybeSingle();
    return !!member;
  }
  return false;
}

async function checkAccess(
  sc: any,
  viewerId: string,
  targetType: TargetType,
  targetId: string,
): Promise<boolean> {
  switch (targetType) {
    case "post_like":
    case "post_reaction":
      return checkPostAccess(sc, viewerId, targetId);

    case "comment_like": {
      const { data: comment } = await sc
        .from("posts_comments")
        .select("post_id")
        .eq("id", targetId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!comment) return false;
      return checkPostAccess(sc, viewerId, (comment as any).post_id);
    }

    case "highlight_like": {
      const { data: hl } = await sc
        .from("highlights")
        .select("id, owner_id, visibility")
        .eq("id", targetId)
        .maybeSingle();
      if (!hl) return false;
      const v = hl as any;
      return v.owner_id === viewerId || v.visibility === "public";
    }

    case "memory_like": {
      const { data: mem } = await sc
        .from("memories")
        .select("id, owner_id, visibility")
        .eq("id", targetId)
        .maybeSingle();
      if (!mem) return false;
      const v = mem as any;
      return v.owner_id === viewerId || v.visibility === "public";
    }

    default:
      return false;
  }
}

// ── Paginated liker IDs ────────────────────────────────────────────────────────

async function getLikerIds(
  sc: any,
  targetType: TargetType,
  targetId: string,
  opts: { reactionType?: string; cursor?: string; limit: number },
): Promise<{ userIds: string[]; likedAts: Map<string, string>; nextCursor: string | null; hasMore: boolean }> {
  const { reactionType, cursor, limit } = opts;

  let q: any;
  switch (targetType) {
    case "post_like":
      // Reads content_stamps (unified write path since Task 3047 — posts_likes no longer updated).
      q = sc.from("content_stamps").select("user_id, created_at")
        .eq("entity_type", "post").eq("entity_id", targetId);
      break;
    case "post_reaction":
      // post_reactions stores per-emoji reactions (distinct from stamp likes) — preserved as-is.
      q = sc.from("post_reactions").select("user_id, created_at").eq("post_id", targetId);
      if (reactionType) q = q.eq("emoji", reactionType);
      break;
    case "comment_like":
      q = sc.from("comment_likes").select("user_id, created_at").eq("comment_id", targetId);
      break;
    case "highlight_like":
      q = sc.from("highlight_likes").select("user_id, created_at").eq("highlight_id", targetId);
      break;
    case "memory_like":
      q = sc.from("memory_likes").select("user_id, created_at").eq("memory_id", targetId);
      break;
  }

  if (cursor) q = q.lt("created_at", cursor);
  q = q.order("created_at", { ascending: false }).limit(limit + 1);

  const { data: rows, error } = await q;
  if (error) return { userIds: [], likedAts: new Map(), nextCursor: null, hasMore: false };

  const all = (rows ?? []) as any[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  const likedAts = new Map<string, string>();
  for (const r of page) likedAts.set(r.user_id, r.created_at);

  const nextCursor = hasMore ? (page[page.length - 1]?.created_at ?? null) : null;

  return { userIds: page.map((r: any) => r.user_id), likedAts, nextCursor, hasMore };
}

// ── Main route ─────────────────────────────────────────────────────────────────

router.get("/engagement/likes", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const {
    targetType,
    targetId,
    reactionType,
    cursor,
    limit: rawLimit,
    q,
  } = req.query as Record<string, string | undefined>;

  if (!VALID_TYPES.includes(targetType as any)) {
    sendError(res, "invalid_payload", `targetType must be one of: ${VALID_TYPES.join(", ")}`);
    return;
  }
  if (!targetId || !isUuid(targetId)) {
    sendError(res, "invalid_payload", "targetId must be a valid UUID");
    return;
  }
  // Validate reactionType when provided for post_reaction
  if (targetType === "post_reaction" && reactionType !== undefined) {
    if (typeof reactionType !== "string" || reactionType.trim() === "") {
      sendError(res, "invalid_payload", "reactionType must be a non-empty emoji string");
      return;
    }
  }

  const limit = Math.min(50, Math.max(1, parseInt(rawLimit ?? "20", 10) || 20));

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service not available");
    return;
  }

  const accessible = await checkAccess(sc, user.id, targetType as TargetType, targetId);
  if (!accessible) {
    // Return 403 so callers can distinguish "not allowed" from "not found"
    sendError(res, "forbidden", "Content not found or not accessible");
    return;
  }

  const { userIds, likedAts, nextCursor, hasMore } = await getLikerIds(
    sc,
    targetType as TargetType,
    targetId,
    { reactionType, cursor, limit },
  );

  if (userIds.length === 0) {
    res.json({ ok: true, users: [], nextCursor: null, hasMore: false });
    return;
  }

  // Build blocked-user set (both directions from viewer's perspective)
  const { data: blockRows } = await sc
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
  const blockedSet = new Set<string>();
  for (const b of (blockRows ?? []) as any[]) {
    if (b.blocker_id === user.id) blockedSet.add(b.blocked_id);
    else blockedSet.add(b.blocker_id);
  }

  // Filter: exclude viewer + blocked users
  const filteredIds = userIds.filter((id) => id !== user.id && !blockedSet.has(id));

  if (filteredIds.length === 0) {
    res.json({ ok: true, users: [], nextCursor, hasMore });
    return;
  }

  // Profiles query — exclude deleted, banned, and suspended accounts.
  // NOTE: name search is NOT applied at the DB level. Under the universal
  // display-name rule a hidden name must not be *matchable*, so we fetch the
  // candidate rows unfiltered by name and post-filter in JS below, allowing a
  // display_name match to survive only when that user opted in (or is viewer).
  const { data: profiles, error: profileErr } = await sc
    .from("profiles")
    .select("id, username, display_name, avatar_url, account_status, verified, is_private")
    .in("id", filteredIds)
    // `profiles.account_status` is TEXT with a CHECK permitting exactly
    // active | deactivated | pending_deletion | deleted. Only the first of the
    // three exclusions below was a real value: "banned" and "suspended" matched
    // nothing, so `deactivated` and `pending_deletion` accounts were listed in
    // the likes roster. Replaced with the allowlist form used everywhere else.
    .eq("account_status", "active");

  if (profileErr) {
    req.log.error({ err: profileErr }, "engagement/likes profiles fetch failed");
    sendError(res, "db_error", profileErr.message);
    return;
  }

  const candidateRows = (profiles ?? []) as any[];

  // Universal display-name rule: batch lookup of who opted in to showing names.
  const allowedNames = await nameVisibilitySet(sc, candidateRows.map((p) => p.id));

  // Post-filter search: a row survives only if the query matched a visible
  // field. username always matches; display_name matches only when that user's
  // name is visible to the viewer (opted in, or the viewer themselves).
  const term = q && q.trim() ? q.trim().toLowerCase() : null;
  const profileMap = new Map<string, any>();
  for (const p of candidateRows) {
    if (term) {
      const nameVisible = p.id === user.id || allowedNames.has(p.id);
      const usernameHit = typeof p.username === "string" && p.username.toLowerCase().includes(term);
      const nameHit = nameVisible && typeof p.display_name === "string" && p.display_name.toLowerCase().includes(term);
      if (!usernameHit && !nameHit) continue;
    }
    profileMap.set(p.id, p);
  }

  const profileIds = [...profileMap.keys()];

  // Follow state (both directions) + pending follow requests
  const [{ data: followingRows }, { data: followsYouRows }, { data: pendingRequestRows }] = await Promise.all([
    profileIds.length > 0
      ? sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", profileIds)
      : Promise.resolve({ data: [] }),
    profileIds.length > 0
      ? sc.from("user_follows").select("follower_id").eq("following_id", user.id).in("follower_id", profileIds)
      : Promise.resolve({ data: [] }),
    profileIds.length > 0
      ? sc.from("friend_requests").select("recipient_id").eq("requester_id", user.id).eq("status", "pending").in("recipient_id", profileIds)
      : Promise.resolve({ data: [] }),
  ]);

  const followingSet = new Set<string>((followingRows ?? []).map((r: any) => r.following_id));
  const followsYouSet = new Set<string>((followsYouRows ?? []).map((r: any) => r.follower_id));
  const pendingRequestSet = new Set<string>((pendingRequestRows ?? []).map((r: any) => r.recipient_id));

  // Preserve insertion order from likedAts (most-recent-first)
  const users = filteredIds
    .map((id) => {
      const p = profileMap.get(id);
      if (!p) return null;
      // Private accounts the viewer doesn't already follow get a locked preview:
      // avatar is hidden and name falls back to handle. This matches the locked-
      // preview pattern used across all other people-listing surfaces.
      const isPrivate = ((p.is_private as boolean) ?? false) && !followingSet.has(p.id);
      const shownName = isPrivate
        ? null
        : presentedName(
            { id: p.id, display_name: p.display_name, name: null },
            p.id === user.id || allowedNames.has(p.id),
          );
      return {
        id: p.id,
        handle: p.username ?? "",
        displayName: shownName ?? p.username ?? "Traveler",
        avatarUrl: isPrivate ? null : (p.avatar_url ?? null),
        verified: (p.verified as boolean) ?? false,
        isFollowing: followingSet.has(p.id),
        followsYou: followsYouSet.has(p.id),
        isPrivate,
        isRequestSent: isPrivate ? pendingRequestSet.has(p.id) : undefined,
        likedAt: likedAts.get(id) ?? "",
      };
    })
    .filter(Boolean);

  // Note: `total` is intentionally omitted — see module doc comment.
  // Callers should display the count they already hold from the parent entity.
  res.json({ ok: true, users, nextCursor, hasMore });
}));

export default router;
