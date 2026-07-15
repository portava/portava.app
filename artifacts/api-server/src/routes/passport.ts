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

/** Shape a post_media array for the postcard feed — excludes rejected/flagged items, sorts by sort_order.
 *  Returns snake_case keys to match post_media column names. */
function buildMediaArray(items: any[]): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) return [];
  return items
    .filter((m: any) => m.moderation_status !== "rejected" && m.moderation_status !== "flagged")
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m: any) => ({
      id:                m.id,
      media_type:        m.media_type,
      url:               m.public_url,
      thumbnail_url:     m.thumbnail_url ?? null,
      duration_seconds:  m.duration_seconds ?? null,
      width:             m.width ?? null,
      height:            m.height ?? null,
      sort_order:        m.sort_order ?? 0,
      processing_status: m.processing_status,
    }));
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

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username || username.length < 1) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const viewerId = await getOptionalViewerId(sc, req);

  let { data, error } = await sc
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("handle", username)
    .maybeSingle();

  if (error && (error as any).code === "42703") {
    ({ data, error } = await sc
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS_FALLBACK)
      .eq("handle", username)
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
    // Include targetId so the client can call unblockUser(targetId) without a separate lookup.
    res.status(200).json({ blocked: true, targetId });
    return;
  }

  if (visibility === "limited_preview" && !isMe) {
    res.status(200).json({
      id: data.id,
      username: data.username ?? null,
      displayName: (data.display_name ?? data.name) ?? null,
      avatarUrl: null,
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

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("handle", username)
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

  // Batch-fetch structured media for all returned postcards (fail-open)
  const postIds = (postcards ?? []).map((r: any) => r.post_id).filter(Boolean) as string[];
  let publicMediaByPostId: Record<string, any[]> = {};
  if (postIds.length > 0) {
    try {
      const { data: mediaRows } = await sc
        .from("post_media")
        .select("post_id, id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status")
        .in("post_id", postIds)
        .eq("processing_status", "ready")
        .neq("moderation_status", "rejected");
      for (const m of (mediaRows ?? []) as any[]) {
        if (!publicMediaByPostId[m.post_id]) publicMediaByPostId[m.post_id] = [];
        publicMediaByPostId[m.post_id].push(m);
      }
    } catch { /* fail-open: missing media is better than a 500 */ }
  }

  res.status(200).json({
    postcards: (postcards ?? []).map((r) => ({
      ...mapPostcard(r, false),
      media: buildMediaArray(publicMediaByPostId[r.post_id] ?? []),
    })),
  });
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

  // Batch-fetch structured media for owner's postcards (fail-open)
  const ownerPostIds = (data ?? []).map((r: any) => r.post_id).filter(Boolean) as string[];
  let ownerMediaByPostId: Record<string, any[]> = {};
  if (ownerPostIds.length > 0) {
    const sc = getServiceClient();
    if (sc) {
      try {
        const { data: mediaRows } = await sc
          .from("post_media")
          .select("post_id, id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status")
          .in("post_id", ownerPostIds)
          .eq("processing_status", "ready");
        for (const m of (mediaRows ?? []) as any[]) {
          if (!ownerMediaByPostId[m.post_id]) ownerMediaByPostId[m.post_id] = [];
          ownerMediaByPostId[m.post_id].push(m);
        }
      } catch { /* fail-open */ }
    }
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
      media: buildMediaArray(ownerMediaByPostId[r.post_id] ?? []),
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

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, username, display_name, name, avatar_url, cover_photo_url, passport_visibility, bio, is_private")
    .eq("handle", username)
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
 * GET /users/:username/og-image.png — passport-styled Open Graph image
 * ===========================================================================
 * 1200x630 PNG for link previews in chat apps. Enforces the same visibility
 * policy as /profile: private / blocked / unavailable / not-found accounts
 * all receive the same generic branded image (no name, no avatar) so the
 * image response never leaks account state.
 */

/** Escape a string for embedding inside SVG/XML text nodes. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * SSRF guard for avatar fetches: only allow HTTPS URLs whose host is the
 * Supabase project (or its storage subdomain). Rejects IP literals, localhost,
 * and anything not on the trusted storage host.
 */
function isTrustedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  // Reject IP literals and localhost outright.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":") || host === "localhost") return false;
  const trusted: string[] = [];
  for (const envKey of ["SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"]) {
    const v = process.env[envKey];
    if (!v) continue;
    try {
      trusted.push(new URL(v).hostname.toLowerCase());
    } catch { /* ignore malformed env */ }
  }
  return trusted.some((t) => host === t || host.endsWith(`.${t}`));
}

/** Fetch a remote image and return it as a base64 data URI, or null on any failure. */
async function fetchImageAsDataUri(url: string): Promise<string | null> {
  if (!isTrustedImageUrl(url)) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") ?? "";
    if (!/^image\/(png|jpe?g|webp|gif)/.test(type)) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null;
    return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

interface OgCardData {
  displayName: string | null;
  username: string | null;
  tripCount: number;
  stampCount: number;
  avatarDataUri: string | null;
}

/** Build the 1200x630 passport-cover SVG. Pass null data for the generic branded card. */
function buildPassportOgSvg(card: OgCardData | null): string {
  const W = 1200;
  const H = 630;
  const navy = "#152642";
  const navyLight = "#1D3358";
  const gold = "#C9A227";
  const goldSoft = "#E3C566";
  const cream = "#F5EFE0";

  const name = card?.displayName?.trim() || "Travel Buddy Passport";
  const handle = card?.username ? `@${card.username}` : null;
  const statsLine = card
    ? `${card.tripCount} ${card.tripCount === 1 ? "trip" : "trips"}  ·  ${card.stampCount} ${card.stampCount === 1 ? "stamp" : "stamps"}`
    : "A traveler's passport of trips, stamps & postcards";

  const initials = (card?.displayName || card?.username || "TB")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const avatar = card?.avatarDataUri
    ? `<image href="${card.avatarDataUri}" x="96" y="195" width="240" height="240" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="216" cy="315" r="120" fill="${navyLight}"/>
       <text x="216" y="345" text-anchor="middle" font-family="Georgia, serif" font-size="88" font-weight="bold" fill="${goldSoft}">${escapeXml(initials)}</text>`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="avatarClip"><circle cx="216" cy="315" r="120"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${navy}"/>
      <stop offset="1" stop-color="#0E1B31"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="28" y="28" width="${W - 56}" height="${H - 56}" fill="none" stroke="${gold}" stroke-width="3"/>
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="${gold}" stroke-width="1" opacity="0.55"/>
  <!-- decorative stamp, bottom right -->
  <g opacity="0.28" transform="translate(1010,470) rotate(-12)">
    <circle r="86" fill="none" stroke="${cream}" stroke-width="4" stroke-dasharray="6 5"/>
    <circle r="66" fill="none" stroke="${cream}" stroke-width="2"/>
    <text y="12" text-anchor="middle" font-family="Georgia, serif" font-size="40" font-weight="bold" fill="${cream}">TB</text>
  </g>
  <!-- header -->
  <text x="96" y="122" font-family="Georgia, serif" font-size="30" letter-spacing="12" fill="${gold}">TRAVEL BUDDY</text>
  <text x="96" y="162" font-family="Georgia, serif" font-size="22" letter-spacing="8" fill="${cream}" opacity="0.7">·  PASSPORT  ·</text>
  ${avatar}
  <circle cx="216" cy="315" r="124" fill="none" stroke="${gold}" stroke-width="4"/>
  <!-- name block -->
  <text x="392" y="300" font-family="Georgia, serif" font-size="${name.length > 22 ? 48 : 60}" font-weight="bold" fill="${cream}">${escapeXml(name.slice(0, 34))}</text>
  ${handle ? `<text x="392" y="356" font-family="Georgia, serif" font-size="32" fill="${goldSoft}">${escapeXml(handle)}</text>` : ""}
  <text x="392" y="${handle ? 424 : 372}" font-family="Georgia, serif" font-size="30" fill="${cream}" opacity="0.85">${escapeXml(statsLine)}</text>
  <!-- footer rule -->
  <line x1="96" y1="524" x2="760" y2="524" stroke="${gold}" stroke-width="1.5" opacity="0.6"/>
  <text x="96" y="562" font-family="Georgia, serif" font-size="22" letter-spacing="4" fill="${cream}" opacity="0.55">SCAN THE WORLD, ONE STAMP AT A TIME</text>
</svg>`;
}

async function renderOgPng(card: OgCardData | null): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(buildPassportOgSvg(card))).png().toBuffer();
}

router.get("/users/:username/og-image.png", async (req, res) => {
  const sc = getServiceClient();

  const sendPng = async (card: OgCardData | null) => {
    try {
      const png = await renderOgPng(card);
      res
        .status(200)
        .set({
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=600",
        })
        .send(png);
    } catch (e: any) {
      req.log.error({ err: e }, "og-image: render failed");
      sendError(res, "db_error", "Could not render preview image");
    }
  };

  if (!sc) {
    await sendPng(null);
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username) {
    await sendPng(null);
    return;
  }

  try {
    const { data: profile, error: profileErr } = await sc
      .from("profiles")
      .select("id, username, display_name, name, avatar_url, passport_visibility, is_private")
      .eq("handle", username)
      .maybeSingle();

    if (profileErr || !profile) {
      await sendPng(null);
      return;
    }

    // OG image requests come from crawlers — always unauthenticated viewers.
    const { visibility } = await resolveProfileVisibility(sc, null, profile.id, profile);
    if (visibility !== "full" && visibility !== "followers_only") {
      await sendPng(null);
      return;
    }

    const [tripResult, stampResult] = await Promise.all([
      sc.from("trips").select("id", { count: "exact", head: true }).eq("owner_id", profile.id),
      sc.from("stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("locked", false),
    ]);

    const avatarDataUri = profile.avatar_url ? await fetchImageAsDataUri(profile.avatar_url) : null;

    await sendPng({
      displayName: profile.display_name ?? profile.name ?? null,
      username: profile.username ?? username,
      tripCount: tripResult.count ?? 0,
      stampCount: (stampResult as any).error?.code === "PGRST205" ? 0 : (stampResult.count ?? 0),
      avatarDataUri,
    });
  } catch (e: any) {
    req.log.warn({ err: e }, "og-image: lookup failed, serving generic image");
    await sendPng(null);
  }
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

  let stamps = (data ?? []).map((r: any) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    sublabel: r.sublabel ?? null,
    earnedAt: r.first_earned_at,
    checkInCount: r.check_in_count ?? 1,
    locked: r.locked ?? false,
  }));

  // Best-effort: attach AI universal artwork from Stamp System v2 definitions.
  // Legacy stamps have no definition link, so match by stamp_type (+ city).
  // Any failure (e.g. v2 tables not yet migrated) leaves stamps unchanged.
  try {
    const { data: v2 } = await sc
      .from("user_stamps")
      .select("city, stamp_definitions(stamp_type, universal_artwork_url)")
      .eq("user_id", user.id)
      .eq("is_revoked", false);
    if (v2 && v2.length > 0) {
      const { attachUniversalArtwork } = await import("../lib/stampArtworkEnrichment.js");
      stamps = attachUniversalArtwork(
        stamps,
        v2.map((r: any) => ({
          city: r.city ?? null,
          stampType: r.stamp_definitions?.stamp_type ?? null,
          universalArtworkUrl: r.stamp_definitions?.universal_artwork_url ?? null,
        })),
      );
    }
  } catch {
    /* artwork enrichment is optional — never fail the stamps response */
  }

  res.status(200).json({ stamps });
});

export default router;
