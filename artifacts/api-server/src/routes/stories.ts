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
 * POST   /stories/:id/save-to-highlight — owner-only; saves story as a Highlight
 *        (only when the Story's audience maps faithfully onto a Highlight
 *        visibility — otherwise 409 not_promotable and the Story is untouched)
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
import { resolveHighlightVisibilityForStory, PROMOTABLE_STORY_VISIBILITIES } from "../lib/storyHighlightVisibility.js";
import { isBlockedBetween } from "../lib/blockGuard.js";
import { readBlockExclusions, isExcluded, sendExclusionsUnavailable } from "../lib/exclusionSet.js";

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

/* ============================================================================
 * Trip crew — the API's definition, not a local approximation.
 *
 * checkStoryAccess's trip_crew branch and /stories/feed both computed "shares a
 * trip" as
 *
 *     trip_members WHERE role IN ('owner','member')     -- and nothing else
 *
 * That is not what this API means by a trip member. lib/http.ts
 * requireTripMember — the definition of record — accepts a viewer when a
 * trip_members row exists with
 *     role IN ('owner','co_host','member','viewer')
 *     AND (status IS NULL OR status = 'accepted')
 * and, when NO row exists, when trips.owner_id is the viewer. trip_members
 * encodes "pending" in TWO columns — the legacy role='invited' and the current
 * status='invited' — so a predicate reading only one of them is defective in
 * both directions at once:
 *
 *   FAIL-OPEN   role='member', status='invited' (a PENDING invitee) and
 *               role='member', status='removed' (REMOVED from the trip) both
 *               passed, so someone who never joined a trip, or was thrown off
 *               it, read the trip_crew Stories of everyone on it.
 *   FAIL-CLOSED co_host and viewer are accepted crew everywhere else and were
 *               omitted; a trip owner holding no trip_members row was omitted.
 *
 * This is the same defect migration 2530 repaired in the RLS policy behind
 * highlights (highlights_select_active), and the same one routes/highlights.ts
 * fixed app-side in sharesAcceptedTrip. Stories carried it untouched. The rule
 * is duplicated here rather than imported because that is already this repo's
 * shape for it (lib/circleAccessGuard.ts, lib/mediaEligibility.ts,
 * routes/geofence.ts and routes/highlights.ts each hold their own copy); a
 * single home for all five is worth doing and is not this change.
 *
 * FAIL CLOSED. supabase-js RESOLVES on a database error, so an unchecked
 * `.data` reads as an empty result. Every read below checks `.error` and
 * returns { ok: false }; callers withhold rather than serve on the strength of
 * a lookup that did not happen.
 * ============================================================================ */
const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

function isAcceptedMembershipRow(r: { role?: string | null; status?: string | null }): boolean {
  if (!r.role || !ACCEPTED_TRIP_ROLES.has(r.role)) return false;
  return r.status == null || r.status === "accepted";
}

type CrewRead = { ok: true; ids: Set<string> } | { ok: false; error: unknown };

/**
 * The accepted crew of `tripId` — accepted trip_members rows, plus the
 * trips.owner_id fallback when the owner holds no row (requireTripMember's own
 * rule: the row wins when one exists, so an owner whose row says
 * status='removed' is NOT crew).
 */
async function acceptedCrewOfTrip(sc: any, tripId: string): Promise<CrewRead> {
  const [rows, trip] = await Promise.all([
    sc.from("trip_members").select("user_id, role, status").eq("trip_id", tripId),
    sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
  ]);
  if (rows.error) return { ok: false, error: rows.error };
  if (trip.error) return { ok: false, error: trip.error };
  const ids = new Set<string>();
  const rowUsers = new Set<string>();
  for (const r of (rows.data ?? []) as any[]) {
    rowUsers.add(r.user_id as string);
    if (isAcceptedMembershipRow(r)) ids.add(r.user_id as string);
  }
  const ownerId = (trip.data as any)?.owner_id as string | null | undefined;
  if (ownerId && !rowUsers.has(ownerId)) ids.add(ownerId);
  return { ok: true, ids };
}

/** The trips `userId` is accepted crew of, owner fallback included. */
async function acceptedTripsOfUser(sc: any, userId: string): Promise<CrewRead> {
  const [rows, owned] = await Promise.all([
    sc.from("trip_members").select("trip_id, role, status").eq("user_id", userId),
    sc.from("trips").select("id").eq("owner_id", userId),
  ]);
  if (rows.error) return { ok: false, error: rows.error };
  if (owned.error) return { ok: false, error: owned.error };
  const rowTrips = new Set<string>();
  const ids = new Set<string>();
  for (const r of (rows.data ?? []) as any[]) {
    rowTrips.add(r.trip_id as string);
    if (isAcceptedMembershipRow(r)) ids.add(r.trip_id as string);
  }
  for (const t of (owned.data ?? []) as any[]) {
    if (!rowTrips.has(t.id as string)) ids.add(t.id as string);
  }
  return { ok: true, ids };
}

/**
 * A single gate read: it either produced a verdict, or it could not be
 * performed. The second case is NOT "denied" — see checkStoryAccess.
 */
type GateRead = { ok: true; allowed: boolean } | { ok: false; error: unknown };

/**
 * Returns true if viewerId is on owner's close_friends list.
 *
 * `Boolean(data)` read a resolved DB error as "not a close friend": the deny
 * was right, but nothing anywhere could tell that answer apart from a real one,
 * which is the entry this file carries on the unchecked-reads ledger.
 */
async function isCloseFriend(sc: any, ownerId: string, viewerId: string): Promise<GateRead> {
  const { data, error } = await sc
    .from("close_friends")
    .select("friend_user_id")
    .eq("owner_id", ownerId)
    .eq("friend_user_id", viewerId)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, allowed: Boolean(data) };
}

/**
 * Returns true if viewerId is blocked by ownerId or vice-versa.
 *
 * FAIL-CLOSED, shape 1 (lib/exclusionSet.ts): this gates ONE interaction — may
 * this viewer read/view/react to this ONE story — so an unreadable `blocks`
 * table denies that story and nothing else. checkStoryAccess turns the true
 * into "not_found", which is exactly what a real block produces.
 *
 * `Boolean(r1.data || r2.data)` read a resolved DB error as "not blocked" on
 * BOTH halves at once, which is the fail-open shape the unchecked-reads ledger
 * recorded for this pair of reads.
 */
async function isBlocked(sc: any, a: string, b: string): Promise<boolean> {
  return isBlockedBetween(sc, a, b);
}

/**
 * The verdict on ONE story for ONE viewer.
 *
 * `denied` and `undecidable` both withhold the story, and both send the same
 * 404 — a 503 here would tell an unauthorized caller that the id names a live
 * story, which a 404 does not, and a single ephemeral story is not worth that
 * disclosure. They are still different facts, so they are different values and
 * the route LOGS the second. This is the same convention routes/highlights.ts
 * settled on for its own single-highlight gate: identical response, one log
 * line apart.
 *
 * (The LISTING surfaces do not have that tension and do not use this: an
 * unreadable gate there would state "this person has no stories", so
 * /stories/feed refuses with degraded_unavailable instead. See there.)
 */
type StoryAccess =
  | { allowed: true }
  | { allowed: false; reason: "denied" }
  | { allowed: false; reason: "undecidable"; error: unknown };

const ALLOW: StoryAccess = { allowed: true };
const DENY: StoryAccess = { allowed: false, reason: "denied" };
const undecidable = (error: unknown): StoryAccess => ({ allowed: false, reason: "undecidable", error });

/**
 * Resolves whether viewerId can read a story row.
 * Callers must have already confirmed state = 'active' and expiry not passed.
 *
 * Every gate read below binds and inspects `.error`. supabase-js RESOLVES on a
 * database error, so the old `Boolean(data)` / `(fwd.data && back.data)` forms
 * turned an unreadable follow graph, circle or crew into a confident "not
 * permitted" that nothing could distinguish from the real thing — the six
 * entries this file carries on the unchecked-reads ledger.
 */
async function checkStoryAccess(sc: any, story: any, viewerId: string): Promise<StoryAccess> {
  if (viewerId === story.owner_id) return ALLOW;

  if (await isBlocked(sc, story.owner_id, viewerId)) return DENY;

  const vis: StoryVisibility = story.visibility ?? "public";

  if (vis === "public") return ALLOW;

  if (vis === "close_friends" || story.close_friends_only) {
    const r = await isCloseFriend(sc, story.owner_id, viewerId);
    if (!r.ok) return undecidable(r.error);
    return r.allowed ? ALLOW : DENY;
  }

  if (vis === "friends_only") {
    const [fwd, back] = await Promise.all([
      sc.from("user_follows").select("following_id").eq("follower_id", story.owner_id).eq("following_id", viewerId).maybeSingle(),
      sc.from("user_follows").select("following_id").eq("follower_id", viewerId).eq("following_id", story.owner_id).maybeSingle(),
    ]);
    if (fwd.error || back.error) return undecidable(fwd.error ?? back.error);
    return (fwd.data && back.data) ? ALLOW : DENY;
  }

  if (vis === "circle_only") {
    const { data, error } = await sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", story.owner_id)
      .eq("other_id", viewerId)
      .maybeSingle();
    if (error) return undecidable(error);
    return data ? ALLOW : DENY;
  }

  if (vis === "trip_crew") {
    if (!story.trip_id) return DENY;
    // requireTripMember's rule, applied to BOTH people on the trip — see the
    // header above acceptedCrewOfTrip. The two self-joins this replaces read
    // `role IN ('owner','member')` and ignored `status` entirely, so a pending
    // invitee and a removed member were both admitted, and a co_host, a viewer
    // and a trip owner holding no row were all denied.
    const crew = await acceptedCrewOfTrip(sc, story.trip_id);
    if (!crew.ok) return undecidable(crew.error);
    return (crew.ids.has(viewerId) && crew.ids.has(story.owner_id)) ? ALLOW : DENY;
  }

  if (vis === "custom") {
    const hidden: string[] = story.hidden_user_ids ?? [];
    const allowed: string[] = story.allowed_user_ids ?? [];
    if (hidden.includes(viewerId)) return DENY;
    if (allowed.includes(viewerId)) return ALLOW;
    return DENY;
  }

  return DENY;
}

/**
 * The four single-story routes answer a withheld story identically; only the
 * log differs. One helper so a new route cannot forget the log line.
 */
function denyStory(req: any, res: any, access: StoryAccess, storyId: string): void {
  if (!access.allowed && access.reason === "undecidable") {
    req.log.error(
      { err: (access as any).error, storyId },
      "stories: visibility gate lookup failed — withholding story (reported as not_found)",
    );
  }
  sendError(res, "not_found", "Story not found");
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

  // Get blocks in both directions.
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts): every story in this feed
  // belongs to somebody other than the viewer, so the block set scopes the
  // entire response and there is no narrower part left to serve. `users: []`
  // would be a false statement — the client renders "no stories" and the viewer
  // believes it — so this refuses with `degraded_unavailable` (503, retryable),
  // the code for "the check could not be performed", and the client retries.
  //
  // `(blockedByMe.data ?? [])` turned a resolved DB error into an empty block
  // set and the feed served stories from blocked owners.
  const blockedIds = await readBlockExclusions(sc, user.id);
  if (!blockedIds.ok) {
    sendExclusionsUnavailable(req, res, blockedIds, "stories/feed");
    return;
  }

  // Resolve viewer context: follows (both directions), trips, circle memberships,
  // close-friends membership.
  //
  // "YOU HAVE NO STORIES" IS A CLAIM ABOUT OTHER PEOPLE'S LIVES, AND IT MUST BE
  // TRUE. Every one of these four reads decides WHO can appear in this feed at
  // all: candidateOwners below is built from the follow graph, the trip crew and
  // the circle, and if it comes out empty the handler returns `{ users: [] }`
  // and the client renders "no stories". supabase-js RESOLVES on a database
  // error, so `(followRows.data ?? [])` on an unreadable user_follows produced
  // exactly that empty set — a whole feed silently reported as "nobody you
  // follow has posted", from four lookups that never happened. The fifth
  // (close_friends) does not choose candidates but decides the close_friends
  // rung, so an error there silently hides a subset instead of all of it.
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts), exactly as the block read
  // directly above already does in this same handler: the failure scopes the
  // whole response and there is no narrower part left to serve honestly, so it
  // refuses with degraded_unavailable (503, retryable) rather than stating
  // something false and letting the client believe it.
  const [followRows, followerRows, tripMembership, circleMemberRows, closeFriendOfRows] = await Promise.all([
    sc.from("user_follows").select("following_id").eq("follower_id", user.id),
    sc.from("user_follows").select("follower_id").eq("following_id", user.id),
    // requireTripMember's rule, not `role IN ('owner','member')` — see the
    // header above acceptedCrewOfTrip. The old predicate put the viewer's
    // PENDING and REMOVED trips into this list.
    acceptedTripsOfUser(sc, user.id),
    sc.from("circle_memberships").select("user_id").eq("other_id", user.id),
    sc.from("close_friends").select("owner_id").eq("friend_user_id", user.id),
  ]);

  const contextErr =
    followRows.error ?? followerRows.error ??
    (tripMembership.ok ? null : (tripMembership as { error: unknown }).error) ??
    circleMemberRows.error ?? closeFriendOfRows.error;
  if (contextErr) {
    req.log.error({ err: contextErr, viewerId: user.id },
      "stories/feed: viewer context unreadable — refusing rather than reporting an empty feed");
    sendError(res, "degraded_unavailable", "We could not load your stories feed. Please try again.");
    return;
  }

  const followingIds = new Set<string>((followRows.data ?? []).map((r: any) => r.following_id as string));
  // followerIds: users who follow the viewer back (needed for mutual-follow / friends_only check)
  const followerIds = new Set<string>((followerRows.data ?? []).map((r: any) => r.follower_id as string));
  const viewerTripIds = [...(tripMembership as { ids: Set<string> }).ids];
  const circleOwnerIds = new Set<string>((circleMemberRows.data ?? []).map((r: any) => r.user_id as string));
  const closeFriendOfOwnerIds = new Set<string>((closeFriendOfRows.data ?? []).map((r: any) => r.owner_id as string));

  // Get trip member IDs for shared trips (for trip_crew visibility).
  // Accepted crew only, owner fallback included, and an unreadable crew refuses
  // for the same reason as the context reads above.
  const tripCrewIds = new Set<string>();
  if (viewerTripIds.length > 0) {
    const crews = await Promise.all(viewerTripIds.map((t) => acceptedCrewOfTrip(sc, t)));
    const crewErr = crews.find((c) => !c.ok);
    if (crewErr) {
      req.log.error({ err: (crewErr as { error: unknown }).error, viewerId: user.id },
        "stories/feed: trip crew unreadable — refusing rather than reporting an empty feed");
      sendError(res, "degraded_unavailable", "We could not load your stories feed. Please try again.");
      return;
    }
    for (const c of crews) {
      for (const uid of (c as { ids: Set<string> }).ids) {
        if (uid !== user.id) tripCrewIds.add(uid);
      }
    }
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
    if (isExcluded(blockedIds, s.owner_id as string)) return false;
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

// ── GET /stories/:id — get single story ──────────────────────────────────────

router.get("/stories/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // An unreadable `stories` table is not a missing story. supabase-js RESOLVES
  // on a DB error, so `const { data: story }` bound null and every one of these
  // handlers answered a table outage with "Story not found" — a statement about
  // the owner's content made from a lookup that never happened. §28.11.
  const { data: story, error: storyErr } = await sc
    .from("stories")
    .select(STORY_COLS)
    .eq("id", id)
    .maybeSingle();

  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: story read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).state !== "active") { sendError(res, "not_found", "Story not found"); return; }
  if (new Date((story as any).expires_at) <= new Date()) { sendError(res, "not_found", "Story not found"); return; }

  const access = await checkStoryAccess(sc, story, user.id);
  if (!access.allowed) { denyStory(req, res, access, id); return; }

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

  const { data: story, error: storyErr } = await client
    .from("stories")
    .select("id, owner_id, state")
    .eq("id", id)
    .maybeSingle();

  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: delete pre-read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete this story"); return; }

  // `.select("id")` is what makes this a real answer.
  //
  // An UPDATE with no .select() returns `data: null` and tells you NOTHING
  // about how many rows it touched, so `error === null` is not "it worked" —
  // it is "the statement ran". This one runs under the caller's own RLS
  // context, so a policy that no longer admits the row matches zero rows,
  // errors NOTHING, and this handler answered 204 "deleted" for a story that
  // is still live and still visible to everyone who could see it. A person
  // taking a Story down is entitled to know whether it came down.
  const { data: deleted, error } = await client
    .from("stories")
    .update({ state: "deleted" })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select("id");

  if (error) { req.log.error({ err: error }, "Failed to delete story"); sendError(res, "db_error", error.message); return; }
  if (!deleted || (deleted as any[]).length === 0) {
    req.log.error({ storyId: id, ownerId: user.id }, "stories: delete matched zero rows — story NOT deleted");
    sendError(res, "db_error", "The story could not be deleted. Please try again.", { exposeDetail: true });
    return;
  }

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

  const { data: story, error: storyErr } = await sc.from("stories").select("id, owner_id, state, expires_at, visibility, close_friends_only, allowed_user_ids, hidden_user_ids, trip_id").eq("id", id).maybeSingle();
  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: story read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
  if (!story || (story as any).state !== "active" || new Date((story as any).expires_at) <= new Date()) {
    sendError(res, "not_found", "Story not found"); return;
  }

  const access = await checkStoryAccess(sc, story, user.id);
  if (!access.allowed) { denyStory(req, res, access, id); return; }

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

  const { data: story, error: storyErr } = await sc.from("stories").select("id, owner_id, state, expires_at, visibility, close_friends_only, allowed_user_ids, hidden_user_ids, trip_id").eq("id", id).maybeSingle();
  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: story read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
  if (!story || (story as any).state !== "active" || new Date((story as any).expires_at) <= new Date()) {
    sendError(res, "not_found", "Story not found"); return;
  }

  const access = await checkStoryAccess(sc, story, user.id);
  if (!access.allowed) { denyStory(req, res, access, id); return; }

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

  const { data: story, error: storyErr } = await sc
    .from("stories")
    .select("id, owner_id, hide_viewer_list, state")
    .eq("id", id)
    .maybeSingle();

  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: viewers pre-read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
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

  // Get blocks (exclude blocked viewers from list).
  //
  // FAIL-CLOSED, shape 3 (lib/exclusionSet.ts): this response is nothing but a
  // roster of people, so the block set scopes all of it. `viewers: []` is not
  // the safe answer here, it is a wrong one — the owner reads it as "nobody has
  // seen this" — so it refuses with `degraded_unavailable` (503, retryable),
  // matching the db_error path this handler already has for an unreadable
  // story_views but distinguishing "could not check" from "read failed".
  //
  // `(blockedByMe.data ?? [])` previously made a resolved DB error an empty
  // block set and listed a blocked viewer to the story owner.
  const viewerCandidateIds = (viewRows ?? []).map((r: any) => r.viewer_id as string);
  const blockedIds = await readBlockExclusions(sc, user.id, { among: viewerCandidateIds });
  if (!blockedIds.ok) {
    sendExclusionsUnavailable(req, res, blockedIds, "stories/viewers");
    return;
  }

  const viewerIds = viewerCandidateIds.filter((v) => !isExcluded(blockedIds, v));

  if (viewerIds.length === 0) { res.status(200).json({ viewers: [], hidden: false }); return; }

  // An unreadable `profiles` is not an empty viewer list. The map below is
  // keyed off it and the final `.filter((v) => v.handle)` drops every entry
  // with no profile, so a profiles failure rendered "viewers: []" — the owner
  // reads that as "nobody has seen this". It is the same shape as the block
  // refusal directly above, and it gets the same answer.
  const { data: profiles, error: profilesErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url, verified")
    .in("id", viewerIds);
  if (profilesErr) {
    req.log.error({ err: profilesErr, storyId: id }, "stories: viewer profiles unreadable — refusing rather than reporting an empty viewer list");
    sendError(res, "degraded_unavailable", "We could not load who has seen this story. Please try again.");
    return;
  }

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

// ── POST /stories/:id/save-to-highlight — owner-only ─────────────────────────

router.post("/stories/:id/save-to-highlight", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story, error: storyErr } = await sc
    .from("stories")
    .select("id, owner_id, media_url, media_type, caption, state, expires_at, saved_to_highlight_id, visibility, close_friends_only, hidden_user_ids, allowed_user_ids, trip_id")
    .eq("id", id)
    .maybeSingle();

  if (storyErr) {
    req.log.error({ err: storyErr, storyId: id }, "stories: save-to-highlight pre-read failed");
    sendError(res, "db_error", storyErr.message);
    return;
  }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  if ((story as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can save this story"); return; }
  if ((story as any).saved_to_highlight_id) { res.status(200).json({ highlightId: (story as any).saved_to_highlight_id }); return; }

  // The Highlight's audience must never be WIDER than the Story's. This used to
  // hard-code `visibility: "public"`, so a close-friends Story became a public
  // Highlight. Only the rungs a Highlight can represent faithfully are promoted
  // (see lib/storyHighlightVisibility for the audit of each rung); every other
  // Story is REFUSED here, before anything is written, and left exactly as it
  // was — no state change, no highlight row, no saved_to_highlight_id. 409 with
  // a stable `state`/`reason` the client can render, pending the owner's
  // decision on how Highlights should carry the restricted audiences.
  const decision = resolveHighlightVisibilityForStory(story as any);
  if (!decision.ok) {
    req.log.info(
      { storyId: id, storyVisibility: decision.storyVisibility, reason: decision.reason },
      "save-to-highlight refused: no faithful Highlight visibility for this Story's audience",
    );
    res.status(409).json({
      error: "conflict",
      message: decision.message,
      state: decision.state,
      reason: decision.reason,
      storyVisibility: decision.storyVisibility,
      highlightVisibility: null,
      promotableStoryVisibilities: PROMOTABLE_STORY_VISIBILITIES,
    });
    return;
  }

  // Create a highlight from this story (24h highlight — saved stories get a 24h highlight window from now)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data: highlight, error: hErr } = await client
    .from("highlights")
    .insert({
      owner_id:    user.id,
      media_url:   (story as any).media_url,
      media_type:  (story as any).media_type,
      caption:     (story as any).caption ?? null,
      visibility:  decision.visibility,
      expires_at:  expiresAt,
      filter_id:   "original",
      filter_intensity: 100,
    })
    .select("id")
    .single();

  if (hErr) {
    req.log.error({ err: hErr }, "Failed to create highlight from story");
    sendError(res, "db_error", hErr.message);
    return;
  }

  // Link story → highlight.
  //
  // This write was issued and then thrown away entirely: no `error`, no
  // `.select()`, no branch. It is the write that makes save-to-highlight
  // IDEMPOTENT — the `saved_to_highlight_id` short-circuit at the top of this
  // handler is the only thing standing between a user tapping "save" twice and
  // two Highlights of the same Story — so losing it silently is not cosmetic.
  // An UPDATE without .select() returns `data: null`, so `error === null` did
  // not even mean a row was touched; under the caller's RLS an update matching
  // zero rows errors nothing at all.
  //
  // The highlight already exists at this point and IS the thing the caller
  // asked for, so this does not fail the request. It reports the link state
  // honestly instead: `linked: false` says the Story is not marked saved and a
  // second call will mint a second Highlight, which a client can surface and an
  // operator can see in the log.
  const { data: linkedRows, error: linkErr } = await client
    .from("stories")
    .update({ saved_to_highlight_id: (highlight as any).id, state: "saved" })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select("id");

  const linked = !linkErr && Array.isArray(linkedRows) && linkedRows.length > 0;
  if (!linked) {
    req.log.error(
      { err: linkErr, storyId: id, highlightId: (highlight as any).id, rows: (linkedRows as any[] | null)?.length ?? null },
      "stories: save-to-highlight link update did not take — story not marked saved, a repeat call will duplicate the highlight",
    );
  }

  res.status(201).json({ highlightId: (highlight as any).id, linked });
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

  // Audit privacy fix: "ephemeral" 24h stories previously expired in STATE only
  // — the file stayed publicly fetchable at its URL forever. Delete the storage
  // objects for the stories just expired. Safe: the saved_to_highlight_id IS
  // NULL filter above guarantees no highlight references this media. Best-effort
  // (a storage failure never breaks the sweep; rows are already expired).
  const paths: string[] = [];
  for (const r of rows) {
    const ref = appStorageUrlInfo(String(r.media_url ?? ""));
    if (ref && ref.bucket === "post-media") paths.push(ref.path);
  }
  if (paths.length > 0) {
    try {
      await sc.storage.from("post-media").remove(paths);
    } catch {
      /* best-effort */
    }
  }
  return rows.length;
}

export default router;
