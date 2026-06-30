import { Router } from "express";
import { z } from "zod";
import { enrichSpans } from "../lib/enrichSpans";
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
  locationPrivacyPatchSchema,
  sensitivityLevel,
  defaultPrivacyMode,
  geofenceRadius,
  safeLocationLabel,
  mapPublicPost,
  type LocationPrivacyMode,
} from "../lib/postSchemas";
import { verifyLocation, shouldCreatePostcard } from "../lib/locationVerify";
import { upsertCityStamp } from "../lib/stampHelper";
import { getServiceClient } from "../lib/supabase";
import { checkRateLimit } from "../lib/rateLimit";
import { writePulseGeoTag } from "../services/location/PulseGeoTagService";
import { processTagging } from "../services/tagging/TaggingService.js";
import { recordActivityEvent } from "../compass/CompassActiveUserRewardEngine.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";

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

// Columns returned to clients. NEVER include original_lat/original_lng or
// user_gps_lat/user_gps_lng — those are stored privately and must not leak.
const POST_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at, " +
  "location_name, location_city, location_country, " +
  "location_privacy_mode, post_status, " +
  "public_lat, public_lng, public_location_label, geofence_radius_meters, " +
  "publish_after_exit, publish_after_time, publish_eligible_at, published_at, location_sensitivity_level";

/**
 * Author-only column set for GET /posts/pending.  Extends POST_COLUMNS with
 * private fields safe to serve exclusively to the post owner:
 *   - location_lat / location_lng — used by the mobile geofence watcher
 *   - venue_name                  — internal venue used for geotag credit
 */
const PENDING_POST_COLUMNS =
  POST_COLUMNS + ", location_lat, location_lng, venue_name";

/**
 * Redact sensitive location fields from responses served to non-author
 * audiences.  The raw location_name (exact venue) must be suppressed
 * whenever a privacy mode is active — callers should use
 * public_location_label instead.
 *
 * Exceptions:
 *   - mode is null or 'none' → no privacy is set; expose as-is.
 *   - mode is delayed_until_exit/time AND post_status='published' → the
 *     geofence was cleared; location intentionally revealed.
 */

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
    locationCountry, locationLat, locationLng, userGpsLat, userGpsLng,
    locationSource: locationSrc,
    locationVisibility,
    filterId, filterIntensity, mediaThumbnailUrl, mediaDurationSeconds,
    locationPrivacyMode: reqPrivacyMode, publishAfterTime, geofenceRadiusMeters,
    venueName, venueId,
  } = parsed.data;
  const locationSource = locationSrc ?? 'none';

  // ── Delayed geotag: compute sensitivity / privacy mode / geofence radius ──
  const sens = sensitivityLevel(venueName ?? null);
  const privacyMode: LocationPrivacyMode = reqPrivacyMode ?? defaultPrivacyMode(locationSource, sens);
  const radius = geofenceRadius(sens, geofenceRadiusMeters ?? undefined);
  const publicLabel = safeLocationLabel(locationName ?? null, locationCity ?? null, locationCountry ?? null, privacyMode, sens);

  // Determine delayed-publish status from chosen privacy mode
  let delayedStatus: string = 'published';
  let publishAfterExitFlag = false;
  let publishEligibleAt: string | null = null;
  if (privacyMode === 'delayed_until_exit') {
    delayedStatus = 'pending_location_exit';
    publishAfterExitFlag = true;
  } else if (privacyMode === 'delayed_until_time' && publishAfterTime) {
    delayedStatus = 'pending_delay';
    publishEligibleAt = publishAfterTime;
  }

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
      location_source: locationSource,
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
      // ── delayed geotag fields ──────────────────────────────────────────────
      location_privacy_mode: privacyMode,
      geotag_verified: verdict.locationVerified,
      geotag_credit_awarded: false, // set to true below after anti-abuse check
      original_lat: locationLat ?? null,   // private — never in public SELECTs
      original_lng: locationLng ?? null,   // private — never in public SELECTs
      venue_id: venueId ?? null,
      venue_name: venueName ?? null,
      public_location_label: publicLabel,
      geofence_radius_meters: radius,
      publish_after_exit: publishAfterExitFlag,
      publish_after_time: publishAfterTime ?? null,
      publish_eligible_at: publishEligibleAt,
      location_sensitivity_level: sens,
      post_status: delayedStatus,
    })
    .select(POST_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert post");
    sendError(res, "db_error", error.message);
    return;
  }

  // Compass activity ingestion — fire-and-forget
  recordActivityEvent(
    getServiceClient(),
    user.id,
    "post_published",
    { city: locationCity ?? undefined },
  );

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

  // Write-time tagging: extract @mentions, enforce all permission/rate-limit rules,
  // write tag + hashtag_usage rows, then dispatch user_tagged notifications via
  // NotificationService (privacy guard + dedup) + NotificationRouter (push channels).
  // Non-fatal: a tagging failure must never block the post write path.
  {
    const sc = getServiceClient();
    if (sc && (content ?? '').trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: sc,
          authorId: user.id,
          sourceType: 'post',
          sourceId: (data as any).id,
          content: content ?? '',
          city: locationCity ?? null,
          country: locationCountry ?? null,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await sc.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc   = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'post',
                sourceId: (data as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a post.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'post tagging side-effect failed (non-fatal)');
      }
    }
  }

  // ── Geotag credit + anti-abuse (fire-and-forget, non-fatal) ────────────────
  // Credit is awarded at creation time (not publish time) when location is GPS-verified.
  // Anti-abuse: max 3 credits per user per venue per 24 h window.
  if (verdict.locationVerified && venueName) {
    const sc = getServiceClient();
    if (sc) {
      const rateLimited = await isGeotagCreditRateLimited(sc, user.id, venueName).catch(() => false);
      const postId = (data as any).id as string;
      if (rateLimited) {
        // Flag for safety review instead of awarding credit
        await sc.from("posts").update({ post_status: "pending_safety_review" }).eq("id", postId);
        await logDelayedEvent(sc, postId, user.id, "credit_rate_limited", {
          metadata: { venue_name: venueName, reason: "rate_limit_exceeded" },
        });
      } else {
        await sc.from("posts").update({ geotag_credit_awarded: true }).eq("id", postId);
        await logDelayedEvent(sc, postId, user.id, "geotag_credit_awarded", {
          metadata: { venue_name: venueName, sensitivity: sens },
        });
      }
    }
  }

  // Log created_pending event for all delayed posts
  if (delayedStatus !== 'published') {
    const sc = getServiceClient();
    if (sc) {
      await logDelayedEvent(sc, (data as any).id, user.id, "created_pending", {
        lat: locationLat ?? undefined,
        lng: locationLng ?? undefined,
        metadata: { privacy_mode: privacyMode, post_status: delayedStatus },
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

// Safe public location labels (no GPS coordinates). Same privacy contract as POST_COLUMNS.
const FOLLOWING_POST_COLUMNS = POST_COLUMNS;

// ── Delayed geotag helpers ────────────────────────────────────────────────────

/** Append an event to the delayed_post_location_events table. Non-fatal. */
async function logDelayedEvent(
  db: any,
  postId: string,
  userId: string,
  eventType: string,
  extra?: { lat?: number; lng?: number; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.from("delayed_post_location_events").insert({
      post_id: postId,
      user_id: userId,
      event_type: eventType,
      lat: extra?.lat ?? null,
      lng: extra?.lng ?? null,
      metadata: extra?.metadata ?? null,
    });
  } catch { /* non-fatal */ }
}

/**
 * Anti-abuse: check if the user has already received 3 geotag credits at the
 * same venue in the last 24 hours. Returns true when the cap is hit.
 */
async function isGeotagCreditRateLimited(
  db: any,
  userId: string,
  venueName: string | null,
): Promise<boolean> {
  if (!venueName) return false;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  try {
    const { count } = await db
      .from("delayed_post_location_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("event_type", "geotag_credit_awarded")
      .gte("created_at", since)
      .filter("metadata->>venue_name", "eq", venueName);
    return (count ?? 0) >= 3;
  } catch {
    return false;
  }
}

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

    // Step 2: public standalone active published posts from followed users only.
    let q = sc
      .from("posts")
      .select(FOLLOWING_POST_COLUMNS)
      .in("author_id", followingIds)
      .is("trip_id", null)
      .eq("visibility", "public")
      .eq("status", "active")
      .eq("post_status", "published")
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

    // Step 5: enrich with positioned @mention + #hashtag spans.
    const followingSpansMap = posts.length > 0
      ? await enrichSpans(sc, 'post', posts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
      : {};

    // Step 6: merge author + engagement + spans into each post.
    const merged = posts.map((p) => {
      const safe = mapPublicPost(p);
      const pr = profileMap[p.author_id];
      const eng = engMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
      const spans = (followingSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
      return {
        ...safe,
        author: pr
          ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null }
          : null,
        likeCount: eng.likeCount,
        commentCount: eng.commentCount,
        likedByMe: eng.likedByMe,
        canLike: true,
        canComment: true,
        canShare: true,
        tags: spans.tags,
        hashtagUsages: spans.hashtagUsages,
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
    .eq("post_status", "published")
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

  // Enrich with positioned @mention + #hashtag spans
  const globalSpansMap = globalPosts.length > 0
    ? await enrichSpans(svc, 'post', globalPosts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
    : {};

  // Batch-fetch saved state for the global feed
  const globalSavedSet = new Set<string>();
  try {
    if (globalPostIds.length > 0) {
      const { data: userCols } = await svc
        .from("collections")
        .select("id")
        .eq("owner_id", user.id);
      const colIds = ((userCols ?? []) as any[]).map((c) => c.id as string);
      if (colIds.length > 0) {
        const { data: savedItems } = await svc
          .from("collection_items")
          .select("entity_id")
          .eq("entity_type", "post")
          .in("collection_id", colIds)
          .in("entity_id", globalPostIds);
        for (const s of (savedItems ?? []) as any[]) globalSavedSet.add((s as any).entity_id as string);
      }
    }
  } catch { /* non-fatal */ }

  const mergedGlobal = globalPosts.map((p) => {
    const safe = mapPublicPost(p);
    const pr = globalProfileMap[p.author_id];
    const eng = globalEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
    const spans = (globalSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
    return {
      ...safe,
      author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null } : null,
      likeCount: eng.likeCount,
      commentCount: eng.commentCount,
      likedByMe: eng.likedByMe,
      saved: globalSavedSet.has(p.id as string),
      canLike: true,
      canComment: true,
      canShare: true,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
    };
  });

  // ── Hashtag boost for followed hashtags ──────────────────────────────────────
  // Posts that share at least one hashtag with the viewer's followed set are
  // surfaced slightly higher.  This is a soft-boost (re-sort within the page),
  // not a hard filter — the feed always contains non-followed posts too.
  const boostedPostIds = new Set<string>();
  try {
    if (globalPostIds.length > 0) {
      const { data: followedRows } = await svc
        .from("user_hashtag_follows")
        .select("hashtag_id")
        .eq("user_id", user.id);
      const followedHashtagIds = (followedRows ?? []).map((r: any) => r.hashtag_id as string);
      if (followedHashtagIds.length > 0) {
        const { data: matchRows } = await svc
          .from("hashtag_usage")
          .select("source_id")
          .eq("source_type", "post")
          .in("source_id", globalPostIds)
          .in("hashtag_id", followedHashtagIds);
        for (const r of matchRows ?? []) boostedPostIds.add((r as any).source_id as string);
      }
    }
  } catch { /* non-fatal — serve feed without boost on error */ }

  const finalPosts = boostedPostIds.size === 0
    ? mergedGlobal
    : [
        ...mergedGlobal.filter((p) => boostedPostIds.has(p.id)).map((p) => ({ ...p, hashtagBoosted: true })),
        ...mergedGlobal.filter((p) => !boostedPostIds.has(p.id)),
      ];

  res.status(200).json({ posts: finalPosts, feed: "global" });
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

  // Enrich with positioned @mention + #hashtag spans
  const tripSpansMap = (tripSvc && tripPosts.length > 0)
    ? await enrichSpans(tripSvc, 'post', tripPosts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
    : {};

  const mergedTrip = tripPosts.map((p) => {
    const pr = tripProfileMap[p.author_id];
    const eng = tripEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false };
    const spans = (tripSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
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
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
    };
  });

  res.status(200).json({ posts: mergedTrip, isMember: accepted });
});

/* ===========================================================================
 * GET /posts/pending  — author's own pending posts
 * ===========================================================================
 * Must be registered BEFORE any /posts/:postId route so Express does not
 * treat the literal "pending" as a :postId parameter.
 * Returns the caller's posts with status in (pending_location_exit,
 * pending_delay, pending_safety_review).
 */
router.get("/posts/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from("posts")
    .select(PENDING_POST_COLUMNS)
    .eq("author_id", user.id)
    .eq("status", "active")
    .in("post_status", ["pending_location_exit", "pending_delay", "pending_safety_review"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    req.log.error({ err: error }, "Failed to load pending posts");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json({ posts: data ?? [] });
});

/* ===========================================================================
 * GET /posts/:postId  — single post fetch (author sees own pending; others
 * only see published posts)
 * ===========================================================================
 */
router.get("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("posts")
    .select(POST_COLUMNS)
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Post not found"); return; }

  const post = data as any;
  const isAuthor = post.author_id === user.id;
  const isPublished = !post.post_status || post.post_status === "published";

  if (!isPublished && !isAuthor) {
    sendError(res, "not_found", "Post not found");
    return;
  }

  res.status(200).json(isAuthor ? post : mapPublicPost(post));
});

/* ===========================================================================
 * PATCH /posts/:postId/location-privacy  — change privacy mode
 * ===========================================================================
 * Author-only. Validates ownership, changes mode, recomputes post_status and
 * publish_eligible_at, logs a privacy_changed event.
 */
router.patch("/posts/:postId/location-privacy", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const parsed = locationPrivacyPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { locationPrivacyMode: newMode, publishAfterTime } = parsed.data;

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, post_status, location_sensitivity_level")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can change location privacy");
    return;
  }

  // Cannot change privacy on posts that are already published or canceled
  const currentStatus = (existing as any).post_status as string;
  if (currentStatus === "published" || currentStatus === "canceled" || currentStatus === "expired") {
    sendError(res, "invalid_payload", `Cannot change privacy on a ${currentStatus} post`);
    return;
  }

  const patch: Record<string, unknown> = { location_privacy_mode: newMode };
  if (newMode === "delayed_until_exit") {
    patch.post_status = "pending_location_exit";
    patch.publish_after_exit = true;
    patch.publish_eligible_at = null;
  } else if (newMode === "delayed_until_time" && publishAfterTime) {
    patch.post_status = "pending_delay";
    patch.publish_eligible_at = publishAfterTime;
    patch.publish_after_time = publishAfterTime;
  } else if (newMode === "none" || newMode === "hidden" || newMode === "city_only" || newMode === "trusted_circle_only") {
    patch.post_status = "published";
    patch.published_at = new Date().toISOString();
    patch.publish_eligible_at = null;
  }

  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update(patch)
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "privacy_changed", {
      metadata: { new_mode: newMode, new_status: patch.post_status },
    });
    await invalidateCompassCache(sc, user.id, "post_privacy_change");
  }

  res.status(200).json(updated);
});

/* ===========================================================================
 * POST /posts/:postId/publish-now-without-location  — strip location, publish
 * ===========================================================================
 */
router.post("/posts/:postId/publish-now-without-location", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, post_status")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can publish this post");
    return;
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update({
      post_status: "published",
      published_at: now,
      location_privacy_mode: "hidden",
      // Strip public coordinates — this post publishes without location
      public_lat: null,
      public_lng: null,
      public_location_label: null,
      venue_name: null,
    })
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "publish_without_location", {
      metadata: { published_at: now },
    });
  }

  res.status(200).json(updated);
});

/* ===========================================================================
 * POST /posts/:postId/cancel-delayed-publish  — cancel a pending post
 * ===========================================================================
 */
router.post("/posts/:postId/cancel-delayed-publish", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, post_status")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can cancel this post");
    return;
  }

  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update({ post_status: "canceled" })
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "canceled");
    await invalidateCompassCache(sc, user.id, "delayed_post_cancel");
  }

  res.status(200).json(updated);
});

/* ===========================================================================
 * POST /posts/:postId/location-event  — generic mobile telemetry append
 * ===========================================================================
 */
router.post("/posts/:postId/location-event", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { eventType, lat, lng, metadata } = req.body ?? {};
  const allowedEventTypes = ["created_pending","exit_detected","published","canceled","privacy_changed","publish_without_location","geotag_credit_awarded","credit_rate_limited","worker_skipped"] as const;
  if (!eventType || !allowedEventTypes.includes(eventType)) {
    sendError(res, "invalid_payload", "Invalid or missing eventType");
    return;
  }

  // Verify ownership — only the author can append location events
  const { data: existing } = await client
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can log events for this post");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await logDelayedEvent(sc, postId, user.id, eventType, {
    lat: typeof lat === "number" ? lat : undefined,
    lng: typeof lng === "number" ? lng : undefined,
    metadata: metadata && typeof metadata === "object" ? metadata : undefined,
  });

  res.status(201).json({ ok: true });
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
    .select("id, author_id, trip_id, visibility, content")
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

  // Record edit history when caption/body content changes (non-fatal fire-and-forget)
  if (parsed.data.content !== undefined && (existing as any).content !== parsed.data.content) {
    const sc = getServiceClient();
    if (sc) {
      void sc.from("post_edits").insert({
        post_id: postId,
        user_id: user.id,
        old_content: (existing as any).content ?? null,
        new_content: parsed.data.content,
      });
    }
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

  // Invalidate compass feed cache — await so stale content is never served after 204
  await invalidateCompassCache(getServiceClient(), user.id, "post_delete");

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
  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;
  const isPostAuthor = (post as any).author_id === user.id;

  const { data: rows, error: listErr } = await sc
    .from("posts_comments")
    .select("id, post_id, user_id, body, created_at, updated_at")
    .eq("post_id", postId)
    .is("parent_comment_id", null)
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

  const commentIds = commentRows.map((c) => c.id as string);

  const [commentSpansMap, commentLikeRows] = await Promise.all([
    enrichSpans(
      sc, 'comment',
      commentRows.map((c) => ({ id: c.id as string, content: (c.body ?? '') as string })),
      user.id,
    ),
    commentIds.length > 0
      ? sc.from("comment_likes").select("comment_id, user_id").in("comment_id", commentIds).then((r: any) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const likeCountMap: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const row of commentLikeRows as any[]) {
    likeCountMap[row.comment_id] = (likeCountMap[row.comment_id] ?? 0) + 1;
    if (row.user_id === user.id) likedByMeSet.add(row.comment_id);
  }

  const comments = commentRows.map((c) => {
    const pr    = profileMap[c.user_id];
    const spans = commentSpansMap[c.id] ?? { tags: [], hashtagUsages: [] };
    return {
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at ?? null,
      canDelete: c.user_id === user.id || isPostAuthor,
      likeCount: likeCountMap[c.id] ?? 0,
      likedByMe: likedByMeSet.has(c.id),
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
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

  const rl = checkRateLimit("comment", user.id, 30, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many comments — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Comment body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Comment must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id, comments_setting, sharing_disabled").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  // Enforce comments_setting (fail-open if column not yet migrated)
  const commentsSetting = (post as any).comments_setting ?? "everyone";
  const callerId = user.id;
  const authorId = (post as any).author_id as string;

  // Block check: fail-closed count query (avoids maybeSingle multi-row error)
  if (callerId !== authorId) {
    const { count: blockCount, error: blockErr } = await sc.from("blocks")
      .select("id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${callerId},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${callerId})`);
    if (blockErr || (blockCount ?? 0) > 0) { sendError(res, "blocked_user", "Cannot comment on this post"); return; }
  }

  // Post owner can always comment on their own post
  if (callerId !== authorId && commentsSetting !== "everyone") {
    if (commentsSetting === "disabled") {
      sendError(res, "comments_disabled", "Comments are disabled on this post");
      return;
    }
    if (commentsSetting === "friends") {
      const { data: fr } = await sc
        .from("friend_requests").select("id").eq("status", "accepted")
        .or(`and(requester_id.eq.${callerId},recipient_id.eq.${authorId}),and(requester_id.eq.${authorId},recipient_id.eq.${callerId})`)
        .maybeSingle();
      if (!fr) { sendError(res, "comments_limited", "Only friends can comment on this post"); return; }
    }
    if (commentsSetting === "circle") {
      const { data: mem } = await sc
        .from("circle_memberships").select("member_id").eq("owner_id", authorId).eq("member_id", callerId).maybeSingle();
      if (!mem) { sendError(res, "comments_limited", "Only circle members can comment on this post"); return; }
    }
    if (commentsSetting === "trip_crew") {
      const tripId = (post as any).trip_id as string | null;
      if (!tripId || !(await isAcceptedTripMember(client, tripId, callerId))) {
        sendError(res, "comments_limited", "Only trip crew can comment on this post");
        return;
      }
    }
    if (commentsSetting === "verified") {
      const { data: profile } = await sc.from("profiles").select("is_verified").eq("id", callerId).maybeSingle();
      if (!(profile as any)?.is_verified) { sendError(res, "comments_limited", "Only verified accounts can comment on this post"); return; }
    }
  }

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

  // Write-time tagging for comments: enforce permissions, write rows, dispatch notifications.
  {
    const sc = getServiceClient();
    if (sc && body.trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: sc,
          authorId: user.id,
          sourceType: 'comment',
          sourceId: (comment as any).id,
          content: body,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await sc.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc    = new NotificationService(sc);
          const notifRouter  = new NotificationRouter(sc);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'comment',
                sourceId: (comment as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a comment.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'comment tagging side-effect failed (non-fatal)');
      }
    }
  }

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

  // Allow: comment author OR post owner
  if ((existing as any).user_id !== user.id) {
    const { data: postRow } = await sc.from("posts").select("author_id").eq("id", postId).maybeSingle();
    if (!postRow || (postRow as any).author_id !== user.id) {
      sendError(res, "forbidden", "Cannot delete someone else's comment"); return;
    }
  }

  await sc.from("posts_comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);

  const { count } = await sc.from("posts_comments").select("id", { count: "exact", head: true })
    .eq("post_id", postId).is("deleted_at", null);
  await sc.from("posts").update({ comment_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ ok: true, commentCount: count ?? 0 });
});

/* ============================================================================
 * GET  /posts/:postId/reactions  — list emoji reactions + caller's reaction
 * POST /posts/:postId/reactions  — upsert emoji reaction (idempotent)
 * DELETE /posts/:postId/reactions — remove caller's reaction
 * ============================================================================
 */
const VALID_REACTION_EMOJIS = new Set(["❤️", "😂", "😮", "😢", "😡", "👍", "🔥", "✈️"]);

router.get("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: rows, error } = await sc
    .from("post_reactions").select("emoji, user_id").eq("post_id", postId);

  if (error) {
    req.log.error({ err: error }, "reactions fetch failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const counts: Record<string, number> = {};
  let myReaction: string | null = null;
  for (const r of (rows ?? []) as any[]) {
    counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
    if (r.user_id === user.id) myReaction = r.emoji;
  }

  res.status(200).json({
    reactions: Object.entries(counts).map(([emoji, count]) => ({ emoji, count })),
    myReaction,
    total: (rows ?? []).length,
  });
});

router.post("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const rl = checkRateLimit("reaction", user.id, 60, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many reactions — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const emoji = String(req.body?.emoji ?? "").trim();
  if (!emoji || !VALID_REACTION_EMOJIS.has(emoji)) {
    sendError(res, "invalid_payload", "Invalid or unsupported emoji");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { error } = await sc
    .from("post_reactions")
    .upsert({ post_id: postId, user_id: user.id, emoji }, { onConflict: "post_id,user_id" });

  if (error) {
    req.log.error({ err: error }, "reaction upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const { data: rows } = await sc.from("post_reactions").select("emoji, user_id").eq("post_id", postId);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as any[]) counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;

  res.status(200).json({
    ok: true,
    myReaction: emoji,
    reactions: Object.entries(counts).map(([e, c]) => ({ emoji: e, count: c })),
  });
});

router.delete("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  await sc.from("post_reactions").delete().eq("post_id", postId).eq("user_id", user.id);

  const { data: rows } = await sc.from("post_reactions").select("emoji, user_id").eq("post_id", postId);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as any[]) counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;

  res.status(200).json({
    ok: true,
    myReaction: null,
    reactions: Object.entries(counts).map(([e, c]) => ({ emoji: e, count: c })),
  });
});

/* ============================================================================
 * PATCH /posts/:postId/settings  — owner controls
 * ============================================================================
 */
const postSettingsSchema = z.object({
  commentsSetting: z.enum(["everyone", "friends", "circle", "trip_crew", "verified", "disabled"]).optional(),
  likesHidden: z.boolean().optional(),
  sharingDisabled: z.boolean().optional(),
  repostingDisabled: z.boolean().optional(),
});

router.patch("/posts/:postId/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const parsed = postSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one setting must be provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts").select("id, author_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post owner can change settings"); return;
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.commentsSetting !== undefined) patch.comments_setting = parsed.data.commentsSetting;
  if (parsed.data.likesHidden !== undefined) patch.likes_hidden = parsed.data.likesHidden;
  if (parsed.data.sharingDisabled !== undefined) patch.sharing_disabled = parsed.data.sharingDisabled;
  if (parsed.data.repostingDisabled !== undefined) patch.reposting_disabled = parsed.data.repostingDisabled;

  const { error } = await sc.from("posts").update(patch).eq("id", postId);
  if (error) {
    req.log.error({ err: error }, "post settings update failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, ...parsed.data });
});

/* ============================================================================
 * POST /posts/:postId/archive  — soft-archive (owner only)
 * ============================================================================
 */
router.post("/posts/:postId/archive", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts").select("id, author_id").eq("id", postId).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post owner can archive this post"); return;
  }

  const { error } = await sc.from("posts")
    .update({ status: "hidden", updated_by: user.id }).eq("id", postId);
  if (error) {
    req.log.error({ err: error }, "post archive failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, archived: true });
});

/* ============================================================================
 * POST /posts/:postId/share  — record a share action; enforces sharing_disabled
 * ============================================================================
 */
const VALID_SHARE_TARGETS = new Set(["dm", "group_chat", "trip_crew", "circle", "external", "copy_link"]);

router.post("/posts/:postId/share", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const target = String(req.body?.target ?? "").trim();
  if (!VALID_SHARE_TARGETS.has(target)) {
    sendError(res, "invalid_payload", "Invalid share target"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc
    .from("posts").select("id, author_id, visibility, trip_id, sharing_disabled").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }

  if ((post as any).sharing_disabled === true && user.id !== (post as any).author_id) {
    sendError(res, "sharing_disabled", "Sharing is disabled for this post"); return;
  }

  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const rl = checkRateLimit("share", user.id, 10, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many share actions — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const { error: shareErr } = await sc
    .from("post_shares")
    .upsert({ post_id: postId, user_id: user.id, target }, { onConflict: "post_id,user_id,target", ignoreDuplicates: true });
  if (shareErr) {
    req.log.error({ err: shareErr }, "post share record failed");
    sendError(res, "db_error", shareErr.message);
    return;
  }

  res.status(200).json({ ok: true, target });
});

/* ============================================================================
 * POST /posts/:postId/comments/:commentId/like  — like a comment (idempotent)
 * DELETE /posts/:postId/comments/:commentId/like — unlike a comment
 * ============================================================================
 */
router.post("/posts/:postId/comments/:commentId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const rl = checkRateLimit("comment_like", user.id, 60, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many likes — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: comment } = await sc
    .from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!comment) { sendError(res, "not_found", "Comment not found"); return; }
  if ((comment as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  const { error } = await sc
    .from("comment_likes")
    .upsert({ comment_id: commentId, user_id: user.id }, { onConflict: "comment_id,user_id", ignoreDuplicates: true });

  if (error) {
    req.log.error({ err: error }, "comment like failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const { count } = await sc
    .from("comment_likes").select("id", { count: "exact", head: true }).eq("comment_id", commentId);

  res.status(200).json({ ok: true, likedByMe: true, likeCount: count ?? 0 });
});

router.delete("/posts/:postId/comments/:commentId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: comment } = await sc
    .from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!comment) { sendError(res, "not_found", "Comment not found"); return; }
  if ((comment as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  await sc.from("comment_likes").delete().eq("comment_id", commentId).eq("user_id", user.id);

  const { count } = await sc
    .from("comment_likes").select("id", { count: "exact", head: true }).eq("comment_id", commentId);

  res.status(200).json({ ok: true, likedByMe: false, likeCount: count ?? 0 });
});

/* ============================================================================
 * GET /posts/:postId/edit-history — owner-only list of past content edits
 * ============================================================================
 */
router.get("/posts/:postId/edit-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id").eq("id", postId).maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if ((post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post author can view edit history");
    return;
  }

  const { data: edits, error } = await sc
    .from("post_edits")
    .select("id, old_content, new_content, edited_at")
    .eq("post_id", postId)
    .order("edited_at", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({
    ok: true,
    edits: (edits ?? []).map((e: any) => ({
      id: e.id,
      oldContent: e.old_content ?? null,
      newContent: e.new_content ?? null,
      editedAt: e.edited_at,
    })),
  });
});

/* ============================================================================
 * GET  /posts/:postId/comments/:commentId/replies — list one-level replies
 * POST /posts/:postId/comments/:commentId/replies — add a reply
 * ============================================================================
 */
router.get("/posts/:postId/comments/:commentId/replies", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: parent } = await sc.from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!parent || (parent as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  const isPostAuthor = (post as any).author_id === user.id;

  const { data: rows, error } = await sc
    .from("posts_comments")
    .select("id, post_id, user_id, body, created_at, updated_at, parent_comment_id")
    .eq("parent_comment_id", commentId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) { sendError(res, "db_error", error.message); return; }

  const replyRows: any[] = rows ?? [];
  const authorIds = [...new Set(replyRows.map((r) => r.user_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", authorIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const replyIds = replyRows.map((r) => r.id as string);
  const [replySpansMap, likeRows] = await Promise.all([
    enrichSpans(
      sc, 'comment',
      replyRows.map((r) => ({ id: r.id as string, content: (r.body ?? '') as string })),
      user.id,
    ),
    replyIds.length > 0
      ? sc.from("comment_likes").select("comment_id, user_id").in("comment_id", replyIds).then((r: any) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const likeCountMap: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const row of likeRows as any[]) {
    likeCountMap[row.comment_id] = (likeCountMap[row.comment_id] ?? 0) + 1;
    if (row.user_id === user.id) likedByMeSet.add(row.comment_id);
  }

  const replies = replyRows.map((r) => {
    const pr    = profileMap[r.user_id];
    const spans = replySpansMap[r.id] ?? { tags: [], hashtagUsages: [] };
    return {
      id: r.id,
      body: r.body,
      parentCommentId: r.parent_comment_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? null,
      canDelete: r.user_id === user.id || isPostAuthor,
      likeCount: likeCountMap[r.id] ?? 0,
      likedByMe: likedByMeSet.has(r.id),
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      author: pr
        ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null }
        : { id: r.user_id, handle: "traveler", name: "Traveler", avatarUrl: null },
    };
  });

  res.status(200).json({ ok: true, replies });
});

router.post("/posts/:postId/comments/:commentId/replies", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const rl = checkRateLimit("comment", user.id, 30, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many comments — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Reply body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Reply must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id, comments_setting").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  // Verify parent comment belongs to the post and is a root comment (one-level depth guard)
  const { data: parent } = await sc.from("posts_comments").select("id, post_id, parent_comment_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!parent || (parent as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }
  if ((parent as any).parent_comment_id !== null) { sendError(res, "invalid_payload", "Cannot reply to a reply — only one level of nesting is supported"); return; }

  // Enforce comments_setting (same rules as top-level comments)
  const commentsSetting = (post as any).comments_setting ?? "everyone";
  const callerId = user.id;
  const authorId = (post as any).author_id as string;

  // Block check: fail-closed count query (avoids maybeSingle multi-row error)
  if (callerId !== authorId) {
    const { count: blockCount, error: blockErr } = await sc.from("blocks")
      .select("id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${callerId},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${callerId})`);
    if (blockErr || (blockCount ?? 0) > 0) { sendError(res, "blocked_user", "Cannot comment on this post"); return; }
  }

  if (callerId !== authorId && commentsSetting !== "everyone") {
    if (commentsSetting === "disabled") { sendError(res, "comments_disabled", "Comments are disabled on this post"); return; }
    if (commentsSetting === "friends") {
      const { data: fr } = await sc.from("friend_requests").select("id").eq("status", "accepted")
        .or(`and(requester_id.eq.${callerId},recipient_id.eq.${authorId}),and(requester_id.eq.${authorId},recipient_id.eq.${callerId})`)
        .maybeSingle();
      if (!fr) { sendError(res, "comments_limited", "Only friends can comment on this post"); return; }
    }
    if (commentsSetting === "circle") {
      const { data: mem } = await sc.from("circle_memberships").select("member_id").eq("owner_id", authorId).eq("member_id", callerId).maybeSingle();
      if (!mem) { sendError(res, "comments_limited", "Only circle members can comment on this post"); return; }
    }
    if (commentsSetting === "trip_crew") {
      const tripId = (post as any).trip_id as string | null;
      if (!tripId || !(await isAcceptedTripMember(client, tripId, callerId))) { sendError(res, "comments_limited", "Only trip crew can comment on this post"); return; }
    }
    if (commentsSetting === "verified") {
      const { data: profile } = await sc.from("profiles").select("is_verified").eq("id", callerId).maybeSingle();
      if (!(profile as any)?.is_verified) { sendError(res, "comments_limited", "Only verified accounts can comment on this post"); return; }
    }
  }

  const { data: reply, error: insertErr } = await sc
    .from("posts_comments")
    .insert({ post_id: postId, user_id: user.id, body, parent_comment_id: commentId })
    .select("id, post_id, user_id, body, created_at, updated_at, parent_comment_id")
    .single();
  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  const { data: profile } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", user.id).single();

  // Write-time tagging for replies — same as top-level comments
  {
    const scTagging = getServiceClient();
    const replyBody = (reply as any).body as string;
    if (scTagging && replyBody.trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: scTagging,
          authorId: user.id,
          sourceType: 'comment',
          sourceId: (reply as any).id,
          content: replyBody,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await scTagging.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc   = new NotificationService(scTagging);
          const notifRouter = new NotificationRouter(scTagging);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'comment',
                sourceId: (reply as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a reply.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'reply tagging side-effect failed (non-fatal)');
      }
    }
  }

  // Build enriched spans for response (so the client sees real tags/hashtagUsages immediately)
  const replySpans = await enrichSpans(
    sc, 'comment',
    [{ id: (reply as any).id, content: (reply as any).body }],
    user.id,
  ).catch(() => ({} as Record<string, any>));
  const spans = replySpans[(reply as any).id] ?? { tags: [], hashtagUsages: [] };

  res.status(201).json({
    ok: true,
    reply: {
      id: (reply as any).id,
      body: (reply as any).body,
      parentCommentId: (reply as any).parent_comment_id,
      createdAt: (reply as any).created_at,
      updatedAt: null,
      canDelete: true,
      likeCount: 0,
      likedByMe: false,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      author: profile
        ? { id: profile.id, handle: profile.handle, name: profile.name, avatarUrl: profile.avatar_url ?? null }
        : { id: user.id, handle: "traveler", name: "Traveler", avatarUrl: null },
    },
  });
});

export default router;
