/**
 * Stories routes
 *
 * POST   /stories                       — create story (auto-sets expires_at = +24h)
 * GET    /stories/feed                  — active stories from followed/crew/circle (grouped by owner)
 * GET    /stories/:id                   — get story (privacy + block + expiry gated); records view
 * DELETE /stories/:id                   — owner soft-delete
 * POST   /stories/:id/react             — upsert an emoji reaction
 * POST   /stories/:id/reply             — send a private reply
 * GET    /stories/:id/viewers           — owner-only viewer list
 * POST   /stories/:id/save-to-highlight — owner-only; saves the story's media as
 *                                         a Highlight with an EXPLICIT term,
 *                                         including permanent (null). No default:
 *                                         the user must choose.
 * GET    /stories/archive               — owner-only; expired/saved stories.
 * POST   /stories/:id/repost            — owner-only; re-activates for 24h.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { ownerFromPath } from "../lib/mediaAccess.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Visibility types ──────────────────────────────────────────────────────────

const STORY_VISIBILITY = ["public", "friends_only", "close_friends", "trip_crew", "circle_only", "custom"] as const;
type StoryVisibility = (typeof STORY_VISIBILITY)[number];

const STORY_STATES = ["active", "expired", "saved", "deleted", "removed"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function storiesEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, "stories_enabled").catch(() => true);
}

/**
 * Returns true if viewerId is on owner's close_friends list.
 */
async function isCloseFriend(sc: any, ownerId: string, viewerId: string): Promise<boolean> {
  const { data } = await sc
    .from("close_friends")
    .select("friend_user_id")
    .eq("owner_id", ownerId)
    .eq("friend_user_id", viewerId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Returns true if viewerId is blocked by ownerId or vice-versa.
 */
async function isBlocked(sc: any, a: string, b: string): Promise<boolean> {
  const [r1, r2] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", a).eq("blocked_id", b).maybeSingle(),
    sc.from("blocks").select("blocked_id").eq("blocker_id", b).eq("blocked_id", a).maybeSingle(),
  ]);
  return Boolean(r1.data || r2.data);
}

/**
 * Resolves whether viewerId can read a story row. Returns an error string on deny, or null on allow.
 * Callers must have already confirmed state = 'active' and expiry not passed.
 */
async function checkStoryAccess(sc: any, story: any, viewerId: string): Promise<string | null> {
  if (viewerId === story.owner_id) return null;

  if (await isBlocked(sc, story.owner_id, viewerId)) return "not_found";

  const vis: StoryVisibility = story.visibility ?? "public";

  if (vis === "public") return null;

  if (vis === "close_friends" || story.close_friends_only) {
    const ok = await isCloseFriend(sc, story.owner_id, viewerId);
    return ok ? null : "not_found";
  }

  if (vis === "friends_only") {
    const [fwd, back] = await Promise.all([
      sc.from("user_follows").select("following_id").eq("follower_id", story.owner_id).eq("following_id", viewerId).maybeSingle(),
      sc.from("user_follows").select("following_id").eq("follower_id", viewerId).eq("following_id", story.owner_id).maybeSingle(),
    ]);
    return (fwd.data && back.data) ? null : "not_found";
  }

  if (vis === "circle_only") {
    const { data } = await sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", story.owner_id)
      .eq("other_id", viewerId)
      .maybeSingle();
    return data ? null : "not_found";
  }

  if (vis === "trip_crew") {
    if (!story.trip_id) return "not_found";
    const [r1, r2] = await Promise.all([
      sc.from("trip_members").select("user_id").eq("trip_id", story.trip_id).eq("user_id", viewerId).in("role", ["owner", "member"]).maybeSingle(),
      sc.from("trip_members").select("user_id").eq("trip_id", story.trip_id).eq("user_id", story.owner_id).in("role", ["owner", "member"]).maybeSingle(),
    ]);
    return (r1.data && r2.data) ? null : "not_found";
  }

  if (vis === "custom") {
    const hidden: string[] = story.hidden_user_ids ?? [];
    const allowed: string[] = story.allowed_user_ids ?? [];
    if (hidden.includes(viewerId)) return "not_found";
    if (allowed.includes(viewerId)) return null;
    return "not_found";
  }

  return "not_found";
}

// Columns returned for a story (no sensitive internal data)
const STORY_COLS = "id, owner_id, media_url, media_type, caption, visibility, close_friends_only, trip_id, event_id, place_id, expires_at, saved_to_highlight_id, state, hide_viewer_list, created_at, allowed_user_ids, hidden_user_ids";

// ── POST /stories — create ────────────────────────────────────────────────────

const createStorySchema = z.object({
  mediaUrl:       z.string().min(1, "mediaUrl is required"),
  mediaType:      z.string().min(1),
  caption:        z.string().max(1000).nullable().optional(),
  visibility:     z.enum(STORY_VISIBILITY).default("public"),
  allowedUserIds: z.array(z.string().uuid()).optional().default([]),
  hiddenUserIds:  z.array(z.string().uuid()).optional().default([]),
  closeFriendsOnly: z.boolean().optional().default(false),
  tripId:         z.string().uuid().nullable().optional(),
  eventId:        z.string().uuid().nullable().optional(),
  placeId:        z.string().max(200).nullable().optional(),
  hideViewerList: z.boolean().optional().default(false),
});

router.post("/stories", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!(await storiesEnabled(sc))) { sendError(res, "feature_disabled", "Stories are not enabled"); return; }

  const parsed = createStorySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  /**
   * mediaUrl must be OUR storage, and must be an object THIS user uploaded.
   *
   * The first half is the guard routes/events.ts:5347 and routes/messaging.ts:2016
   * already carry — same helper, same error string. This create path is the
   * sibling that never got it: createStorySchema types mediaUrl as
   * z.string().min(1) and the insert below wrote it through untouched, so any
   * client string became a story's media (external host, tracker, SSRF-on-render).
   *
   * The second half is new, and is what the first half alone does not buy.
   * appStorageUrlInfo proves the bytes are ours; it says nothing about WHOSE.
   * lib/mediaAccess.ts branch 3d resolves story media by looking the story up
   * BY media_url and returning `story.visibility === "public"`, so a public
   * story aimed at another user's object key published that user's bytes on the
   * pointing story's own say-so. Both ends are closed: this stops the row being
   * written, 3d stops an already-written row being served.
   *
   * This cannot reject a legitimate story. Stories upload through
   * POST /api/media/upload (routes/posts.ts:75), which builds
   * `${user.id}/${Date.now()}.${ext}` under post-media (posts.ts:172-173) and
   * returns it as the bare key `post-media/<uid>/<ts>.<ext>` (posts.ts:216) —
   * a uid-first path that ownerFromPath already reads, in a bucket
   * appStorageUrlInfo already allows. No client builds a story path, so there
   * is no client convention to drift from.
   */
  const mediaRef = appStorageUrlInfo(d.mediaUrl);
  if (!mediaRef) {
    sendError(res, "invalid_payload", "mediaUrl must be an uploaded app media URL (use /api/media/upload first)");
    return;
  }
  if (ownerFromPath(mediaRef.path) !== user.id) {
    sendError(res, "invalid_payload", "mediaUrl must be media you uploaded");
    return;
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from("stories")
    .insert({
      owner_id:           user.id,
      media_url:          d.mediaUrl,
      media_type:         d.mediaType,
      caption:            d.caption ?? null,
      visibility:         d.visibility,
      allowed_user_ids:   d.allowedUserIds,
      hidden_user_ids:    d.hiddenUserIds,
      close_friends_only: d.closeFriendsOnly,
      trip_id:            d.tripId ?? null,
      event_id:           d.eventId ?? null,
      place_id:           d.placeId ?? null,
      hide_viewer_list:   d.hideViewerList,
      expires_at:         expiresAt,
      state:              "active",
    })
    .select(STORY_COLS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to create story");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({ ...(data as any), viewCount: 0 });
}));

// ── GET /stories/feed — active stories feed ───────────────────────────────────

router.get("/stories/feed", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!(await storiesEnabled(sc))) { sendError(res, "feature_disabled", "Stories are not enabled"); return; }

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const now = new Date().toISOString();

  // Get blocks in both directions
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);

  // Resolve viewer context: follows (both directions), trips, circle memberships, close-friends membership
  const [followRows, followerRows, tripMemberRows, circleMemberRows, closeFriendOfRows] = await Promise.all([
    sc.from("user_follows").select("following_id").eq("follower_id", user.id),
    sc.from("user_follows").select("follower_id").eq("following_id", user.id),
    sc.from("trip_members").select("trip_id, user_id").eq("user_id", user.id).in("role", ["owner", "member"]),
    sc.from("circle_memberships").select("user_id").eq("other_id", user.id),
    sc.from("close_friends").select("owner_id").eq("friend_user_id", user.id),
  ]);

  const followingIds = new Set<string>((followRows.data ?? []).map((r: any) => r.following_id as string));
  // followerIds: users who follow the viewer back (needed for mutual-follow / friends_only check)
  const followerIds = new Set<string>((followerRows.data ?? []).map((r: any) => r.follower_id as string));
  const viewerTripIds = (tripMemberRows.data ?? []).map((r: any) => r.trip_id as string);
  const circleOwnerIds = new Set<string>((circleMemberRows.data ?? []).map((r: any) => r.user_id as string));
  const closeFriendOfOwnerIds = new Set<string>((closeFriendOfRows.data ?? []).map((r: any) => r.owner_id as string));

  // Get trip member IDs for shared trips (for trip_crew visibility)
  let tripCrewIds = new Set<string>();
  if (viewerTripIds.length > 0) {
    const { data: crewRows } = await sc
      .from("trip_members")
      .select("user_id")
      .in("trip_id", viewerTripIds)
      .in("role", ["owner", "member"])
      .neq("user_id", user.id);
    for (const r of crewRows ?? []) tripCrewIds.add((r as any).user_id as string);
  }

  // Fetch active stories from relevant users — over-fetch then filter
  const candidateOwners = [...new Set([...followingIds, ...tripCrewIds, ...circleOwnerIds])];
  if (candidateOwners.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  const { data: storyRows, error } = await sc
    .from("stories")
    .select(STORY_COLS)
    .in("owner_id", candidateOwners)
    .eq("state", "active")
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(limit * 5);

  if (error) {
    req.log.error({ err: error }, "Failed to load story feed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Filter by blocks + visibility
  const visible = (storyRows ?? []).filter((s: any) => {
    if (blockedIds.has(s.owner_id as string)) return false;
    if (s.owner_id === user.id) return true;
    const vis: StoryVisibility = s.visibility;
    if (vis === "public") return true;
    if (vis === "close_friends" || s.close_friends_only) return closeFriendOfOwnerIds.has(s.owner_id as string);
    // friends_only = mutual follow: viewer follows owner AND owner follows viewer back
    if (vis === "friends_only") return followingIds.has(s.owner_id as string) && followerIds.has(s.owner_id as string);
    if (vis === "circle_only") return circleOwnerIds.has(s.owner_id as string);
    if (vis === "trip_crew") return tripCrewIds.has(s.owner_id as string);
    if (vis === "custom") {
      const hidden: string[] = s.hidden_user_ids ?? [];
      const allowed: string[] = s.allowed_user_ids ?? [];
      if (hidden.includes(user.id)) return false;
      return allowed.includes(user.id);
    }
    return false;
  });

  // Group by owner
  const ownerMap = new Map<string, any[]>();
  for (const s of visible) {
    const key = s.owner_id as string;
    if (!ownerMap.has(key)) ownerMap.set(key, []);
    ownerMap.get(key)!.push(s);
  }

  if (ownerMap.size === 0) { res.status(200).json({ users: [] }); return; }

  const ownerIds = [...ownerMap.keys()];

  // Fetch view states + author profiles
  const allStoryIds = visible.map((s: any) => s.id as string);
  const [viewedRows, profileRows] = await Promise.all([
    sc.from("story_views").select("story_id").eq("viewer_id", user.id).in("story_id", allStoryIds),
    sc.from("profiles").select("id, handle, name, avatar_url, verified").in("id", ownerIds),
  ]);

  const viewedSet = new Set<string>((viewedRows.data ?? []).map((r: any) => r.story_id as string));
  const allowedNames = await nameVisibilitySet(sc, ownerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) {
    const nameAllowed = (p as any).id === user.id || allowedNames.has((p as any).id as string);
    profileMap[(p as any).id] = { id: (p as any).id, handle: (p as any).handle, name: nameAllowed ? (p as any).name : null, avatarUrl: (p as any).avatar_url ?? null, verified: (p as any).verified ?? false };
  }

  const users = ownerIds.slice(0, limit).map((ownerId) => {
    const stories = (ownerMap.get(ownerId) ?? []).map((s: any) => ({
      ...s,
      viewedByMe: viewedSet.has(s.id),
    }));
    return {
      userId: ownerId,
      ...profileMap[ownerId],
      stories,
      hasUnviewed: stories.some((s: any) => !s.viewedByMe),
    };
  });

  res.status(200).json({ users });
}));

// ── GET /stories/archive — the owner's expired stories ───────────────────────
//
// Owner ruling 2026-09-06: an expired story is ARCHIVED, not gone. `story_state`
// already had 'expired' and the sweep already set it rather than deleting the
// row, so the record was always there — nothing ever listed it, and until the
// sweep stopped deleting the storage object the media behind it was gone
// anyway. Both halves are now true, so the archive is real.
//
// Owner-only by construction: it filters on owner_id = the caller and never
// takes a target user.
router.get("/stories/archive", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);

  const { data: rows, error } = await sc
    .from("stories")
    .select(STORY_COLS)
    .eq("owner_id", user.id)
    .in("state", ["expired", "saved"])
    .order("expires_at", { ascending: false })
    .limit(limit);

  if (error) {
    // A failed read is not an empty archive.
    req.log.error({ err: error }, "Failed to load story archive");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ ok: true, stories: rows ?? [] });
}));

// ── GET /stories/:id — get single story ──────────────────────────────────────

router.get("/stories/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story } = await sc
    .from("stories")
    .select(STORY_COLS)
    .eq("id", id)
    .maybeSingle();

  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).state !== "active") { sendError(res, "not_found", "Story not found"); return; }
  if (new Date((story as any).expires_at) <= new Date()) { sendError(res, "not_found", "Story not found"); return; }

  const deny = await checkStoryAccess(sc, story, user.id);
  if (deny) { sendError(res, "not_found", "Story not found"); return; }

  // Record view (upsert, non-fatal) for non-owners
  if (user.id !== (story as any).owner_id) {
    await sc
      .from("story_views")
      .upsert({ story_id: id, viewer_id: user.id, viewed_at: new Date().toISOString() }, { onConflict: "story_id,viewer_id" })
      .then(undefined, () => {});
  }

  // Get view count for owner
  let viewCount = 0;
  if (user.id === (story as any).owner_id) {
    const { count } = await sc.from("story_views").select("story_id", { count: "exact", head: true }).eq("story_id", id);
    viewCount = count ?? 0;
  }

  const viewedByMe = user.id !== (story as any).owner_id;

  res.status(200).json({ ...(story as any), viewCount, viewedByMe });
}));

// ── DELETE /stories/:id — soft-delete ────────────────────────────────────────

router.delete("/stories/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const { data: story } = await client
    .from("stories")
    .select("id, owner_id, state")
    .eq("id", id)
    .maybeSingle();

  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete this story"); return; }

  const { error } = await client
    .from("stories")
    .update({ state: "deleted" })
    .eq("id", id)
    .eq("owner_id", user.id);

  if (error) { req.log.error({ err: error }, "Failed to delete story"); sendError(res, "db_error", error.message); return; }

  res.status(204).send();
}));

// ── POST /stories/:id/react — upsert emoji reaction ──────────────────────────

const reactSchema = z.object({
  emoji: z.string().min(1).max(10),
});

router.post("/stories/:id/react", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story } = await sc.from("stories").select("id, owner_id, state, expires_at, visibility, close_friends_only, allowed_user_ids, hidden_user_ids, trip_id").eq("id", id).maybeSingle();
  if (!story || (story as any).state !== "active" || new Date((story as any).expires_at) <= new Date()) {
    sendError(res, "not_found", "Story not found"); return;
  }

  const deny = await checkStoryAccess(sc, story, user.id);
  if (deny) { sendError(res, "not_found", "Story not found"); return; }

  const { error } = await client
    .from("story_reactions")
    .upsert({ story_id: id, user_id: user.id, emoji: parsed.data.emoji }, { onConflict: "story_id,user_id" });

  if (error) { req.log.error({ err: error }, "Failed to upsert story reaction"); sendError(res, "db_error", error.message); return; }

  res.status(200).json({ ok: true });
}));

// ── POST /stories/:id/reply — private reply ───────────────────────────────────

const replySchema = z.object({
  message: z.string().min(1).max(1000),
});

router.post("/stories/:id/reply", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story } = await sc.from("stories").select("id, owner_id, state, expires_at, visibility, close_friends_only, allowed_user_ids, hidden_user_ids, trip_id").eq("id", id).maybeSingle();
  if (!story || (story as any).state !== "active" || new Date((story as any).expires_at) <= new Date()) {
    sendError(res, "not_found", "Story not found"); return;
  }

  const deny = await checkStoryAccess(sc, story, user.id);
  if (deny) { sendError(res, "not_found", "Story not found"); return; }

  const { data, error } = await client
    .from("story_replies")
    .insert({ story_id: id, user_id: user.id, message: parsed.data.message })
    .select("id, story_id, user_id, message, created_at")
    .single();

  if (error) { req.log.error({ err: error }, "Failed to insert story reply"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(data);
}));

// ── GET /stories/:id/viewers — owner-only viewer list ────────────────────────

router.get("/stories/:id/viewers", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story } = await sc
    .from("stories")
    .select("id, owner_id, hide_viewer_list, state")
    .eq("id", id)
    .maybeSingle();

  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can view the viewer list"); return; }
  if ((story as any).hide_viewer_list) { res.status(200).json({ viewers: [], hidden: true }); return; }

  const { data: viewRows, error } = await client
    .from("story_views")
    .select("viewer_id, viewed_at")
    .eq("story_id", id)
    .order("viewed_at", { ascending: false })
    .limit(200);

  if (error) { req.log.error({ err: error }, "Failed to load story viewers"); sendError(res, "db_error", error.message); return; }

  if (!viewRows || viewRows.length === 0) { res.status(200).json({ viewers: [], hidden: false }); return; }

  // Get blocks (exclude blocked viewers from list)
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);

  const viewerIds = (viewRows ?? []).map((r: any) => r.viewer_id as string).filter((v) => !blockedIds.has(v));

  if (viewerIds.length === 0) { res.status(200).json({ viewers: [], hidden: false }); return; }

  const { data: profiles } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url, verified")
    .in("id", viewerIds);

  const allowedNames = await nameVisibilitySet(sc, viewerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) {
    const nameAllowed = (p as any).id === user.id || allowedNames.has((p as any).id as string);
    profileMap[(p as any).id] = { handle: (p as any).handle, name: nameAllowed ? (p as any).name : null, avatarUrl: (p as any).avatar_url ?? null, verified: (p as any).verified ?? false };
  }

  const viewers = viewerIds.map((vid) => ({
    userId: vid,
    ...profileMap[vid],
    viewedAt: (viewRows ?? []).find((r: any) => r.viewer_id === vid)?.viewed_at ?? null,
  })).filter((v) => v.handle);

  res.status(200).json({ viewers, hidden: false });
}));

// ── POST /stories/:id/repost — put an archived story back up ─────────────────
//
// Owner-only. A story's term is fixed at 24 hours — that is what a story IS, and
// the permanent option belongs to Highlights, which is what save-to-highlight is
// for. So this takes no term argument: it re-activates the SAME row with a fresh
// 24-hour window rather than inserting a copy, keeping the media, caption, place
// and view history attached to the story they belong to.
router.post("/stories/:id/repost", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story, error: readErr } = await sc
    .from("stories")
    .select("id, owner_id, state")
    .eq("id", id)
    .maybeSingle();

  if (readErr) { sendError(res, "db_error", readErr.message); return; }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the owner can repost this story"); return;
  }
  // 'deleted' and 'removed' are terminal on purpose: a deleted story and a
  // moderator-removed one are not archive entries, and re-posting either would
  // undo a decision.
  const state = (story as any).state;
  if (state !== "expired" && state !== "saved") {
    sendError(res, "invalid_payload", `A story in state '${state}' cannot be reposted.`);
    return;
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: updated, error } = await sc
    .from("stories")
    .update({ state: "active", expires_at: expiresAt })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select(STORY_COLS)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "Failed to repost story");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!updated) { sendError(res, "not_found", "Story not found"); return; }

  res.status(200).json({ story: updated, expiresAt });
}));

// ── POST /stories/:id/save-to-highlight — owner-only ─────────────────────────
//
// HISTORY, because this endpoint has now been wrong in two different ways.
// Originally it wrote a highlight with `expires_at = now + 24h` and flipped the
// story to state='saved' — a "save" that discarded the thing in a day, with no
// error and no notification. It was then made to REFUSE, on the reasoning that
// Highlights were ephemeral by construction and there was no permanent term to
// route a save into.
//
// Owner ruling 2026-09-06 removed that premise: a Highlight may be permanent,
// and the user chooses. So the save is real again, and the term is explicit —
// including `null` for permanent. Migration 2313 makes the column and both RLS
// policies able to hold that answer.

const saveToHighlightSchema = z.object({
  // Same vocabulary as POST /highlights. `null` is permanent. There is NO
  // default here, unlike creation: a save is a deliberate act about something
  // that already exists, and silently picking 24 hours for the user is exactly
  // what made the original version a trap.
  expiresInHours: z.union([z.number().int(), z.null()]),
});

const HIGHLIGHT_EXPIRY_HOURS = [3, 6, 12, 24, 48];

router.post("/stories/:id/save-to-highlight", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const parsed = saveToHighlightSchema.safeParse(req.body ?? {});
  if (!parsed.success || (parsed.data.expiresInHours !== null &&
      !HIGHLIGHT_EXPIRY_HOURS.includes(parsed.data.expiresInHours))) {
    sendError(
      res,
      "invalid_payload",
      `expiresInHours must be null (keep permanently) or one of: ${HIGHLIGHT_EXPIRY_HOURS.join(", ")}`,
    );
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story, error: storyErr } = await sc
    .from("stories")
    .select("id, owner_id, saved_to_highlight_id, media_url, media_type, caption, place_id, visibility")
    .eq("id", id)
    .maybeSingle();

  // A failed read is not a missing story.
  if (storyErr) { sendError(res, "db_error", storyErr.message); return; }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can save this story"); return; }
  if ((story as any).saved_to_highlight_id) { res.status(200).json({ highlightId: (story as any).saved_to_highlight_id }); return; }

  const expiresAt =
    parsed.data.expiresInHours === null
      ? null
      : new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000).toISOString();

  // Story visibility does not map onto the highlight vocabulary
  // (public|travelers_nearby|circle_only|trip_only|private), and guessing a
  // wider one would publish the media further than the story ever was. Anything
  // that is not plainly public becomes `private`, and the owner can widen it.
  const highlightVisibility = (story as any).visibility === "public" ? "public" : "private";

  const { data: created, error: createErr } = await sc
    .from("highlights")
    .insert({
      owner_id: user.id,
      media_url: (story as any).media_url,
      media_type: (story as any).media_type,
      caption: (story as any).caption ?? null,
      visibility: highlightVisibility,
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();

  if (createErr || !created) {
    sendError(res, "db_error", createErr?.message ?? "Could not create the highlight");
    return;
  }

  const { error: linkErr } = await sc
    .from("stories")
    .update({ saved_to_highlight_id: (created as any).id, state: "saved" })
    .eq("id", id)
    .eq("owner_id", user.id);

  if (linkErr) {
    // The highlight exists but the story does not point at it. Say so rather
    // than reporting a clean save — a silent half-write here is how the same
    // media ends up saved twice.
    req.log.error({ err: linkErr, highlightId: (created as any).id }, "save-to-highlight: link write failed");
    sendError(res, "db_error", "The highlight was created but the story could not be linked to it.");
    return;
  }

  res.status(201).json({
    highlightId: (created as any).id,
    permanent: expiresAt === null,
    expiresAt,
  });
}));

// ── Expiry sweeper (called by health/cleanup cron) ────────────────────────────

/**
 * Sets state='expired' for all active stories past their expires_at.
 * Stories with saved_to_highlight_id keep state='saved' and are excluded.
 * Called from the health/cleanup endpoint — exported for direct use in tests.
 */
export async function sweepExpiredStories(sc: any): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("stories")
    .update({ state: "expired" })
    .eq("state", "active")
    .lt("expires_at", now)
    .is("saved_to_highlight_id", null)
    .select("id, media_url");
  if (error) throw error;
  const rows: any[] = data ?? [];

  // WHY THIS NO LONGER DELETES THE BYTES.
  //
  // It used to. The reasoning was sound at the time: "ephemeral" 24h stories
  // expired in STATE only and the file stayed publicly fetchable at its URL
  // forever, so the sweep removed the storage objects.
  //
  // Two things have since changed, and together they invert the answer.
  //
  //   1. `post-media` is no longer public. Migration 20260806 set
  //      public=false and 2089 revoked the unauthenticated read grant; every
  //      render now goes through the signed-URL relay, which asks
  //      lib/mediaAccess.canAccessMediaPath. Its story branch (3d) requires
  //      state ∈ (active, saved) AND an unexpired row, so an expired story's
  //      media is already denied to every viewer. The bytes are not reachable
  //      by URL; deletion is no longer what protects them.
  //
  //   2. Owner ruling 2026-09-06: an expired story is ARCHIVED, not gone — the
  //      owner can open it and re-post it. Deleting the object makes that
  //      impossible, and would make the archive a list of dead thumbnails: the
  //      row survives, the picture 404s, and nothing says why.
  //
  // The owner keeps access because canAccessMediaPath short-circuits on
  // ownership before branch 3d ("Owner always sees their own bytes"), so the
  // archive works for its owner and nobody else — which is the same boundary
  // the deletion was reaching for, enforced by authorization instead of by
  // destruction.
  //
  // NOT A LICENCE TO KEEP THEM FOREVER. This removes expiry-time deletion, not
  // retention. A retention sweep over the ARCHIVE (delete objects for stories
  // expired longer than the retention window, after warning the owner) is a
  // separate, deliberate job and does not exist yet.
  return rows.length;
}

export default router;
