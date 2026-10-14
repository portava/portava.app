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
 *   highlight_like             — the Highlight's own engagement gate, then owner OR public (§BQ)
 *   memory_like                — GET /memories/:id's own read decision, then owner OR public (§BQ)
 *
 * Access denied returns 403 (forbidden), except memory_like and highlight_like: an item this viewer cannot
 * READ gets its own read's 404 not_found, the same as a missing one, so the gate is no existence oracle.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { readBlockExclusions, isExcluded, sendExclusionsUnavailable } from "../lib/exclusionSet.js"; import { canReadMemory, isBlocked } from "../services/memory/memoryReadPolicy.js"; import { decideHighlightViewAccess } from "./highlights.js"; // §BQ: one line, so cited lines hold

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
): Promise<AccessVerdict> {
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
      // census-highlights-memories §BQ: the Highlight's OWN engagement gate (decideHighlightViewAccess, in front of like, view,
      // reply, report and actions) for anyone but the owner, then main's owner-or-public rule — see highlightLikeGate.
      const { data: hl, error: hlErr } = await sc
        .from("highlights")
        .select("id, owner_id")
        .eq("id", targetId).maybeSingle();
      if (hlErr) return "unreadable"; // the route refuses (503): an unreadable gate neither admits nor answers not_found
      return highlightLikeGate(sc, viewerId, hl);
    }

    case "memory_like": {
      // census-highlights-memories §BQ: GET /memories/:id's OWN decision first, not `owner || public` alone — see memoryLikeGate.
      const { data: mem, error: memErr } = await sc
        .from("memories")
        .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
        .eq("id", targetId).neq("state", "deleted") // GET /memories/:id serves no deleted Memory, to anyone
        .maybeSingle();
      if (memErr) return "unreadable"; // the route refuses (503): an unreadable gate neither admits nor answers not_found
      return memoryLikeGate(sc, viewerId, mem);
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
): Promise<{ userIds: string[]; likedAts: Map<string, string>; nextCursor: string | null; hasMore: boolean; readFailed: boolean }> {
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
  // An unreadable likes table is NOT "nobody liked this". This function used to
  // answer both questions with the same empty page, and the caller turned that
  // into a 200 `{ users: [] }` — the exact false statement the block-set
  // refusal below exists to prevent, made two functions earlier and about the
  // same roster. The caller refuses instead; see the route.
  if (error) {
    return { userIds: [], likedAts: new Map(), nextCursor: null, hasMore: false, readFailed: true };
  }

  const all = (rows ?? []) as any[];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  const likedAts = new Map<string, string>();
  for (const r of page) likedAts.set(r.user_id, r.created_at);

  const nextCursor = hasMore ? (page[page.length - 1]?.created_at ?? null) : null;

  return { userIds: page.map((r: any) => r.user_id), likedAts, nextCursor, hasMore, readFailed: false };
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
  if (accessible === "unreadable") {
    req.log.error(
      { targetType, targetId },
      "engagement/likes: the target's gate read failed — refusing rather than admitting or answering not_found",
    );
    sendError(res, "degraded_unavailable", "Reactions are temporarily unavailable");
    return;
  }
  if (typeof accessible === "object") {
    // §BQ: the item's own read answer (GET /memories/:id; the Highlight engagement gate), for a missing item
    // and an unreadable one alike.
    sendError(res, "not_found", accessible.notFound);
    return;
  }
  if (accessible !== true) {
    // Return 403 so callers can distinguish "not allowed" from "not found"
    sendError(res, "forbidden", "Content not found or not accessible");
    return;
  }

  const { userIds, likedAts, nextCursor, hasMore, readFailed } = await getLikerIds(
    sc,
    targetType as TargetType,
    targetId,
    { reactionType, cursor, limit },
  );

  // FAIL-CLOSED, same reasoning as the block set below and the same answer:
  // this response IS the roster, so `users: []` is not a narrower truth, it is
  // a false statement that nobody liked this — which the client renders and
  // caches as fact, and which no field on the response distinguishes from a
  // genuinely unliked post. `degraded_unavailable` (503, retryable) says the
  // read could not be PERFORMED, rather than db_error (500): nothing is wrong
  // with the request and a retry is the correct recovery.
  if (readFailed) {
    req.log.error(
      { targetType, targetId },
      "engagement/likes: liker read failed — refusing rather than reporting an empty roster",
    );
    sendError(res, "degraded_unavailable", "Reactions are temporarily unavailable");
    return;
  }

  if (userIds.length === 0) {
    res.json({ ok: true, users: [], nextCursor: null, hasMore: false });
    return;
  }

  // Build blocked-user set (both directions from viewer's perspective).
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts): this response IS a roster of
  // other people — there is no part of it the block set does not scope. So an
  // unreadable `blocks` table has no narrower honest answer available:
  //   • the unfiltered list shows the viewer people they blocked (the defect);
  //   • `users: []` is a false statement that nobody liked this, which the
  //     client renders and caches as fact.
  // It refuses with `degraded_unavailable` (503, retryable) — "the check could
  // not be performed", the same code requireUser uses for an unreadable
  // account_status — rather than db_error (500), because nothing is wrong with
  // the request and a retry is the correct recovery. The scoped read (`among`)
  // is used because the candidate ids are already known and bounded.
  //
  // Previously `(blockRows ?? [])` made a resolved DB error an empty set and
  // this endpoint listed blocked users among the likers.
  const blockedSet = await readBlockExclusions(sc, user.id, { among: userIds });
  if (!blockedSet.ok) {
    sendExclusionsUnavailable(req, res, blockedSet, "engagement/likes");
    return;
  }

  // Filter: exclude viewer + blocked users
  const filteredIds = userIds.filter((id) => id !== user.id && !isExcluded(blockedSet, id));

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

/**
 * What `checkAccess` answers. `true` lists the likers; `false` is the route's 403;
 * `{ notFound }` is the item's own read's 404 (its message is that read's); and
 * `"unreadable"` is a 503 refusal. Only `true` admits — the call site tests
 * `=== true`, never truthiness, because the other two are truthy.
 */
type AccessVerdict = boolean | "unreadable" | { readonly notFound: string };

const MEMORY_NOT_FOUND = { notFound: "Memory not found" } as const; // GET /memories/:id's body
const HIGHLIGHT_NOT_FOUND = { notFound: "Highlight not found" } as const; // decideHighlightViewAccess's body

/**
 * census-highlights-memories §BQ — may this viewer list the likers of this Memory?
 *
 * THE DEFECT. The gate was `owner_id === viewer || visibility === 'public'`
 * over `id, owner_id, visibility`: no `state`, no `hidden_user_ids`, no block.
 * The likers of a moderator-removed public Memory, a deleted one, one its owner
 * hid from this viewer, and one whose owner and viewer blocked each other were
 * all listable, while GET /memories/:id answered every one of them 404. A
 * Memory's likers are a fact about the Memory; a viewer the Memory's own read
 * refuses gets none of them.
 *
 * THE RULE, IN ORDER:
 *   1. No row (absent, or `state = 'deleted'`, filtered by the caller's read)
 *      → GET /memories/:id's 404.
 *   2. The owner → admitted. GET /memories/:id serves its owner every state but
 *      deleted, and so does this.
 *   3. A block in EITHER direction → the same 404. `isBlocked` is the one
 *      GET /memories/:id calls, and it answers "blocked" when the read fails.
 *   4. §23 `canReadMemory(..., "single")` refuses → the same 404. That is the
 *      published-state rule, the hide list, and the audience ladder, in the
 *      function GET /memories/:id calls — not a re-derivation of it.
 *   5. Readable, but not public → `false` (the route's 403). NOT WIDENED: the
 *      old rule listed a non-public Memory's likers to its owner only, and a
 *      reader the ladder admits (a mutual follower, crew, an allow-listed
 *      viewer) is still refused here. Whether they may see who liked it is an
 *      owner question; the fail-closed default keeps main's narrower rule. A
 *      403 to someone who may read the Memory reveals nothing they cannot see.
 *   6. Readable and public → admitted.
 *
 * NO EXISTENCE ORACLE. Steps 1, 3 and 4 return the SAME answer, so a Memory
 * that does not exist and one this viewer may not read are indistinguishable
 * here, exactly as they are on GET /memories/:id. A failed `memories` read is
 * the caller's `"unreadable"`, which it answers before knowing whether the row
 * exists, so that refusal is not an oracle either.
 */
async function memoryLikeGate(sc: any, viewerId: string, mem: any): Promise<AccessVerdict> {
  if (!mem) return MEMORY_NOT_FOUND;
  if (mem.owner_id === viewerId) return true;
  if (await isBlocked(sc, viewerId, mem.owner_id)) return MEMORY_NOT_FOUND;
  if (!(await canReadMemory(sc, mem, viewerId, "single"))) return MEMORY_NOT_FOUND;
  return mem.visibility === "public";
}

/**
 * census-highlights-memories §BQ — may this viewer list the likers of this Highlight?
 *
 * THE DEFECT, the same shape as `memory_like`'s (verifier V-731, executed for
 * Memories; read here for Highlights): the gate was `owner_id === viewer ||
 * visibility === 'public'` over `id, owner_id, visibility`, so a non-owner listed
 * the likers of a DELETED, EXPIRED or ARCHIVED public Highlight, of one its owner
 * set KEEP_PRIVATE_FOREVER (§11) or withheld from public projection (§10), and
 * of one whose owner and viewer had blocked each other — every one of which
 * POST /highlights/:id/like and GET /highlights/:id/actions answer 404. Census
 * §P.5 named this surface as "cruder than canViewHighlight (no circle, no trip,
 * no block); it wants the whole gate, not a bolt-on". This is the whole gate.
 *
 * THE RULE, IN ORDER:
 *   1. No row → the gate's 404.
 *   2. The owner → admitted, in every state. That is main's rule and it is the
 *      rule of the owner's sibling read, GET /highlights/:id/viewers (which lists
 *      who liked, too): an owner reads their own Highlight's engagement whether
 *      it is live, expired, archived or deleted. `decideHighlightViewAccess` is a
 *      VIEWER's gate and refuses an inactive Highlight to its owner as well, so it
 *      is not asked about the owner.
 *   3. `decideHighlightViewAccess` refuses → its own 404, the same for every rung
 *      (missing, block or unreadable block read, inactive, audience, §10/§11), so
 *      the gate is no existence oracle. Its `unreadable` (the highlights read
 *      failed) is this route's 503, as the caller's own read failure is.
 *   4. Admitted, but not public → `false` (the route's 403). NOT WIDENED, as for
 *      Memories: a circle or trip member who may view a non-public Highlight, and
 *      any viewer of a `travelers_nearby` one, is still refused its likers here.
 *      Whether they may see them is an owner question.
 *   5. Admitted and public → admitted.
 */
async function highlightLikeGate(sc: any, viewerId: string, hl: any): Promise<AccessVerdict> {
  if (!hl) return HIGHLIGHT_NOT_FOUND;
  if (hl.owner_id === viewerId) return true;
  const verdict = await decideHighlightViewAccess(sc, viewerId, hl.id);
  if (!verdict.ok) return verdict.reason === "unreadable" ? "unreadable" : HIGHLIGHT_NOT_FOUND;
  return verdict.h.visibility === "public";
}

export default router;
