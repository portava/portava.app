import { Router } from "express";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import {
  requireUser,
  sendError,
  isAcceptedTripMember,
  tripExists,
} from "../lib/http";
import {
  createPostSchema,
  updatePostSchema,
  listPostsQuerySchema,
} from "../lib/postSchemas";
import { verifyLocation, shouldCreatePostcard } from "../lib/locationVerify";
import { upsertCityStamp } from "../lib/stampHelper";
import { getServiceClient } from "../lib/supabase";
import { writePulseGeoTag } from "../services/location/PulseGeoTagService";

const router = Router();

const STORAGE_BUCKET = "post-media";
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/* ===========================================================================
 * POST /media/upload  — authenticated media upload proxied through API server
 * ===========================================================================
 * Client sends raw binary body with Content-Type = MIME type.
 * Server uses service-role key to upload to Supabase Storage, bypassing RLS.
 * Files stored at post-media/{userId}/{timestamp}.{ext}.
 * Returns { url, path }.
 */
router.post(
  "/media/upload",
  (req, res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { (req as any).rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
  },
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const mimeType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const ext = ALLOWED_MIME[mimeType];
    if (!ext) {
      sendError(res, "invalid_payload", `Unsupported media type: ${mimeType}`);
      return;
    }
    const rawBody: Buffer = (req as any).rawBody;
    if (!rawBody || rawBody.length === 0) {
      sendError(res, "invalid_payload", "Empty file body");
      return;
    }
    const path = `${user.id}/${Date.now()}.${ext}`;
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Storage not configured"); return; }

    const { error } = await sc.storage
      .from(STORAGE_BUCKET)
      .upload(path, rawBody, { contentType: mimeType, upsert: false });
    if (error) {
      req.log.error({ err: error, path }, "Storage upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }
    const { data: urlData } = sc.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    res.status(201).json({ url: urlData.publicUrl, path });
  },
);

// Columns returned to clients (never expose nothing extra; these are all safe).
const POST_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at";

/* ===========================================================================
 * POST /posts  — create a standalone or trip-attached post
 * ===========================================================================
 * - requires a valid bearer token (author = verified user; client author_id ignored)
 * - if trip_id present: trip must exist AND user must be owner/accepted member
 * - visibility=trip_only requires trip_id (schema + DB both enforce)
 * - service-role insert; audit fields set server-side
 */
router.post("/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = createPostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { content, mediaUrls, tripId, visibility } = parsed.data;
  const {
    mediaType, addToPassport, locationName, locationPlaceId, locationCity,
    locationCountry, locationLat, locationLng, userGpsLat, userGpsLng, locationSource,
    locationVisibility,
    filterId, filterIntensity, mediaThumbnailUrl, mediaDurationSeconds,
  } = parsed.data;

  // Trip-attached: verify existence + accepted membership BEFORE writing.
  if (tripId) {
    if (!(await tripExists(client, tripId))) {
      sendError(res, "not_found", "Trip not found");
      return;
    }
    if (!(await isAcceptedTripMember(client, tripId, user.id))) {
      // invited-but-not-accepted, declined, removed, or non-member all land here
      sendError(res, "not_member", "You must be an accepted member of this trip to post to it");
      return;
    }
  }

  // SERVER-OWNED location verification. Client verification flags are never
  // trusted (they aren't accepted by the schema). We compute the result here.
  const verdict = verifyLocation({
    locationLat: locationLat ?? null,
    locationLng: locationLng ?? null,
    userGpsLat: userGpsLat ?? null,
    userGpsLng: userGpsLng ?? null,
    locationSource: locationSource ?? 'none',
  });

  const { data, error } = await client
    .from("posts")
    .insert({
      author_id: user.id, // verified user only — never from client
      trip_id: tripId ?? null,
      content: content ?? "",
      media_urls: mediaUrls ?? [],
      media_type: mediaType ?? null,
      visibility,
      status: "active",
      // tagged location
      location_name: locationName ?? null,
      location_place_id: locationPlaceId ?? null,
      location_city: locationCity ?? null,
      location_country: locationCountry ?? null,
      location_lat: locationLat ?? null,
      location_lng: locationLng ?? null,
      // private GPS (internal only; never in public projections)
      user_gps_lat: userGpsLat ?? null,
      user_gps_lng: userGpsLng ?? null,
      location_source: locationSource ?? 'none',
      // server-decided verification
      location_verified: verdict.locationVerified,
      location_verified_at: verdict.locationVerified ? new Date().toISOString() : null,
      location_distance_meters: verdict.distanceMeters,
      add_to_passport: addToPassport ?? true,
      created_by: user.id,
      updated_by: user.id,
      source: "api_server",
      // media filters
      filter_id: filterId ?? 'original',
      filter_intensity: filterIntensity ?? 100,
      media_thumbnail_url: mediaThumbnailUrl ?? null,
      media_duration_seconds: mediaDurationSeconds ?? null,
    })
    .select(POST_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert post");
    sendError(res, "db_error", error.message);
    return;
  }

  // Auto-create a passport postcard when eligible (media + add_to_passport +
  // active). Best-effort: a postcard failure must NOT corrupt the post. The
  // unique(post_id) constraint prevents duplicates.
  let postcard: any = null;
  if (shouldCreatePostcard({ mediaUrls: mediaUrls ?? [], addToPassport: addToPassport ?? true, status: 'active' })) {
    const pc = await client
      .from("passport_postcards")
      .insert({
        post_id: (data as any).id,
        user_id: user.id,
        media_url: (mediaUrls as string[])[0],
        caption: content ?? null,
        location_name: locationName ?? null,
        location_city: locationCity ?? null,
        location_country: locationCountry ?? null,
        location_verified: verdict.locationVerified,
        stamp_eligible: verdict.stampEligible,
        stamp_reason: verdict.stampReason,
        verification_method: verdict.verificationMethod,
        verified_distance_meters: verdict.distanceMeters,
        verified_at: verdict.locationVerified ? new Date().toISOString() : null,
        visibility,
        status: 'active',
      })
      .select("id, post_id, location_verified, stamp_eligible, stamp_reason, verification_method")
      .single();
    if (pc.error) {
      // Log but don't fail the post (rollback plan: posting must survive).
      req.log.error({ err: pc.error }, "Postcard auto-create failed (post still created)");
    } else {
      postcard = pc.data;

      // GPS-verified city stamp: earned only when stamp_eligible=true AND a
      // city name is present. Best-effort — stamp failure must not affect post.
      if (verdict.stampEligible && locationCity) {
        const sc = getServiceClient();
        if (sc) {
          await upsertCityStamp(sc, {
            userId: user.id,
            locationCity,
            locationCountry: locationCountry ?? null,
            postcardId: postcard.id,
          }, req.log);
        }
      }
    }
  }

  // Pulse GPS tag — write fire-and-forget after the post is committed.
  // Enforces privacy rules: off mode → no_location; hotel blur → neighborhood cap.
  // Never blocks the response; a failure must not corrupt the post.
  {
    const sc = getServiceClient();
    if (sc) {
      writePulseGeoTag(sc, {
        postId:                    (data as any).id,
        userId:                    user.id,
        userGpsLat:                userGpsLat   ?? null,
        userGpsLng:                userGpsLng   ?? null,
        locationCity:              locationCity ?? null,
        locationCountry:           locationCountry ?? null,
        venueName:                 locationName ?? null,
        locationVisibilityOverride: (locationVisibility ?? null) as any,
      }).catch((err) => {
        req.log.warn({ err }, "pulse_geo_tag write failed (non-fatal)");
      });
    }
  }

  res.status(201).json({ ...(data as any), postcard });

  // Feed Pulse post creation into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(client, {
    userId: user.id,
    eventType: "pulse_post_created",
    category: "content_quality",
    delta: 1,
    severity: "minor",
    sourceType: "pulse_post",
    sourceId: (data as any).id,
    dedupWindowHours: 2,
  });
});

// Safe public location labels (no GPS coordinates).
const FOLLOWING_POST_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at, " +
  "location_name, location_city, location_country";

/* ===========================================================================
 * GET /posts  — global feed OR following feed
 * ===========================================================================
 * feed=global (default): active PUBLIC STANDALONE posts for all users.
 * feed=following: public standalone posts from users the caller follows only.
 *
 * Hard privacy rules enforced at the query level for BOTH modes:
 *   - visibility = "public" only (never trip_only or private)
 *   - trip_id IS NULL (standalone only — no trip content leaks)
 *   - status = "active" (no deleted/hidden/reported posts)
 *   - never returns user_gps_lat/lng (not in any SELECT column list)
 * Auth required for both modes.
 */
router.get("/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = listPostsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { limit, before, feed } = parsed.data;

  // ── Following feed ────────────────────────────────────────────────────────
  if (feed === "following") {
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    // Step 1: who does this user follow?
    const { data: followRows, error: followErr } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user.id);
    if (followErr) {
      req.log.error({ err: followErr }, "Failed to load following list for feed");
      sendError(res, "db_error", followErr.message);
      return;
    }
    const followingIds: string[] = (followRows ?? []).map((r: any) => r.following_id);
    if (followingIds.length === 0) {
      res.status(200).json({ posts: [], feed: "following" });
      return;
    }

    // Step 2: public standalone active posts from followed users only.
    let q = sc
      .from("posts")
      .select(FOLLOWING_POST_COLUMNS)
      .in("author_id", followingIds)
      .is("trip_id", null)
      .eq("visibility", "public")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (before) q = q.lt("created_at", before);

    const { data: postRows, error: postErr } = await q;
    if (postErr) {
      req.log.error({ err: postErr }, "Failed to load following feed posts");
      sendError(res, "db_error", postErr.message);
      return;
    }
    const posts: any[] = postRows ?? [];

    // Step 3: batch-fetch author profiles (one query for all unique authors).
    const authorIds = [...new Set(posts.map((p) => p.author_id))];
    let profileMap: Record<string, any> = {};
    if (authorIds.length > 0) {
      const { data: profiles } = await sc
        .from("profiles")
        .select("id, handle, name, avatar_url")
        .in("id", authorIds);
      for (const p of profiles ?? []) profileMap[p.id] = p;
    }

    // Step 4: batch-fetch engagement counts + likedByMe (graceful pre-migration).
    const postIds = posts.map((p) => p.id);
    const engMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean }> = {};
    if (postIds.length > 0) {
      const [{ data: engData }, { data: likedData }] = await Promise.all([
        sc.from("posts").select("id, like_count, comment_count").in("id", postIds),
        sc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", postIds),
      ]);
      const likedSet = new Set<string>((likedData ?? []).map((r: any) => r.post_id));
      for (const r of engData ?? []) {
        engMap[r.id] = {
          likeCount: r.like_count ?? 0,
          commentCount: r.comment_count ?? 0,
          likedByMe: likedSet.has(r.id),
        };
      }
    }

    // Step 5: merge author + engagement into each post.
    const merged = posts.map((p) => {
      const pr = profileMap[p.author_id];
      const eng = engMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
      return {
        ...p,
        author: pr
          ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null }
          : null,
        likeCount: eng.likeCount,
        commentCount: eng.commentCount,
        likedByMe: eng.likedByMe,
        canLike: true,
        canComment: true,
        canShare: true,
      };
    });

    res.status(200).json({ posts: merged, feed: "following" });
    return;
  }

  // ── Global feed (default) ─────────────────────────────────────────────────
  const svc = getServiceClient();
  if (!svc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  let q = svc
    .from("posts")
    .select(POST_COLUMNS)
    .is("trip_id", null)
    .eq("visibility", "public")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);

  const { data, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to list posts");
    sendError(res, "db_error", error.message);
    return;
  }
  const globalPosts: any[] = data ?? [];
  const globalPostIds = globalPosts.map((p) => p.id);
  const globalAuthorIds = [...new Set(globalPosts.map((p) => p.author_id))];

  // Batch-fetch authors
  let globalProfileMap: Record<string, any> = {};
  if (globalAuthorIds.length > 0) {
    const { data: profiles } = await svc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", globalAuthorIds);
    for (const p of profiles ?? []) globalProfileMap[p.id] = p;
  }

  // Batch-fetch engagement (graceful pre-migration)
  const globalEngMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean }> = {};
  if (globalPostIds.length > 0) {
    const [{ data: engData }, { data: likedData }] = await Promise.all([
      svc.from("posts").select("id, like_count, comment_count").in("id", globalPostIds),
      svc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", globalPostIds),
    ]);
    const likedSet = new Set<string>((likedData ?? []).map((r: any) => r.post_id));
    for (const r of engData ?? []) {
      globalEngMap[r.id] = {
        likeCount: r.like_count ?? 0,
        commentCount: r.comment_count ?? 0,
        likedByMe: likedSet.has(r.id),
      };
    }
  }

  const mergedGlobal = globalPosts.map((p) => {
    const pr = globalProfileMap[p.author_id];
    const eng = globalEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
    return {
      ...p,
      author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null } : null,
      likeCount: eng.likeCount,
      commentCount: eng.commentCount,
      likedByMe: eng.likedByMe,
      canLike: true,
      canComment: true,
      canShare: true,
    };
  });

  res.status(200).json({ posts: mergedGlobal, feed: "global" });
});

/* ===========================================================================
 * GET /trips/:tripId/posts  — a trip's feed
 * ===========================================================================
 * - requires accepted membership to view trip_only content
 * - returns active posts attached to that trip that the user may see:
 *     public (anyone who can load the trip) + trip_only (accepted members)
 *   excludes other users' private posts.
 */
router.get("/trips/:tripId/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const tripId = req.params.tripId;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
    sendError(res, "invalid_payload", "Invalid trip id");
    return;
  }
  if (!(await tripExists(client, tripId))) {
    sendError(res, "not_found", "Trip not found");
    return;
  }

  const accepted = await isAcceptedTripMember(client, tripId, user.id);

  // Non-members may only ever see public trip-attached posts; accepted members
  // additionally see trip_only. Nobody sees another user's private post.
  let q = client
    .from("posts")
    .select(POST_COLUMNS)
    .eq("trip_id", tripId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(100);

  if (accepted) {
    // public + trip_only, plus own private
    q = q.or(
      `visibility.eq.public,visibility.eq.trip_only,and(visibility.eq.private,author_id.eq.${user.id})`,
    );
  } else {
    // public only, plus own private
    q = q.or(`visibility.eq.public,and(visibility.eq.private,author_id.eq.${user.id})`);
  }

  const { data, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to list trip posts");
    sendError(res, "db_error", error.message);
    return;
  }
  const tripPosts: any[] = data ?? [];
  const tripPostIds = tripPosts.map((p) => p.id);
  const tripAuthorIds = [...new Set(tripPosts.map((p) => p.author_id))];

  const tripSvc = getServiceClient();
  let tripProfileMap: Record<string, any> = {};
  if (tripSvc && tripAuthorIds.length > 0) {
    const { data: profiles } = await tripSvc
      .from("profiles").select("id, handle, name, avatar_url").in("id", tripAuthorIds);
    for (const p of profiles ?? []) tripProfileMap[p.id] = p;
  }

  const tripEngMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean }> = {};
  if (tripSvc && tripPostIds.length > 0) {
    const [{ data: engData }, { data: likedData }] = await Promise.all([
      tripSvc.from("posts").select("id, like_count, comment_count").in("id", tripPostIds),
      tripSvc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", tripPostIds),
    ]);
    const likedSet = new Set<string>((likedData ?? []).map((r: any) => r.post_id));
    for (const r of engData ?? []) {
      tripEngMap[r.id] = { likeCount: r.like_count ?? 0, commentCount: r.comment_count ?? 0, likedByMe: likedSet.has(r.id) };
    }
  }

  const mergedTrip = tripPosts.map((p) => {
    const pr = tripProfileMap[p.author_id];
    const eng = tripEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
    // public: any authenticated user; trip_only: accepted members only; private: no public engagement
    const canEngage = p.visibility === "public" || (p.visibility === "trip_only" && accepted);
    return {
      ...p,
      author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null } : null,
      likeCount: eng.likeCount,
      commentCount: eng.commentCount,
      likedByMe: eng.likedByMe,
      canLike: canEngage,
      canComment: canEngage,
      canShare: canEngage,
    };
  });

  res.status(200).json({ posts: mergedTrip, isMember: accepted });
});

/* ===========================================================================
 * PATCH /posts/:postId  — author-only edit
 * ===========================================================================
 */
router.patch("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postId = req.params.postId;
  const parsed = updatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Load the existing row (service role) to check ownership + cross-field rules.
  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, trip_id, visibility")
    .eq("id", postId)
    .maybeSingle();
  if (loadErr) {
    req.log.error({ err: loadErr }, "Failed to load post for update");
    sendError(res, "db_error", loadErr.message);
    return;
  }
  if (!existing) {
    sendError(res, "not_found", "Post not found");
    return;
  }
  if (existing.author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can edit this post");
    return;
  }

  // If changing visibility to trip_only, the post must have a trip.
  const nextVisibility = parsed.data.visibility ?? existing.visibility;
  if (nextVisibility === "trip_only" && !existing.trip_id) {
    sendError(res, "invalid_payload", "Cannot set trip_only on a standalone post");
    return;
  }

  const patch: Record<string, unknown> = { updated_by: user.id };
  if (parsed.data.content !== undefined) patch.content = parsed.data.content;
  if (parsed.data.mediaUrls !== undefined) patch.media_urls = parsed.data.mediaUrls;
  if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;

  const { data, error } = await client
    .from("posts")
    .update(patch)
    .eq("id", postId)
    .eq("author_id", user.id) // belt-and-suspenders ownership guard
    .select(POST_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update post");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json(data);
});

/* ===========================================================================
 * DELETE /posts/:postId  — author-only soft delete
 * ===========================================================================
 * Soft delete (status=deleted, deleted_at=now) so feeds hide it but the row is
 * retained for moderation/audit. Author only.
 */
router.delete("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postId = req.params.postId;

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .maybeSingle();
  if (loadErr) {
    sendError(res, "db_error", loadErr.message);
    return;
  }
  if (!existing) {
    sendError(res, "not_found", "Post not found");
    return;
  }
  if (existing.author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can delete this post");
    return;
  }

  const { error } = await client
    .from("posts")
    .update({ status: "deleted", deleted_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", postId)
    .eq("author_id", user.id);

  if (error) {
    req.log.error({ err: error }, "Failed to delete post");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(204).send();
});

/* ============================================================================
 * POST /posts/:postId/like  — like a post (idempotent)
 * DELETE /posts/:postId/like — unlike a post (idempotent)
 * ============================================================================
 */
function isValidUuid(s: string) {
  return /^[0-9a-f-]{36}$/i.test(s);
}

/** Returns true if the caller may engage with a post; sends 403 and returns false otherwise. */
async function checkEngagePermission(
  res: any,
  post: { visibility: string; trip_id: string | null },
  userId: string,
  userClient: any,
): Promise<boolean> {
  if (post.visibility === "private") {
    sendError(res, "forbidden", "Cannot engage with a private post");
    return false;
  }
  if (post.visibility === "trip_only") {
    if (!post.trip_id || !(await isAcceptedTripMember(userClient, post.trip_id, userId))) {
      sendError(res, "forbidden", "Only accepted trip members can engage with this post");
      return false;
    }
  }
  return true;
}

router.post("/posts/:postId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post, error: postErr } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (postErr) { sendError(res, "db_error", postErr.message); return; }
  if (!post) { sendError(res, "not_found", "Post not found"); return; }

  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  // Upsert (ignoreDuplicates = no-op if already liked)
  const { error: upsertErr } = await sc
    .from("posts_likes")
    .upsert({ post_id: postId, user_id: user.id }, { onConflict: "post_id,user_id", ignoreDuplicates: true });
  if (upsertErr) { sendError(res, "db_error", upsertErr.message); return; }

  // Accurate count + sync
  const { count } = await sc.from("posts_likes").select("id", { count: "exact", head: true }).eq("post_id", postId);
  await sc.from("posts").update({ like_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ likedByMe: true, likeCount: count ?? 0 });
});

router.delete("/posts/:postId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Allow unlike even if currently inaccessible (idempotent removal)
  const { data: post } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).maybeSingle();
  if (post && !(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { error: delErr } = await sc
    .from("posts_likes").delete().eq("post_id", postId).eq("user_id", user.id);
  if (delErr) { sendError(res, "db_error", delErr.message); return; }

  const { count } = await sc.from("posts_likes").select("id", { count: "exact", head: true }).eq("post_id", postId);
  await sc.from("posts").update({ like_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ likedByMe: false, likeCount: count ?? 0 });
});

/* ============================================================================
 * GET /posts/:postId/comments  — list visible comments
 * POST /posts/:postId/comments — add a comment
 * DELETE /posts/:postId/comments/:commentId — soft-delete own comment
 * ============================================================================
 */
router.get("/posts/:postId/comments", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify post exists and caller has read access
  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: rows, error: listErr } = await sc
    .from("posts_comments")
    .select("id, post_id, user_id, body, created_at, updated_at")
    .eq("post_id", postId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (listErr) { sendError(res, "db_error", listErr.message); return; }

  const commentRows: any[] = rows ?? [];
  const authorIds = [...new Set(commentRows.map((c) => c.user_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", authorIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const comments = commentRows.map((c) => {
    const pr = profileMap[c.user_id];
    return {
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at ?? null,
      canDelete: c.user_id === user.id,
      author: pr
        ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null }
        : { id: c.user_id, handle: "traveler", name: "Traveler", avatarUrl: null },
    };
  });

  res.status(200).json({ ok: true, comments });
});

router.post("/posts/:postId/comments", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Comment body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Comment must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: comment, error: insertErr } = await sc
    .from("posts_comments")
    .insert({ post_id: postId, user_id: user.id, body })
    .select("id, post_id, user_id, body, created_at, updated_at")
    .single();
  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  // Accurate count + sync
  const { count } = await sc.from("posts_comments").select("id", { count: "exact", head: true })
    .eq("post_id", postId).is("deleted_at", null);
  await sc.from("posts").update({ comment_count: count ?? 0 }).eq("id", postId);

  // Fetch author profile for response
  const { data: profile } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", user.id).single();

  res.status(201).json({
    ok: true,
    comment: {
      id: (comment as any).id,
      body: (comment as any).body,
      createdAt: (comment as any).created_at,
      updatedAt: null,
      canDelete: true,
      author: profile
        ? { id: profile.id, handle: profile.handle, name: profile.name, avatarUrl: profile.avatar_url ?? null }
        : { id: user.id, handle: "traveler", name: "Traveler", avatarUrl: null },
    },
    commentCount: count ?? 0,
  });
});

router.delete("/posts/:postId/comments/:commentId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId) || !isValidUuid(commentId)) {
    sendError(res, "invalid_payload", "Invalid id"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts_comments").select("id, user_id")
    .eq("id", commentId).eq("post_id", postId).is("deleted_at", null).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Comment not found"); return; }
  if ((existing as any).user_id !== user.id) { sendError(res, "forbidden", "Cannot delete someone else's comment"); return; }

  await sc.from("posts_comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);

  const { count } = await sc.from("posts_comments").select("id", { count: "exact", head: true })
    .eq("post_id", postId).is("deleted_at", null);
  await sc.from("posts").update({ comment_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ ok: true, commentCount: count ?? 0 });
});

export default router;
