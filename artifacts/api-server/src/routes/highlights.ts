import { Router } from "express";
import type { Response } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { canViewHighlight, type HighlightVisibility, type HighlightRecord } from "../lib/highlightPermissions";
import { canMessage } from "../lib/messagingPermissions";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

/* ============================================================================
 * Internal helper — resolve whether viewerId can access highlightId.
 * Checks blocks, loads highlight, resolves circle/trip membership, and calls
 * canViewHighlight. Returns null + sends the error response on failure.
 * ============================================================================ */
async function resolveViewAccess(
  sc: SupabaseClient,
  viewerId: string,
  highlightId: string,
  res: Response,
): Promise<{ h: HighlightRecord } | null> {
  const { data: h } = await sc
    .from("highlights")
    .select("id, owner_id, visibility, expires_at, deleted_at")
    .eq("id", highlightId)
    .maybeSingle();

  if (!h) {
    sendError(res, "not_found", "Highlight not found");
    return null;
  }

  const record = h as HighlightRecord;
  const ownerId = record.owner_id;

  // Block check (both directions)
  if (viewerId !== ownerId) {
    const [blockedByMe, blockingMe] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId).eq("blocked_id", ownerId).maybeSingle(),
      sc.from("blocks").select("blocker_id").eq("blocker_id", ownerId).eq("blocked_id", viewerId).maybeSingle(),
    ]);
    if (blockedByMe.data || blockingMe.data) {
      sendError(res, "not_found", "Highlight not found");
      return null;
    }
  }

  // Resolve circle/trip membership when needed
  let viewerFollowsOwner = viewerId === ownerId;
  let sharesTrip = viewerId === ownerId;

  if (viewerId !== ownerId && (record.visibility === "circle_only" || record.visibility === "trip_only")) {
    const [circleMember, myTripRows] = await Promise.all([
      sc.from("circle_memberships").select("other_id").eq("user_id", ownerId).eq("other_id", viewerId).maybeSingle(),
      sc.from("trip_members").select("trip_id").eq("user_id", viewerId).in("role", ["owner", "member"]),
    ]);
    viewerFollowsOwner = Boolean(circleMember.data);

    if (myTripRows.data && myTripRows.data.length > 0) {
      const myTripIds = myTripRows.data.map((r: any) => r.trip_id as string);
      const { data: sharedTrip } = await sc
        .from("trip_members")
        .select("trip_id")
        .eq("user_id", ownerId)
        .in("role", ["owner", "member"])
        .in("trip_id", myTripIds)
        .limit(1)
        .maybeSingle();
      sharesTrip = Boolean(sharedTrip);
    }
  }

  if (!canViewHighlight(viewerId, record, { viewerFollowsOwner, sharesTrip })) {
    sendError(res, "not_found", "Highlight not found");
    return null;
  }

  return { h: record };
}

/**
 * Terms a Highlight may be given. `null` is PERMANENT — the owner chose "never".
 *
 * Owner ruling 2026-09-06. Before it, 48 hours was the ceiling and there was no
 * way to say "keep this", which is why "save to Highlight" quietly meant
 * "re-publish this for 24 more hours and then lose it".
 */
const EXPIRY_HOURS = [3, 6, 12, 24, 48] as const;
export const PERMANENT: null = null;

/**
 * The visibility filter for a NON-OWNER read: live, or permanent.
 *
 * Written once because a bare `.gt("expires_at", …)` is invisibly wrong now —
 * `NULL > now()` is NULL, so every permanent Highlight would silently vanish
 * from any reader that forgets the NULL arm. Migration 2313 enforces the same
 * rule inside the RLS policies; this is its query-layer twin.
 *
 * NOT for owner-scoped reads. An owner sees their own Highlights whatever the
 * expiry says — an expired one is ARCHIVED, not gone.
 */
export function liveOrPermanent(nowIso = new Date().toISOString()): string {
  return `expires_at.is.null,expires_at.gt.${nowIso}`;
}
const MAX_VIDEO_DURATION_SECONDS = 10;

const KNOWN_FILTER_IDS = [
  'original', 'wanderlust', 'golden_hour', 'deep_ocean', 'mist', 'polaroid',
  'noir', 'safari', 'vivid', 'sunset', 'arctic', 'velvet',
] as const;

const createHighlightSchema = z.object({
  mediaUrl: z.string().min(1, "media_url is required"),
  mediaType: z.string().min(1),
  videoDurationSeconds: z.number().nullable().optional(),
  caption: z.string().max(500).nullable().optional(),
  locationName: z.string().max(200).nullable().optional(),
  locationCity: z.string().max(100).nullable().optional(),
  locationCountry: z.string().max(100).nullable().optional(),
  visibility: z
    .enum(["public", "travelers_nearby", "circle_only", "trip_only", "private"])
    .default("public"),
  // `null` means PERMANENT. It is spelled explicitly rather than by omission:
  // a caller that simply leaves the field out still gets the 24h default, so a
  // forgetful client can never create a permanent Highlight by accident.
  expiresInHours: z
    .union([z.number().int(), z.null()])
    .refine((h) => h === null || EXPIRY_HOURS.includes(h as any), {
      message: `expiresInHours must be null (permanent) or one of: ${EXPIRY_HOURS.join(", ")}`,
    })
    .default(24),
  filterId: z.enum(KNOWN_FILTER_IDS).optional().default('original'),
  filterIntensity: z.number().int().min(0).max(100).optional().default(100),
  mediaThumbnailUrl: z.string().min(1).nullable().optional(),
  mediaDurationSeconds: z.number().int().min(0).max(10).nullable().optional(),
});

/* ============================================================================
 * POST /highlights — create a highlight
 * ============================================================================ */
router.post("/highlights", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = createHighlightSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  // Reject video highlights longer than 10 seconds, or with missing duration
  if (d.mediaType.startsWith("video/")) {
    if (d.videoDurationSeconds == null) {
      sendError(res, "invalid_payload", "videoDurationSeconds is required for video highlights.");
      return;
    }
    if (d.videoDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
      sendError(res, "invalid_payload", `Highlights and video Postcards can be up to ${MAX_VIDEO_DURATION_SECONDS} seconds.`);
      return;
    }
  }

  // NULL is the stored form of "permanent" (migration 2313). Never coalesce it
  // to a date: that is the silent-truncation defect this feature removes.
  const expiresAt =
    d.expiresInHours === null
      ? null
      : new Date(Date.now() + d.expiresInHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from("highlights")
    .insert({
      owner_id: user.id,
      media_url: d.mediaUrl,
      media_type: d.mediaType,
      video_duration_seconds: d.videoDurationSeconds ?? null,
      caption: d.caption ?? null,
      location_name: d.locationName ?? null,
      location_city: d.locationCity ?? null,
      location_country: d.locationCountry ?? null,
      visibility: d.visibility,
      expires_at: expiresAt,
      // filter_id / filter_intensity / media_thumbnail_url / media_duration_seconds
      // do not exist on the live highlights table — accepted in the payload for
      // client compatibility but not persisted.
    })
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to create highlight");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({
    ...(data as any),
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
  });
});

/* ============================================================================
 * GET /users/:userId/highlights — active highlights for a user
 * Filtered by viewer permissions + blocks.
 * ============================================================================ */
router.get("/users/:userId/highlights", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const targetId = req.params.userId;
  if (!UUID.test(targetId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  // Check blocks in both directions
  const [blocker, blocked] = await Promise.all([
    client.from("blocks").select("blocked_id").eq("blocker_id", user.id).eq("blocked_id", targetId).maybeSingle(),
    client.from("blocks").select("blocked_id").eq("blocker_id", targetId).eq("blocked_id", user.id).maybeSingle(),
  ]);
  if (blocker.data || blocked.data) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const isOwnProfile = user.id === targetId;

  // Load active (non-expired, non-deleted) highlights for target user
  const { data: rows, error } = await client
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .eq("owner_id", targetId)
    .is("deleted_at", null)
    .or(liveOrPermanent())
    .order("created_at", { ascending: true });

  if (error) {
    req.log.error({ err: error }, "Failed to load user highlights");
    sendError(res, "db_error", error.message);
    return;
  }

  const highlights = (rows ?? []) as any[];

  // For non-owners, check circle (follows) + trip membership to filter restricted visibility
  let viewerFollowsOwner = false;
  let sharesTrip = false;

  if (!isOwnProfile && highlights.some((h) => ["circle_only", "trip_only"].includes(h.visibility))) {
    const sc = getServiceClient();
    if (sc) {
      const [circleMember, tripRows] = await Promise.all([
        sc.from("circle_memberships").select("other_id").eq("user_id", targetId).eq("other_id", user.id).maybeSingle(),
        sc.from("trip_members").select("trip_id").eq("user_id", user.id).in("role", ["owner", "member"]),
      ]);
      viewerFollowsOwner = Boolean(circleMember.data);
      if (tripRows.data && tripRows.data.length > 0) {
        const myTripIds = tripRows.data.map((r: any) => r.trip_id as string);
        const { data: sharedTrip } = await sc
          .from("trip_members")
          .select("trip_id")
          .eq("user_id", targetId)
          .in("role", ["owner", "member"])
          .in("trip_id", myTripIds)
          .limit(1)
          .maybeSingle();
        sharesTrip = Boolean(sharedTrip);
      }
    }
  }

  if (isOwnProfile) {
    viewerFollowsOwner = true;
    sharesTrip = true;
  }

  // Filter by permission
  const visible = highlights.filter((h) =>
    canViewHighlight(user.id, h as any, { viewerFollowsOwner, sharesTrip }),
  );

  if (visible.length === 0) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const highlightIds = visible.map((h: any) => h.id as string);

  // Batch-fetch view + like counts + viewer status
  const [viewRows, likeRows, viewedRows, likedRows] = await Promise.all([
    client.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    client.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    client.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    client.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows.data ?? []).map((r: any) => r.highlight_id as string));

  // Fetch author profile once
  const sc = getServiceClient();
  let author: any = null;
  if (sc) {
    const { data: p } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", targetId).maybeSingle();
    if (p) {
      const allowedNames = await nameVisibilitySet(sc, [targetId]);
      author = { id: (p as any).id, handle: (p as any).handle, name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)), avatarUrl: (p as any).avatar_url ?? null };
    }
  }

  const result = visible.map((h: any) => ({
    ...h,
    author,
    viewCount: viewCountMap[h.id] ?? 0,
    likeCount: likeCountMap[h.id] ?? 0,
    viewedByMe: viewedSet.has(h.id),
    likedByMe: likedSet.has(h.id),
  }));

  res.status(200).json({ highlights: result });
});

/* ============================================================================
 * GET /highlights/active — all active highlights visible to current user
 * Supports ?userId=, ?city=, ?tripId=, ?limit=
 * ============================================================================ */
router.get("/highlights/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const filterUserId = typeof req.query.userId === "string" && UUID.test(req.query.userId) ? req.query.userId : null;
  const filterCity = typeof req.query.city === "string" ? req.query.city : null;
  const filterTripId = typeof req.query.tripId === "string" && UUID.test(req.query.tripId) ? req.query.tripId : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Resolve trip member IDs when tripId filter is provided
  let tripMemberIds: Set<string> | null = null;
  let viewerTripIds: string[] = [];

  if (filterTripId) {
    const { data: memberRows } = await sc
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", filterTripId)
      .in("role", ["owner", "member"]);
    const ids = (memberRows ?? []).map((r: any) => r.user_id as string);
    // Ensure the viewer is actually in the trip (or it's public — we still filter below)
    tripMemberIds = new Set(ids);
  }

  // Resolve trips the viewer is in (for trip_only permission checking)
  const { data: viewerTripRows } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", user.id)
    .in("role", ["owner", "member"]);
  viewerTripIds = (viewerTripRows ?? []).map((r: any) => r.trip_id as string);

  // Get blocks list for this user (both directions)
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);

  // Build query — include trip_only so trip members can see them
  let q = sc
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .is("deleted_at", null)
    .or(liveOrPermanent())
    .in("visibility", ["public", "travelers_nearby", "circle_only", "trip_only"])
    .order("created_at", { ascending: false })
    .limit(limit * 5); // over-fetch to account for permission filtering

  if (filterUserId) {
    (q as any) = (q as any).eq("owner_id", filterUserId);
  }
  if (filterCity) {
    (q as any) = (q as any).ilike("location_city", `%${filterCity}%`);
  }
  if (tripMemberIds && tripMemberIds.size > 0) {
    (q as any) = (q as any).in("owner_id", [...tripMemberIds]);
  }

  const { data: rows, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to load active highlights");
    sendError(res, "db_error", error.message);
    return;
  }

  // Filter out blocked users
  const unblocked = (rows ?? []).filter((h: any) => !blockedIds.has(h.owner_id as string));

  // For circle_only highlights, check circle_memberships (not general follows)
  const circleOwnerIds = [...new Set(
    unblocked.filter((h: any) => h.visibility === "circle_only").map((h: any) => h.owner_id as string)
  )];
  const followingSet = new Set<string>();
  if (circleOwnerIds.length > 0) {
    const { data: circleRows } = await sc
      .from("circle_memberships")
      .select("user_id")
      .eq("other_id", user.id)
      .in("user_id", circleOwnerIds);
    for (const r of circleRows ?? []) followingSet.add((r as any).user_id as string);
  }

  // For trip_only highlights, determine which owners share a trip with the viewer
  const tripOnlyOwnerIds = [...new Set(
    unblocked.filter((h: any) => h.visibility === "trip_only").map((h: any) => h.owner_id as string)
  )];
  const sharesTripSet = new Set<string>();
  if (tripOnlyOwnerIds.length > 0 && viewerTripIds.length > 0) {
    const { data: sharedRows } = await sc
      .from("trip_members")
      .select("user_id")
      .in("user_id", tripOnlyOwnerIds)
      .in("trip_id", viewerTripIds)
      .in("role", ["owner", "member"]);
    for (const r of sharedRows ?? []) sharesTripSet.add((r as any).user_id as string);
  }

  // Permission filter
  const visible = unblocked.filter((h: any) => {
    if (h.owner_id === user.id) return true;
    if (h.visibility === "public" || h.visibility === "travelers_nearby") return true;
    if (h.visibility === "circle_only") return followingSet.has(h.owner_id as string);
    if (h.visibility === "trip_only") return sharesTripSet.has(h.owner_id as string);
    return false;
  }).slice(0, limit);

  if (visible.length === 0) {
    res.status(200).json({ highlights: [] });
    return;
  }

  const highlightIds = visible.map((h: any) => h.id as string);
  const ownerIds = [...new Set(visible.map((h: any) => h.owner_id as string))];

  // Batch metrics + author profiles
  const [viewRows, likeRows, viewedRows, likedRows, profileRows] = await Promise.all([
    sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows.data ?? []).map((r: any) => r.highlight_id as string));

  const allowedNames = await nameVisibilitySet(sc, ownerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) {
    profileMap[(p as any).id] = { id: (p as any).id, handle: (p as any).handle, name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)), avatarUrl: (p as any).avatar_url ?? null };
  }

  const result = visible.map((h: any) => ({
    ...h,
    author: profileMap[h.owner_id] ?? null,
    viewCount: viewCountMap[h.id] ?? 0,
    likeCount: likeCountMap[h.id] ?? 0,
    viewedByMe: viewedSet.has(h.id),
    likedByMe: likedSet.has(h.id),
  }));

  res.status(200).json({ highlights: result });
});

/* ============================================================================
 * GET /highlights/archive — the owner's expired Highlights
 *
 * Owner ruling 2026-09-06: an expired Highlight is ARCHIVED, not gone. Before
 * it, expiry was terminal in the hardest possible way — the predicate lived in
 * both RLS SELECT policies OUTSIDE the owner branch, so an expired Highlight
 * became invisible to the person who made it, with no route able to see around
 * it. Migration 2313 moves that predicate inside the non-owner arm; this is the
 * surface that ruling was for.
 *
 * Deliberately NOT part of /highlights/active: the live strip is what other
 * people can see, and mixing the archive into it would put expired media back
 * in front of viewers. This is owner-only, always.
 * ============================================================================ */
router.get("/highlights/archive", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);

  // Expired only: a permanent Highlight (expires_at IS NULL) is live, not
  // archived, and a live-dated one has not expired yet.
  const { data: rows, error } = await client
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .eq("owner_id", user.id)
    .is("deleted_at", null)
    .not("expires_at", "is", null)
    .lte("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false })
    .limit(limit);

  if (error) {
    // A failed read is not an empty archive. Saying "you have nothing archived"
    // to someone whose archive we could not read is the exact defect this
    // codebase spent the day removing.
    req.log.error({ err: error }, "Failed to load highlight archive");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({
    highlights: (rows ?? []).map((h: any) => ({ ...h, archived: true })),
    // Stated so a client never has to infer it from an empty list.
    ok: true,
  });
});

/* ============================================================================
 * POST /highlights/:id/repost — put an archived Highlight back up
 *
 * Owner-only. Takes the same term vocabulary as creation, including `null` for
 * permanent, so re-posting is the same decision as posting.
 *
 * It re-dates the EXISTING row rather than inserting a copy: the media, the
 * caption, the place and the view history all belong to this Highlight, and a
 * duplicate row would fork them. `created_at` is left alone — this is the same
 * Highlight, posted again, not a new one pretending to be old.
 * ============================================================================ */
const repostSchema = z.object({
  expiresInHours: z
    .union([z.number().int(), z.null()])
    .refine((h) => h === null || EXPIRY_HOURS.includes(h as any), {
      message: `expiresInHours must be null (permanent) or one of: ${EXPIRY_HOURS.join(", ")}`,
    })
    .default(24),
});

router.post("/highlights/:id/repost", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const parsed = repostSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data: existing, error: readErr } = await client
    .from("highlights")
    .select("id, owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  // The read is checked before the row: `{data: null, error}` and "no such
  // highlight" are different answers, and only the second is a 404.
  if (readErr) {
    req.log.error({ err: readErr }, "Failed to read highlight for repost");
    sendError(res, "db_error", readErr.message);
    return;
  }
  if (!existing) { sendError(res, "not_found", "Highlight not found"); return; }
  if ((existing as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the owner can repost this highlight");
    return;
  }

  const expiresAt =
    parsed.data.expiresInHours === null
      ? null
      : new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from("highlights")
    .update({ expires_at: expiresAt, archived_at: null })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "Failed to repost highlight");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!data) {
    // The row moved between the ownership check and the write.
    sendError(res, "not_found", "Highlight not found");
    return;
  }

  res.json({ highlight: data, permanent: expiresAt === null });
});

/* ============================================================================
 * DELETE /highlights/:id — owner soft-delete
 * ============================================================================ */
router.delete("/highlights/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const { data: existing } = await client
    .from("highlights")
    .select("id, owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "Highlight not found"); return; }
  if ((existing as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can delete this highlight"); return; }

  const { error } = await client
    .from("highlights")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("owner_id", user.id);

  if (error) {
    req.log.error({ err: error }, "Failed to delete highlight");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(204).send();
});

/* ============================================================================
 * POST /highlights/:id/view — idempotent view upsert
 * ============================================================================ */
router.post("/highlights/:id/view", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify viewer has permission to see this highlight
  const access = await resolveViewAccess(sc, user.id, id, res);
  if (!access) return;

  // Idempotent upsert
  const { error } = await sc
    .from("highlight_views")
    .upsert({ highlight_id: id, viewer_id: user.id, viewed_at: new Date().toISOString() }, { onConflict: "highlight_id,viewer_id" });

  if (error) {
    req.log.error({ err: error }, "Failed to record highlight view");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json({ viewed: true });
});

/* ============================================================================
 * POST /highlights/:id/like — like a highlight
 * ============================================================================ */
router.post("/highlights/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing engagement
  const access = await resolveViewAccess(sc, user.id, id, res);
  if (!access) return;

  if (access.h.owner_id === user.id) {
    sendError(res, "invalid_payload", "Cannot like your own highlight");
    return;
  }

  await sc
    .from("highlight_likes")
    .upsert({ highlight_id: id, user_id: user.id }, { onConflict: "highlight_id,user_id", ignoreDuplicates: true });

  const { count } = await sc
    .from("highlight_likes")
    .select("*", { count: "exact", head: true })
    .eq("highlight_id", id);

  res.status(200).json({ likedByMe: true, likeCount: count ?? 0 });
});

/* ============================================================================
 * DELETE /highlights/:id/like — unlike a highlight
 * ============================================================================ */
router.delete("/highlights/:id/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing engagement
  const access = await resolveViewAccess(sc, user.id, id, res);
  if (!access) return;

  await sc.from("highlight_likes").delete().eq("highlight_id", id).eq("user_id", user.id);

  const { count } = await sc
    .from("highlight_likes")
    .select("*", { count: "exact", head: true })
    .eq("highlight_id", id);

  res.status(200).json({ likedByMe: false, likeCount: count ?? 0 });
});

/* ============================================================================
 * GET /highlights/:id/viewers — owner-only list of viewers
 * ============================================================================ */
router.get("/highlights/:id/viewers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const { data: h } = await client
    .from("highlights")
    .select("id, owner_id")
    .eq("id", id)
    .maybeSingle();

  if (!h) { sendError(res, "not_found", "Highlight not found"); return; }
  if ((h as any).owner_id !== user.id) { sendError(res, "forbidden", "Only the owner can see viewers"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: viewRows, error } = await sc
    .from("highlight_views")
    .select("viewer_id, viewed_at")
    .eq("highlight_id", id)
    .order("viewed_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "Failed to load highlight viewers");
    sendError(res, "db_error", error.message);
    return;
  }

  const viewerIds = (viewRows ?? []).map((r: any) => r.viewer_id as string);
  if (viewerIds.length === 0) {
    res.status(200).json({ viewers: [] });
    return;
  }

  const [profileRows, likeRows] = await Promise.all([
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", viewerIds),
    sc.from("highlight_likes").select("user_id").eq("highlight_id", id).in("user_id", viewerIds),
  ]);

  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) profileMap[(p as any).id] = p;
  const likedSet = new Set<string>((likeRows.data ?? []).map((r: any) => r.user_id as string));
  const allowedNames = await nameVisibilitySet(sc, viewerIds);

  const viewers = (viewRows ?? []).map((r: any) => {
    const p = profileMap[r.viewer_id] ?? {};
    return {
      user_id: r.viewer_id,
      handle: (p as any).handle ?? null,
      name: presentedName(p as any, r.viewer_id === user.id || allowedNames.has(r.viewer_id as string)),
      avatar_url: (p as any).avatar_url ?? null,
      viewed_at: r.viewed_at,
      liked: likedSet.has(r.viewer_id as string),
    };
  });

  res.status(200).json({ viewers });
});

/* ============================================================================
 * POST /highlights/:id/reply — create a Telegraph DM thread for a highlight reply
 * ============================================================================ */
router.post("/highlights/:id/reply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) { sendError(res, "invalid_payload", "message is required"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access before allowing reply
  const access = await resolveViewAccess(sc, user.id, id, res);
  if (!access) return;

  const ownerId = access.h.owner_id;
  if (ownerId === user.id) {
    sendError(res, "invalid_payload", "Cannot reply to your own highlight");
    return;
  }

  // Enforce messaging permissions — honour the recipient's privacy settings and block rules.
  // This mirrors the canMessage gate used by POST /api/users/:userId/open-thread.
  const msgVerdict = await canMessage(sc, user.id, ownerId);
  if (!msgVerdict.allowed) {
    if (msgVerdict.verdict === "requires_request") {
      sendError(res, "forbidden", "You must send a message request before replying to this highlight");
    } else {
      sendError(res, "forbidden", "You cannot send messages to this user");
    }
    return;
  }

  // Find or create a DM thread between replier and highlight owner.
  // Mirrors the pattern used by POST /api/users/:userId/open-thread in messaging.ts:
  //   - look up all threads the replier is in
  //   - find one where BOTH users are members (2-person DM)
  //   - create a new one if none exists
  const { data: myMemberships } = await sc
    .from("message_thread_members")
    .select("thread_id")
    .eq("user_id", user.id);

  const myThreadIds = (myMemberships ?? []).map((m: any) => m.thread_id as string);
  let threadId: string | null = null;

  if (myThreadIds.length > 0) {
    const { data: allMembers } = await sc
      .from("message_thread_members")
      .select("thread_id, user_id")
      .in("thread_id", myThreadIds);

    const membersByThread: Record<string, Set<string>> = {};
    for (const m of (allMembers ?? []) as any[]) {
      if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = new Set();
      membersByThread[m.thread_id].add(m.user_id as string);
    }
    for (const [tid, members] of Object.entries(membersByThread)) {
      if (members.size === 2 && members.has(user.id) && members.has(ownerId)) {
        threadId = tid;
        break;
      }
    }
  }

  // Create a new DM thread if none exists (same schema as messaging route)
  if (!threadId) {
    const now = new Date().toISOString();
    const { data: newThread, error: threadErr } = await sc
      .from("message_threads")
      .insert({ created_at: now, updated_at: now })
      .select("id")
      .single();
    if (threadErr || !newThread) {
      req.log.error({ err: threadErr }, "Failed to create DM thread for highlight reply");
      sendError(res, "db_error", "Could not create message thread", { exposeDetail: true });
      return;
    }
    threadId = (newThread as any).id as string;
    const now2 = new Date().toISOString();
    // supabase-js resolves rather than throws on a write error — membership is
    // the only gate on the thread, so an unchecked failure here creates a
    // permanently-unreadable orphan thread (same defect as audit M1 in
    // messaging.ts). Check it and roll the just-created thread back.
    const { error: memErr } = await sc.from("message_thread_members").insert([
      { thread_id: threadId, user_id: user.id, joined_at: now2 },
      { thread_id: threadId, user_id: ownerId, joined_at: now2 },
    ]);
    if (memErr) {
      req.log.error({ err: memErr, threadId }, "highlight reply: thread members insert failed — rolling back orphan thread");
      await sc.from("message_threads").delete().eq("id", threadId);
      sendError(res, "db_error", "Could not create message thread", { exposeDetail: true });
      return;
    }
  }

  // Send a system context message linking to the highlight (cosmetic — a
  // failure is logged but does not block the actual reply below).
  const { error: ctxErr } = await sc.from("messages").insert({
    thread_id: threadId,
    sender_id: user.id,
    body: `↩ Replied to your highlight`,
    msg_type: "highlight_reply",
    subtype: id,
  });
  if (ctxErr) {
    req.log.warn({ err: ctxErr, threadId }, "highlight reply: context message insert failed");
  }

  // Send the actual reply message. Unchecked, this returned 200 {threadId} with
  // NOTHING sent — the sender believed the reply was delivered.
  const { error: msgErr } = await sc.from("messages").insert({
    thread_id: threadId,
    sender_id: user.id,
    body: message,
    msg_type: "text",
  });
  if (msgErr) {
    req.log.error({ err: msgErr, threadId }, "highlight reply: message insert failed");
    sendError(res, "db_error", "Could not send the reply", { exposeDetail: true });
    return;
  }

  // Record the reply in highlight_replies (best-effort, but observable)
  const { error: recErr } = await sc
    .from("highlight_replies")
    .insert({ highlight_id: id, replier_id: user.id, thread_id: threadId });
  if (recErr) {
    req.log.warn({ err: recErr, highlightId: id }, "highlight_replies insert failed — reply not recorded on the highlight");
  }

  res.status(200).json({ threadId });
});

/* ============================================================================
 * POST /highlights/:id/report
 * ============================================================================ */
router.post("/highlights/:id/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid highlight id"); return; }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "inappropriate";

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Enforce access — can only report highlights you can actually see
  const access = await resolveViewAccess(sc, user.id, id, res);
  if (!access) return;

  if (access.h.owner_id === user.id) {
    sendError(res, "invalid_payload", "Cannot report your own highlight");
    return;
  }

  await sc
    .from("highlight_reports")
    .upsert({ highlight_id: id, reporter_id: user.id, reason }, { onConflict: "highlight_id,reporter_id" });

  // Compass: record negative signal + immediately end fair exposure for the reported author.
  // Import lazily to keep highlights.ts independent of the compass subsystem.
  const authorId: string = access.h.owner_id;
  import("../compass/CompassActiveUserRewardEngine.js").then(({ recordActivityEvent }) => {
    recordActivityEvent(sc, authorId, "report_received");
  }, () => {});
  import("../compass/CompassFairExposureEngine.js").then(({ endFairExposure }) => {
    endFairExposure(sc, authorId, "report");
  }, () => {});

  // Invalidate compass cache for the reporter (their feed should not continue to
  // surface content they reported) and the reported author (exposure adjusted).
  await Promise.allSettled([
    invalidateCompassCache(sc, user.id,   "highlight_report_submitted"),
    invalidateCompassCache(sc, authorId,  "highlight_report_received"),
  ]);

  res.status(204).send();
});

/* ============================================================================
 * GET /highlights/following-feed
 * Returns users the current user follows who have active highlights,
 * grouped per user with their full highlight objects.
 * ============================================================================ */
router.get("/highlights/following-feed", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // 1. Get followed user IDs
  const { data: followRows } = await sc
    .from("user_follows")
    .select("following_id")
    .eq("follower_id", user.id);

  const followingIds = (followRows ?? []).map((r: any) => r.following_id as string);
  if (followingIds.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 2. Resolve blocked users (both directions) and filter them out
  const [blockedByMe, blockingMe] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
    sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
  ]);
  const blockedIds = new Set<string>([
    ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
    ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
  ]);
  const eligibleIds = followingIds.filter((id: string) => !blockedIds.has(id));
  if (eligibleIds.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 3. Fetch active (non-expired, non-deleted, non-private) highlights from followed users
  const { data: rows, error } = await sc
    .from("highlights")
    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
    .in("owner_id", eligibleIds)
    .is("deleted_at", null)
    .or(liveOrPermanent())
    .neq("visibility", "private")
    .order("created_at", { ascending: true });

  if (error) {
    req.log.error({ err: error }, "Failed to load following highlights feed");
    sendError(res, "db_error", error.message);
    return;
  }

  const allHighlights = (rows ?? []) as any[];
  if (allHighlights.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 4. Resolve restricted visibility (circle_only / trip_only) in batch
  const circleOwnerIds = [...new Set(
    allHighlights.filter((h) => h.visibility === "circle_only").map((h) => h.owner_id as string),
  )];
  const tripOnlyOwnerIds = [...new Set(
    allHighlights.filter((h) => h.visibility === "trip_only").map((h) => h.owner_id as string),
  )];

  const circleApprovedSet = new Set<string>();
  const sharesTripSet = new Set<string>();

  await Promise.all([
    circleOwnerIds.length > 0
      ? sc
          .from("circle_memberships")
          .select("user_id")
          .eq("other_id", user.id)
          .in("user_id", circleOwnerIds)
          .then(({ data }) => {
            for (const r of data ?? []) circleApprovedSet.add((r as any).user_id as string);
          })
      : Promise.resolve(),
    tripOnlyOwnerIds.length > 0
      ? sc
          .from("trip_members")
          .select("trip_id")
          .eq("user_id", user.id)
          .in("role", ["owner", "member"])
          .then(async ({ data: viewerTrips }) => {
            const vtIds = (viewerTrips ?? []).map((r: any) => r.trip_id as string);
            if (vtIds.length === 0) return;
            const { data: shared } = await sc
              .from("trip_members")
              .select("user_id")
              .in("user_id", tripOnlyOwnerIds)
              .in("trip_id", vtIds)
              .in("role", ["owner", "member"]);
            for (const r of shared ?? []) sharesTripSet.add((r as any).user_id as string);
          })
      : Promise.resolve(),
  ]);

  // 5. Permission filter
  const visible = allHighlights.filter((h) => {
    if (h.visibility === "public" || h.visibility === "travelers_nearby") return true;
    if (h.visibility === "circle_only") return circleApprovedSet.has(h.owner_id as string);
    if (h.visibility === "trip_only") return sharesTripSet.has(h.owner_id as string);
    return false;
  });

  if (visible.length === 0) {
    res.status(200).json({ users: [] });
    return;
  }

  // 6. Batch metrics + author profiles
  const highlightIds = visible.map((h: any) => h.id as string);
  const ownerIds = [...new Set(visible.map((h: any) => h.owner_id as string))];

  const [viewRows2, likeRows2, viewedRows2, likedRows2, profileRows] = await Promise.all([
    sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
    sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
    sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
    sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
  ]);

  const viewCountMap: Record<string, number> = {};
  const likeCountMap: Record<string, number> = {};
  for (const r of viewRows2.data ?? []) viewCountMap[(r as any).highlight_id] = (viewCountMap[(r as any).highlight_id] ?? 0) + 1;
  for (const r of likeRows2.data ?? []) likeCountMap[(r as any).highlight_id] = (likeCountMap[(r as any).highlight_id] ?? 0) + 1;
  const viewedSet = new Set<string>((viewedRows2.data ?? []).map((r: any) => r.highlight_id as string));
  const likedSet = new Set<string>((likedRows2.data ?? []).map((r: any) => r.highlight_id as string));

  const allowedNames = await nameVisibilitySet(sc, ownerIds);
  const profileMap: Record<string, any> = {};
  for (const p of profileRows.data ?? []) {
    profileMap[(p as any).id] = {
      userId: (p as any).id,
      handle: (p as any).handle ?? null,
      name: presentedName(p as any, (p as any).id === user.id || allowedNames.has((p as any).id)),
      avatarUrl: (p as any).avatar_url ?? null,
    };
  }

  // 7. Group by owner, preserving the order highlights came back
  const grouped = new Map<string, { profile: any; highlights: any[] }>();
  for (const h of visible) {
    const ownerId = h.owner_id as string;
    if (!grouped.has(ownerId)) {
      grouped.set(ownerId, { profile: profileMap[ownerId] ?? null, highlights: [] });
    }
    const author = profileMap[ownerId]
      ? { id: profileMap[ownerId].userId, handle: profileMap[ownerId].handle, name: profileMap[ownerId].name, avatarUrl: profileMap[ownerId].avatarUrl }
      : null;
    grouped.get(ownerId)!.highlights.push({
      ...h,
      author,
      viewCount: viewCountMap[h.id] ?? 0,
      likeCount: likeCountMap[h.id] ?? 0,
      viewedByMe: viewedSet.has(h.id),
      likedByMe: likedSet.has(h.id),
    });
  }

  const users = [...grouped.values()]
    .filter((g) => g.profile !== null)
    .map((g) => ({
      userId: g.profile.userId,
      handle: g.profile.handle,
      name: g.profile.name,
      avatarUrl: g.profile.avatarUrl,
      highlights: g.highlights,
    }));

  res.status(200).json({ users });
});

export default router;
