import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { resolveProfileVisibility, extractBearerToken } from "../lib/profileVisibility";

const router = Router();

const PUBLIC_PROFILE_COLUMNS =
  "id, username, display_name, name, bio, avatar_url, cover_photo_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at, is_private, spoken_languages, travel_styles, travel_pace, looking_for, account_status";

const PUBLIC_PROFILE_COLUMNS_FALLBACK =
  "id, username, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at";

const PUBLIC_POSTCARD_COLUMNS =
  "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at";

/** Fallback: select everything; mapPostcard handles missing fields with ?? null. */
const PUBLIC_POSTCARD_COLUMNS_FALLBACK = "*";

function mapPublicProfile(r: any) {
  return {
    id: r.id,
    username: r.username ?? null,
    displayName: r.display_name ?? r.name ?? null,
    bio: r.bio ?? null,
    avatarUrl: r.avatar_url ?? null,
    coverPhotoUrl: r.cover_photo_url ?? null,
    homeCity: r.home_city ?? null,
    homeCountry: r.home_country ?? null,
    travelStyle: r.travel_style ?? null,
    interests: r.interests ?? [],
    verified: r.verified ?? false,
    verificationStatus: r.verification_status ?? "unverified",
    verifiedAt: r.verified_at ?? null,
    passportVisibility: r.passport_visibility ?? "public",
    createdAt: r.created_at ?? null,
    spokenLanguages: r.spoken_languages ?? [],
    travelStyles: r.travel_styles ?? [],
    travelPace: r.travel_pace ?? null,
    lookingFor: r.looking_for ?? [],
  };
}

function mapPostcard(r: any, includePrivate = false) {
  const base: Record<string, unknown> = {
    id: r.id,
    postId: r.post_id,
    mediaUrl: r.media_url ?? null,
    caption: r.caption ?? null,
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    locationVerified: r.location_verified ?? false,
    stampEligible: r.stamp_eligible ?? false,
    visibility: r.visibility ?? "public",
    status: r.status ?? "active",
    pinnedAt: r.pinned_at ?? null,
    note: r.note ?? null,
    createdAt: r.created_at ?? null,
  };
  if (includePrivate) {
    base.userId = r.user_id;
  }
  return base;
}

/** Extract optional viewer ID from Authorization header without failing on missing/invalid tokens. */
async function getOptionalViewerId(
  sc: any,
  req: { headers: { authorization?: string } },
): Promise<string | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const { data: { user }, error } = await sc.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

/** Build the default viewer object for unauthenticated callers or own-profile access. */
function buildDefaultViewer(isMe: boolean, pps: Record<string, any> | null): Record<string, any> {
  // Unauthenticated callers respect public-access privacy controls
  const allowFollow    = pps?.allow_follow !== false;
  const allowMessages  = !pps || pps.allow_messages_from === "everyone" || pps.allow_messages_from == null;
  return {
    is_me: isMe,
    is_following: false,
    is_friend: false,
    has_pending_friend_request_sent: false,
    has_pending_friend_request_received: false,
    is_blocked_by_me: false,
    has_blocked_me: false,
    can_follow: !isMe && allowFollow,
    can_message: !isMe && allowMessages,
    can_view_posts: pps?.show_posts !== false,
    can_view_trips: pps?.show_past_trips !== false || pps?.show_upcoming_trips !== false,
    can_view_stamps: pps?.show_stamps !== false,
    can_tag: pps?.allow_tagging !== false,
    can_report: !isMe,
    can_book_as_buddy: false,
  };
}

/* ===========================================================================
 * GET /users/:username/passport — public passport lookup (optional auth)
 * ===========================================================================
 * Uses the service-role client. If an Authorization header is present, the
 * viewer's relationship state is computed and attached as `viewer`.
 * Unauthenticated callers get viewer with all relationships as false.
 *
 * Response shapes:
 *   { unavailable: true }              — deactivated/deleted/banned account
 *   { blocked: true }                  — block relationship (either direction)
 *   { id, username, displayName, avatarUrl, visibility: "private" }
 *                                      — private account, viewer is not follower/friend
 *   { ...profile fields, viewer, buddyProvider }
 *                                      — normal full response
 */
router.get("/users/:username/passport", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  if (!username || username.length < 1) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const viewerId = await getOptionalViewerId(sc, req);

  let { data, error } = await sc
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("username", username)
    .maybeSingle();

  if (error && (error as any).code === "42703") {
    ({ data, error } = await sc
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS_FALLBACK)
      .eq("username", username)
      .maybeSingle());
  }

  if (error) {
    req.log.error({ err: error }, "Failed to load public passport");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!data) {
    sendError(res, "not_found", "User not found");
    return;
  }

  const targetId: string = data.id;
  const isMe = viewerId === targetId;

  // ── Visibility guard ───────────────────────────────────────────────────────
  let visibility: string;
  let privacySettings: Record<string, any> | null;
  try {
    const result = await resolveProfileVisibility(sc, viewerId, targetId, data);
    visibility = result.visibility;
    privacySettings = result.privacySettings as Record<string, any> | null;
  } catch (e: any) {
    req.log.error({ err: e }, "passport: visibility check failed");
    sendError(res, "db_error", e.message ?? "Visibility check failed");
    return;
  }

  if (visibility === "unavailable") {
    res.status(200).json({ unavailable: true, reason: "account_unavailable" });
    return;
  }

  if (visibility === "blocked") {
    res.status(200).json({ blocked: true });
    return;
  }

  if (visibility === "limited_preview" && !isMe) {
    res.status(200).json({
      id: data.id,
      username: data.username ?? null,
      displayName: (data.display_name ?? data.name) ?? null,
      avatarUrl: data.avatar_url ?? null,
      accountStatus: (data as any).account_status ?? "active",
      visibility: "private",
    });
    return;
  }

  // Fire-and-forget: track authenticated non-owner profile views for private analytics.
  // Only fires when the viewer can actually see the full profile (not blocked / limited_preview).
  // Errors are suppressed so view tracking never blocks the response.
  if (viewerId && !isMe) {
    sc.from("profile_views")
      .insert({ target_id: targetId, viewer_id: viewerId, viewed_at: new Date().toISOString() })
      .then(undefined, () => {});
  }

  // ── Viewer relationship state ──────────────────────────────────────────────
  let viewer: Record<string, any> = buildDefaultViewer(isMe, privacySettings);

  if (viewerId && !isMe) {
    try {
      const perms = await resolveInteractionPermissions(sc, viewerId, targetId);
      const label = perms.relationshipLabel;
      viewer = {
        is_me: false,
        is_following: label === "following" || label === "mutual_follow",
        is_friend: label === "friend",
        has_pending_friend_request_sent: label === "outgoing_request",
        has_pending_friend_request_received: label === "incoming_request",
        is_blocked_by_me: label === "blocked" || label === "mutual_block",
        has_blocked_me: label === "blocks_you" || label === "mutual_block",
        can_follow: perms.canFollow,
        can_message: perms.canMessage,
        can_view_posts: perms.canSeePublicPosts && privacySettings?.show_posts !== false,
        can_view_trips: perms.canSeeTrips && (privacySettings?.show_past_trips !== false || privacySettings?.show_upcoming_trips !== false),
        can_view_stamps: perms.canViewProfile && privacySettings?.show_stamps !== false,
        can_tag: perms.canTag,
        can_report: perms.canReport,
        can_book_as_buddy: perms.canBookBuddy,
      };
    } catch (e) {
      req.log.warn({ err: e }, "passport: viewer state computation failed (fail-open)");
      // keep default viewer
    }
  }

  // ── Buddy provider card (fail-open) ────────────────────────────────────────
  let buddyProvider: Record<string, any> | null = null;
  try {
    const { data: bp } = await sc
      .from("rent_buddy_profiles")
      .select("id, city, categories, languages, average_rating, review_count, response_time_h, hourly_rate_usd")
      .eq("user_id", targetId)
      .eq("status", "active")
      .eq("admin_status", "active")
      .maybeSingle();

    if (bp) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: avail } = await sc
        .from("rent_buddy_availability")
        .select("available_now")
        .eq("buddy_id", (bp as any).id)
        .eq("date", today)
        .maybeSingle();

      buddyProvider = {
        buddyProfileId: (bp as any).id,
        services: (bp as any).categories ?? [],
        cities: (bp as any).city ? [(bp as any).city] : [],
        languages: (bp as any).languages ?? [],
        rating: (bp as any).average_rating != null ? Number((bp as any).average_rating) : null,
        reviewCount: (bp as any).review_count ?? 0,
        responseTime: (bp as any).response_time_h != null ? Number((bp as any).response_time_h) : null,
        availableNow: Boolean((avail as any)?.available_now),
        startingPrice: (bp as any).hourly_rate_usd != null ? Number((bp as any).hourly_rate_usd) : null,
      };
    }
  } catch {
    /* fail-open: buddyProvider stays null */
  }

  res.status(200).json({
    ...mapPublicProfile(data),
    viewer,
    buddyProvider,
  });
});

/* ===========================================================================
 * GET /users/:username/passport/postcards — public postcard wall (no auth required)
 * ===========================================================================
 * Uses service-role client so recipients of a share link can view postcards
 * without logging in. Never exposes exact GPS.
 */
router.get("/users/:username/passport/postcards", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("username", username)
    .maybeSingle();

  if (profileErr || !profile) {
    sendError(res, "not_found", "User not found");
    return;
  }
  if (profile.passport_visibility === "private") {
    res.status(200).json({ private: true, postcards: [] });
    return;
  }

  let { data: postcards, error: postcardErr } = await sc
    .from("passport_postcards")
    .select(PUBLIC_POSTCARD_COLUMNS)
    .eq("user_id", profile.id)
    .eq("status", "active")
    .eq("visibility", "public")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(50);

  if (postcardErr && (postcardErr as any).code === "42703") {
    const fb = await sc
      .from("passport_postcards")
      .select(PUBLIC_POSTCARD_COLUMNS_FALLBACK)
      .eq("user_id", profile.id)
      .eq("status", "active")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(50);
    postcards = fb.data as any;
    postcardErr = fb.error;
  }

  if (postcardErr) {
    req.log.error({ err: postcardErr }, "Failed to list public postcards");
    sendError(res, "db_error", postcardErr.message);
    return;
  }

  res.status(200).json({ postcards: (postcards ?? []).map((r) => mapPostcard(r, false)) });
});

/* ===========================================================================
 * GET /me/passport/postcards — owner's own full postcard list
 * ===========================================================================
 */
router.get("/me/passport/postcards", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const OWNER_POSTCARD_COLUMNS =
    "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, stamp_reason, verification_method, visibility, status, pinned_at, note, created_at";

  /** Fallback: select everything; mapper handles missing fields with ?? null. */
  const OWNER_POSTCARD_COLUMNS_FALLBACK = "*";

  let { data, error } = await client
    .from("passport_postcards")
    .select(OWNER_POSTCARD_COLUMNS)
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error && (error as any).code === "42703") {
    const fb = await client
      .from("passport_postcards")
      .select(OWNER_POSTCARD_COLUMNS_FALLBACK)
      .eq("user_id", user.id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(100);
    data = fb.data as any;
    error = fb.error;
  }

  if (error) {
    req.log.error({ err: error }, "Failed to list own postcards");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({
    postcards: (data ?? []).map((r) => ({
      id: r.id,
      postId: r.post_id,
      mediaUrl: r.media_url ?? null,
      caption: r.caption ?? null,
      locationName: r.location_name ?? null,
      locationCity: r.location_city ?? null,
      locationCountry: r.location_country ?? null,
      locationVerified: r.location_verified ?? false,
      stampEligible: r.stamp_eligible ?? false,
      stampReason: r.stamp_reason ?? null,
      verificationMethod: r.verification_method ?? null,
      visibility: r.visibility ?? "public",
      status: r.status ?? "active",
      pinnedAt: r.pinned_at ?? null,
      note: r.note ?? null,
      createdAt: r.created_at ?? null,
    })),
  });
});

/* ===========================================================================
 * PATCH /passport/postcards/:id — update postcard (owner only)
 * ===========================================================================
 * Updates note, visibility, pinned_at. Pinning enforces one-per-user.
 */
const patchPostcardSchema = z.object({
  note: z.string().max(500).nullable().optional(),
  visibility: z.enum(["public", "private", "trip_only"]).optional(),
  pin: z.boolean().optional(),
});

router.patch("/passport/postcards/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postcardId = req.params.id;
  const parsed = patchPostcardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data: existing, error: loadErr } = await client
    .from("passport_postcards")
    .select("id, user_id, status")
    .eq("id", postcardId)
    .maybeSingle();

  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Postcard not found"); return; }
  if (existing.user_id !== user.id) { sendError(res, "forbidden", "Not your postcard"); return; }

  const patch: Record<string, unknown> = {};
  if (parsed.data.note !== undefined) patch.note = parsed.data.note;
  if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;

  if (parsed.data.pin === true) {
    await client
      .from("passport_postcards")
      .update({ pinned_at: null })
      .eq("user_id", user.id)
      .not("id", "eq", postcardId);
    patch.pinned_at = new Date().toISOString();
  } else if (parsed.data.pin === false) {
    patch.pinned_at = null;
  }

  if (Object.keys(patch).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const { data, error } = await client
    .from("passport_postcards")
    .update(patch)
    .eq("id", postcardId)
    .eq("user_id", user.id)
    .select("id, post_id, media_url, caption, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update postcard");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json(data);
});

/* ===========================================================================
 * PATCH /passport/postcards/:id/remove — remove from passport (owner only)
 * ===========================================================================
 * Sets status to removed_from_passport — does NOT delete the original post.
 */
router.patch("/passport/postcards/:id/remove", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postcardId = req.params.id;

  const { data: existing, error: loadErr } = await client
    .from("passport_postcards")
    .select("id, user_id")
    .eq("id", postcardId)
    .maybeSingle();

  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Postcard not found"); return; }
  if (existing.user_id !== user.id) { sendError(res, "forbidden", "Not your postcard"); return; }

  const { error } = await client
    .from("passport_postcards")
    .update({ status: "removed_from_passport", pinned_at: null })
    .eq("id", postcardId)
    .eq("user_id", user.id);

  if (error) {
    req.log.error({ err: error }, "Failed to remove postcard");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(204).send();
});

/* ===========================================================================
 * GET /users/:username/profile — public profile card (for share link preview)
 * ===========================================================================
 * Returns displayName, username, avatarUrl, coverUrl, tripCount, stampCount,
 * and visibility. Enforces the same visibility policy as /passport:
 *   - unavailable account → { unavailable: true }
 *   - blocked             → { blocked: true }
 *   - limited_preview     → minimal stub with visibility:"private"
 *   - full / followers_only → full card
 */
router.get("/users/:username/profile", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  if (!username) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, username, display_name, name, avatar_url, cover_photo_url, passport_visibility, bio, is_private")
    .eq("username", username)
    .maybeSingle();

  if (profileErr || !profile) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  const viewerId = await getOptionalViewerId(sc, req);

  let visibility: string;
  try {
    const result = await resolveProfileVisibility(sc, viewerId, profile.id, profile);
    visibility = result.visibility;
  } catch (e: any) {
    req.log.error({ err: e }, "profile card: visibility check failed");
    sendError(res, "db_error", "Visibility check failed");
    return;
  }

  if (visibility === "unavailable") {
    res.status(200).json({ unavailable: true });
    return;
  }
  if (visibility === "blocked") {
    res.status(200).json({ blocked: true });
    return;
  }
  if (visibility === "limited_preview") {
    res.status(200).json({
      private: true,
      username: profile.username,
      displayName: profile.display_name ?? profile.name ?? null,
      avatarUrl: null,
      coverUrl: null,
      tripCount: 0,
      stampCount: 0,
      visibility: "private",
    });
    return;
  }

  const [tripResult, stampResult] = await Promise.all([
    sc.from("trips").select("id", { count: "exact", head: true }).eq("owner_id", profile.id),
    sc.from("stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("locked", false),
  ]);
  const tripCount = tripResult.count;
  const stampCount = (stampResult as any).error?.code === "PGRST205" ? 0 : stampResult.count;

  res.status(200).json({
    id: profile.id,
    username: profile.username ?? null,
    displayName: profile.display_name ?? profile.name ?? null,
    bio: profile.bio ?? null,
    avatarUrl: profile.avatar_url ?? null,
    coverUrl: profile.cover_photo_url ?? null,
    tripCount: tripCount ?? 0,
    stampCount: stampCount ?? 0,
    visibility: profile.passport_visibility ?? "public",
  });
});

/* ===========================================================================
 * GET /me/stamps  — caller's earned stamps
 * ===========================================================================
 * Returns only unlocked stamps (locked=false). Ordered most-recently-earned
 * first. The response shape matches PassportStamp on the mobile client.
 */
router.get("/me/stamps", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("stamps")
    .select("id, kind, label, sublabel, first_earned_at, last_earned_at, check_in_count, locked")
    .eq("user_id", user.id)
    .order("first_earned_at", { ascending: false });

  if (error) {
    if ((error as any).code === "PGRST205") {
      res.status(200).json({ stamps: [] });
      return;
    }
    req.log.error({ err: error }, "Failed to load stamps");
    sendError(res, "db_error", error.message);
    return;
  }

  const stamps = (data ?? []).map((r: any) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    sublabel: r.sublabel ?? null,
    earnedAt: r.first_earned_at,
    checkInCount: r.check_in_count ?? 1,
    locked: r.locked ?? false,
  }));

  res.status(200).json({ stamps });
});

export default router;
