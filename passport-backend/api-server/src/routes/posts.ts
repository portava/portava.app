import { Router } from "express";
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

const router = Router();

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
    }
  }

  res.status(201).json({ ...(data as any), postcard });
});

/* ===========================================================================
 * GET /posts  — global feed: active PUBLIC STANDALONE posts only
 * ===========================================================================
 * Deliberately excludes trip_only and private and trip-attached posts so no
 * private/trip content can leak into the global feed. (Trip feeds have their
 * own endpoint below.) Auth required so we can attribute/se the reader, but the
 * feed itself is public-standalone content.
 */
router.get("/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client } = auth;

  const parsed = listPostsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { limit, before } = parsed.data;

  let q = client
    .from("posts")
    .select(POST_COLUMNS)
    .is("trip_id", null) // standalone only
    .eq("visibility", "public") // public only — no trip_only/private leakage
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
  res.status(200).json({ posts: data ?? [] });
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
  res.status(200).json({ posts: data ?? [], isMember: accepted });
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

export default router;
