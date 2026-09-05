import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { stampOverlayCol, feedVariantCol } from "../lib/postMediaOverlay";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { resolveProfileVisibility, extractBearerToken } from "../lib/profileVisibility";
import { nameVisibleFor } from "../lib/publicIdentity";
import type { StampPalette } from "../lib/stamps/composition/identities";
import {
  toPrivateProfilePreview,
  toPublicProfilePreview,
  toFullProfileView,
} from "../lib/privacy/profileSerializers.js";
import { computeTrustScore } from "../lib/trustScore.js";
import { countStampsReceived } from "../services/stamps/ContentStampService.js";
import { countUserTrips } from "../lib/tripCounts.js";
import {
  buildPassportProjection,
  buildProjectionCachePolicy,
  resolvePassportViewerContext,
  toCallerContext,
} from "../services/passport/PassportProjectionService.js";
import { buildSharedContext } from "../services/passport/SharedContextService.js";
import { buildJourneys } from "../services/passport/PassportJourneyService.js";
import { writeTravelDnaPref } from "../services/passport/PassportTravelIdentityService.js";
import { buildReputationSummary } from "../services/passport/PassportReputationService.js";
import {
  createEventPassportShare,
  revokeEventPassportShare,
  getOwnEventPassportShare,
  resolveEventPassport,
} from "../services/passport/EventPassportService.js";
import { isFlagEnabled } from "../lib/featureFlags.js";

const router = Router();

const PUBLIC_PROFILE_COLUMNS =
  "id, username, display_name, name, bio, avatar_url, cover_photo_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at, is_private, spoken_languages, travel_styles, travel_pace, looking_for, account_status, passport_tab_order, is_official, featured_count, show_profile_picture_publicly";

const PUBLIC_PROFILE_COLUMNS_FALLBACK =
  "id, username, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at, show_profile_picture_publicly";

const PUBLIC_POSTCARD_COLUMNS =
  "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at";

/** Fallback: select everything; mapPostcard handles missing fields with ?? null. */
const PUBLIC_POSTCARD_COLUMNS_FALLBACK = "*";


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
      // feed_url was missing from this projection entirely while the sibling
      // in routes/posts.ts (filterPostMedia) emitted it. The Postcard Wall is
      // the surface migration 0208 was built for, and PostcardsTab already
      // READS `feed_url` — it just always got undefined here, so every postcard
      // silently served the full-size original instead of the ~1500px variant.
      // `?? null` is load-bearing: feedVariantCol() omits the column entirely
      // on a pre-0208 database, and test/feedVariantContract.test.ts requires
      // the key to survive as an explicit null rather than be dropped as
      // undefined.
      feed_url:          m.feed_url ?? null,
      thumbnail_url:     m.thumbnail_url ?? null,
      duration_seconds:  m.duration_seconds ?? null,
      width:             m.width ?? null,
      height:            m.height ?? null,
      sort_order:        m.sort_order ?? 0,
      processing_status: m.processing_status,
      stamp_overlay:     m.stamp_overlay ?? null,
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
  if (!sc) { res.status(404).json({ error: "not_found" }); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username || username.length < 1) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const viewerId = await getOptionalViewerId(sc, req);

  let { data: profile, error } = await sc
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("handle", username)
    .maybeSingle();

  if (error && (error as any).code === "42703") {
    ({ data: profile, error } = await sc
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
  if (!profile) {
    sendError(res, "not_found", "User not found");
    return;
  }

  const targetId: string = profile.id;
  const isMe = viewerId === targetId;

  // ── Visibility guard ───────────────────────────────────────────────────────
  // resolveProfileVisibility handles account-status, block relationships, and
  // follower/friend checks — the same pattern used by the passport route.
  let visibility: string;
  let privacySettings: Record<string, any> | null;
  try {
    const result = await resolveProfileVisibility(sc, viewerId, profile.id, profile);
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
    // Compute minimal viewer relationship state so the client can show
    // "Send Request" vs "Request sent" vs (future) "View profile" without
    // a second round-trip.  Fail-open: both flags stay false on any error.
    // NOTE: pending requests grant NO additional content access.
    //
    // Use direct targeted queries instead of resolveInteractionPermissions —
    // the full resolver is overkill here and its broad catch silently swallows
    // any DB hiccup, leaving friend_request_pending=false even when a pending
    // row exists.  The search endpoint uses the same direct pattern (follows.ts).
    let relationshipStatus: "none" | "friend" | "outgoing_request" = "none";
    if (viewerId) {
      try {
        const [pendingReqRow, friendshipRow] = await Promise.all([
          sc.from("friend_requests")
            .select("id")
            .eq("requester_id", viewerId)
            .eq("recipient_id", targetId)
            .eq("status", "pending")
            .maybeSingle(),
          sc.from("user_friendships")
            .select("user_a")
            .or(`and(user_a.eq.${viewerId},user_b.eq.${targetId}),and(user_a.eq.${targetId},user_b.eq.${viewerId})`)
            .maybeSingle(),
        ]);
        if (friendshipRow.data) relationshipStatus = "friend";
        else if (pendingReqRow.data) relationshipStatus = "outgoing_request";
      } catch {
        // non-fatal — leave "none"
      }
    }
    // toPrivateProfilePreview enforces the exact PrivateProfilePreview shape —
    // no extra fields leak through, regardless of what the DB row contains.
    res.status(200).json(
      toPrivateProfilePreview(profile, {
        relationshipStatus,
        showRealName: privacySettings?.show_real_name === true,
      }),
    );
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
      // available_now lives on rent_buddy_profiles itself (not rent_buddy_availability)
      const { data: avail } = await sc
        .from("rent_buddy_profiles")
        .select("available_now")
        .eq("id", (bp as any).id)
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

  // Select the correct serializer based on the resolved visibility tier:
  //   isMe or followers_only (approved follower/friend) → FullProfileView
  //   full (public profile, non-owner)                 → PublicProfilePreview
  const showRealName = isMe || privacySettings?.show_real_name === true;
  const profilePayload =
    isMe || visibility === "followers_only"
      ? toFullProfileView(profile, { showRealName })
      : toPublicProfilePreview(profile, { showRealName });

  // Compute trust score + stamps earned count (both fail-open).
  let trustScore: number | null = null;
  let trustLabel: string | null = null;
  let trustScoreBreakdown: import("../lib/trustScore.js").TrustScoreBreakdown | null = null;
  let stampsEarned = 0;
  let milestoneStampsEarned = 0;
  let contentStampsReceivedForTarget = 0;

  await Promise.allSettled([
    (async () => {
      try {
        const ts = await computeTrustScore(targetId, sc);
        trustScore = ts.score;
        trustLabel = ts.label;
        if (isMe) {
          // Owner gets the full breakdown including personal improvement hints.
          trustScoreBreakdown = ts.breakdown;
        } else if (buddyProvider !== null) {
          // Public viewer on a buddy-provider profile gets the factor list but
          // with hints stripped — they're irrelevant to a traveler evaluating trust.
          trustScoreBreakdown = {
            factors: ts.breakdown.factors.map(f => ({ ...f, hint: null })),
          };
        }
      } catch {
        /* non-critical — passport still served without trust score */
      }
    })(),
    (async () => {
      try {
        // Lifetime total across all entity types, excluding revoked stamps.
        // Fails silently: stamps_earned defaults to 0 if user_stamps table is
        // absent or the query errors (schema-drift safe).
        const { count } = await sc
          .from("user_stamps")
          .select("id", { count: "exact", head: true })
          .eq("user_id", targetId)
          .eq("is_revoked", false);
        milestoneStampsEarned = count ?? 0;
      } catch {
        /* non-critical */
      }
    })(),
    (async () => {
      try {
        // Stamps received on this user's own posts/media (Roam/Watch stamp
        // reactions from others), so STAMPS reflects content reactions too.
        contentStampsReceivedForTarget = await countStampsReceived(sc, targetId);
      } catch {
        /* non-critical */
      }
    })(),
  ]);
  stampsEarned = milestoneStampsEarned + contentStampsReceivedForTarget;

  res.status(200).json({
    ...profilePayload,
    viewer,
    buddyProvider,
    trustScore,
    trustLabel,
    trustScoreBreakdown,
    stampsEarned,
  });
});

/* ===========================================================================
 * GET /users/:username/passport/postcards — postcard wall (optional auth)
 * ===========================================================================
 * Uses service-role client. Unauthenticated share-link recipients can view
 * postcards for PUBLIC profiles. Followers-only profiles require the caller
 * to be an authenticated follower or friend. Private profiles are always
 * blocked. Block relationships and account-status checks are applied.
 * Never exposes exact GPS.
 */
router.get("/users/:username/passport/postcards", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { res.status(404).json({ error: "not_found" }); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username) {
    sendError(res, "not_found", "Invalid username");
    return;
  }

  const { data: profile, error: profileErr } = await sc
      .from("profiles")
      .select("id, username, display_name, name, avatar_url, passport_visibility, is_private, account_status")
      .eq("handle", username)
      .maybeSingle();

  if (profileErr || !profile) {
    sendError(res, "not_found", "User not found");
    return;
  }

  const targetId: string = profile.id;
  const viewerId = await getOptionalViewerId(sc, req);
  const isMe = viewerId === targetId;

  // ── Visibility guard ───────────────────────────────────────────────────────
  // resolveProfileVisibility handles account-status, block relationships, and
  // follower/friend checks — the same pattern used by the passport route.
  let visibility: string;
  let resolvedPrivacySettings: { profile_visibility?: string } | null = null;
  try {
    const result = await resolveProfileVisibility(sc, viewerId, profile.id, profile);
    visibility = result.visibility;
    resolvedPrivacySettings = result.privacySettings;
  } catch (e: any) {
    req.log.error({ err: e }, "passport/postcards: visibility check failed");
    sendError(res, "db_error", e.message ?? "Visibility check failed");
    return;
  }

  if (visibility === "unavailable") {
    res.status(200).json({ unavailable: true, postcards: [] });
    return;
  }

  if (visibility === "blocked") {
    res.status(200).json({ blocked: true, postcards: [] });
    return;
  }

  // Private-passport accounts' postcard walls are always blocked for non-owners,
  // even when resolveProfileVisibility grants "followers_only" access (i.e. when
  // the viewer is a friend of a private account).  The passport itself may be
  // viewable to friends, but the postcard wall is an additional surface that
  // requires explicit opt-in via passport_visibility = 'followers_only'.
  //
  // Use the EFFECTIVE privacy level: profile_privacy_settings.profile_visibility
  // takes precedence over the profile row's is_private / passport_visibility
  // fields (same precedence rule as resolveProfileVisibility itself). A user who
  // set their effective privacy to "private" via settings while the profile row
  // still shows is_private=false must still have their postcard wall blocked.
  const isPrivatePassport =
    profile.passport_visibility === "private" ||
    profile.is_private === true ||
    resolvedPrivacySettings?.profile_visibility === "private";
  if (!isMe && isPrivatePassport) {
    res.status(200).json({ private: true, postcards: [] });
    return;
  }

  // "limited_preview" means the caller is unauthenticated (or authenticated
  // but not a follower/friend) for a followers_only account.
  if (!isMe && visibility === "limited_preview") {
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
          .select("post_id, id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status" + (await stampOverlayCol(sc)) + (await feedVariantCol(sc)))
          .in("post_id", postIds)
          .eq("processing_status", "ready");
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
          .select("post_id, id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status" + (await stampOverlayCol(sc)) + (await feedVariantCol(sc)))
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
    .select("id, user_id")
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
    .select()
    .maybeSingle();

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
  if (!sc) { res.status(404).json({ error: "not_found" }); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  if (!username) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, username, display_name, name, avatar_url, cover_photo_url, passport_visibility, bio, is_private, featured_count, is_official, show_profile_picture_publicly")
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
    sendError(res, "db_error", "Visibility check failed", { exposeDetail: true });
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
  const allowRealName = viewerId === profile.id || (await nameVisibleFor(sc, profile.id));
  // Mirrors the FullProfileView/PublicProfilePreview split in profileSerializers.ts:
  // owner and approved followers/friends always see the avatar; a "full" (public,
  // non-owner, non-connected) viewer sees it only when the owner opted in.
  const showAvatar =
    viewerId === profile.id ||
    visibility === "followers_only" ||
    (profile as any).show_profile_picture_publicly !== false;

  if (visibility === "limited_preview") {
    res.status(200).json({
      private: true,
      username: profile.username,
      displayName: allowRealName ? (profile.display_name ?? profile.name ?? null) : null,
      avatarUrl: null,
      coverUrl: null,
      tripCount: 0,
      stampCount: 0,
      visibility: "private",
    });
    return;
  }

    const [tripResult, stampResult] = await Promise.all([
      countUserTrips(sc, profile.id),
      sc.from("passport_stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id),
    ]);
  const tripCount = tripResult.count;
  let stampCount = (stampResult as any).error?.code === "PGRST205" ? 0 : (stampResult.count ?? 0);

  // Legacy unification (read-layer, flag-gated): when stamp_unified_view_enabled
  // is on, report the DEDUPED v1+v2 total instead of the v1-only GPS count, so
  // the passport reflects achievements too. Fail-safe: any error keeps the v1
  // count above. No writes, no migration.
  try {
    const { unifiedViewEnabled, getUnifiedStampCount } =
      await import("../services/passport/UnifiedStampService.js");
    if (await unifiedViewEnabled(sc)) {
      stampCount = await getUnifiedStampCount(sc, profile.id);
    }
  } catch { /* keep legacy v1 count */ }

  res.status(200).json({
    id: profile.id,
    username: profile.username ?? null,
    displayName: allowRealName ? (profile.display_name ?? profile.name ?? null) : null,
    bio: profile.bio ?? null,
    avatarUrl: showAvatar ? (profile.avatar_url ?? null) : null,
    coverUrl: profile.cover_photo_url ?? null,
    tripCount: tripCount ?? 0,
    stampCount: stampCount ?? 0,
    featuredCount: (profile.featured_count as number | null | undefined) ?? 0,
    visibility: profile.passport_visibility ?? "public",
    isOfficial: (profile.is_official as boolean | undefined) ?? false,
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

  const name = card?.displayName?.trim() || "Portava Passport";
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

/* ===========================================================================
 * Stamp share preview support (?stamp=<id> on /u/<username> links)
 * ===========================================================================
 * Crawlers are always unauthenticated, so a stamp is only previewable when:
 *   - the owner's profile is publicly visible (full / followers_only), AND
 *   - the stamp belongs to that owner, is not revoked, and is public.
 * Anything else falls back to the regular passport preview so link previews
 * never leak private stamps or account state.
 */

const STAMP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StampPreviewData {
  label: string;
  artworkUrl: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
  /** Resolved destination identity palette (for OG card theming). */
  palette: StampPalette | null;
}

/**
 * Resolve the premium composited artwork URL for a stamp via its catalog
 * entry's active version (Wave 1+ pipeline). Returns null when the stamp has
 * no catalog link or composited version yet — callers fall back to the flat
 * universal_artwork_url. Never throws.
 */
async function fetchCompositedArtworkUrl(sc: any, catalogId: string | null): Promise<string | null> {
  if (!catalogId) return null;
  try {
    const { data, error } = await sc
      .from("universal_stamp_catalog")
      // FK constraint name, not the column: PostgREST cannot resolve the
      // `!active_version_id` column hint (it returns null), so composited artwork
      // was always null here. Use `!fk_catalog_active_version` like routes/stamps.ts.
      .select("stamp_artwork_versions!fk_catalog_active_version(public_url)")
      .eq("id", catalogId)
      .maybeSingle();
    if (error || !data) return null;
    return (data as any).stamp_artwork_versions?.public_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Load a publicly-visible stamp owned by `ownerId`. Returns null on any
 * failure (missing tables, revoked, non-public, wrong owner) — never throws.
 * Prefers the premium composited artwork over the flat legacy art, and
 * resolves the destination palette so the share card matches the stamp.
 */
async function fetchPublicStampPreview(
  sc: any,
  ownerId: string,
  stampId: string,
): Promise<StampPreviewData | null> {
  if (!STAMP_UUID_RE.test(stampId)) return null;
  try {
    const BASE_COLS = "id, city, country, earned_at, title_override, visibility, is_revoked, catalog_id";
    let { data, error } = await sc
      .from("user_stamps")
      .select(`${BASE_COLS}, stamp_definitions(name, stamp_type, universal_artwork_url)`)
      .eq("id", stampId)
      .eq("user_id", ownerId)
      .maybeSingle();

    // universal_artwork_url is added by a later migration — retry without it.
    if (error && (error as any).code === "42703") {
      ({ data, error } = await sc
        .from("user_stamps")
        .select(`${BASE_COLS}, stamp_definitions(name, stamp_type)`)
        .eq("id", stampId)
        .eq("user_id", ownerId)
        .maybeSingle());
    }

    if (error || !data) return null;
    if (data.is_revoked) return null;
    // Crawlers are anonymous: only public stamps may be previewed.
    if (data.visibility && data.visibility !== "public") return null;

    const def = data.stamp_definitions ?? null;
    const label =
      data.title_override ??
      def?.name ??
      data.city ??
      data.country ??
      (def?.stamp_type ? String(def.stamp_type).replace(/_/g, " ").toUpperCase() : "Travel Stamp");

    // Prefer the premium composited stamp; fall back to legacy flat art.
    const composited = await fetchCompositedArtworkUrl(sc, data.catalog_id ?? null);
    const artworkUrl = composited ?? def?.universal_artwork_url ?? null;

    // Resolve palette for card theming (best-effort; null → neutral card).
    let palette: StampPalette | null = null;
    try {
      const { resolveIdentity } = await import("../lib/stamps/composition/identities.js");
      const identity = await resolveIdentity(sc, {
        city: data.city ?? null,
        display_name: data.city ?? null,
        country: data.country ?? null,
      });
      palette = identity.palette;
    } catch {
      palette = null;
    }

    return {
      label: String(label),
      artworkUrl,
      city: data.city ?? null,
      country: data.country ?? null,
      earnedAt: data.earned_at ?? null,
      palette,
    };
  } catch {
    return null;
  }
}

interface StampOgCardData {
  stampLabel: string;
  ownerName: string | null;
  ownerUsername: string | null;
  place: string | null;
  earnedAt: string | null;
  artworkDataUri: string | null;
  /** Destination palette (from the composition identity) for card theming. */
  palette: StampPalette | null;
}

/**
 * Build the 1200x630 stamp-share SVG. Rebuilt on the composition system
 * (Wave 3 follow-up): the hero is the PREMIUM COMPOSITED stamp (its own
 * frame/typography/rarity), presented whole on a card themed by the
 * destination's palette — so the share preview matches the in-app stamp
 * instead of the old navy/gold passport styling. Falls back to a neutral
 * palette and a monogram when data is missing.
 */
function buildStampOgSvg(card: StampOgCardData): string {
  const W = 1200;
  const H = 630;

  // Palette-driven theming with safe neutral defaults.
  const p = card.palette;
  const bgDark = p?.background ?? "#101826";
  const primary = p?.primary ?? "#1E3A5F";
  const accent = p?.accent ?? "#E8B04B";
  const paper = p?.paper ?? "#F5EFE0";
  const highlight = p?.highlight ?? accent;

  const label = card.stampLabel.trim().slice(0, 40) || "Travel Stamp";
  const owner = card.ownerName?.trim() || (card.ownerUsername ? `@${card.ownerUsername}` : null);
  let dateLine: string | null = null;
  if (card.earnedAt) {
    const d = new Date(card.earnedAt);
    if (!Number.isNaN(d.getTime())) {
      dateLine = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }
  }
  const subLine = [card.place, dateLine].filter(Boolean).join("  ·  ");

  // The composited stamp already carries its own frame + transparent bg, so we
  // present it WHOLE (contain), never re-clipped. Monogram medallion fallback.
  const STAMP_X = 74, STAMP_Y = 95, STAMP_S = 440;
  const cx = STAMP_X + STAMP_S / 2, cy = STAMP_Y + STAMP_S / 2;
  const art = card.artworkDataUri
    ? `<image href="${card.artworkDataUri}" x="${STAMP_X}" y="${STAMP_Y}" width="${STAMP_S}" height="${STAMP_S}" preserveAspectRatio="xMidYMid meet"/>`
    : `<circle cx="${cx}" cy="${cy}" r="180" fill="${primary}"/>
       <circle cx="${cx}" cy="${cy}" r="180" fill="none" stroke="${accent}" stroke-width="6"/>
       <text x="${cx}" y="${cy + 60}" text-anchor="middle" font-family="Poppins, sans-serif" font-size="150" font-weight="bold" fill="${paper}">${escapeXml(label.slice(0, 1).toUpperCase() || "S")}</text>`;

  const F = "Poppins, sans-serif";
  const TX = 560; // right-column text x

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bgDark}"/>
      <stop offset="1" stop-color="${primary}"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.28" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${highlight}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${highlight}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="18" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.65"/>
  <!-- hero: whole composited stamp -->
  ${art}
  <!-- header -->
  <text x="${TX}" y="132" font-family="${F}" font-size="26" font-weight="700" letter-spacing="14" fill="${accent}">PORTAVA</text>
  <text x="${TX}" y="168" font-family="${F}" font-size="19" font-weight="500" letter-spacing="7" fill="${paper}" opacity="0.6">PASSPORT STAMP</text>
  <!-- stamp label -->
  <text x="${TX}" y="${subLine ? 318 : 336}" font-family="${F}" font-size="${label.length > 18 ? 52 : 66}" font-weight="700" fill="${paper}">${escapeXml(label)}</text>
  ${subLine ? `<text x="${TX}" y="374" font-family="${F}" font-size="28" font-weight="500" fill="${highlight}">${escapeXml(subLine.slice(0, 60))}</text>` : ""}
  ${owner ? `<text x="${TX}" y="${subLine ? 438 : 400}" font-family="${F}" font-size="26" font-weight="400" fill="${paper}" opacity="0.85">Earned by ${escapeXml(owner.slice(0, 40))}</text>` : ""}
  <!-- footer -->
  <line x1="${TX}" y1="528" x2="${W - 74}" y2="528" stroke="${accent}" stroke-width="1.5" opacity="0.5"/>
  <text x="${TX}" y="566" font-family="${F}" font-size="20" font-weight="500" letter-spacing="4" fill="${paper}" opacity="0.55">COLLECT THE WORLD, ONE STAMP AT A TIME</text>
</svg>`;
}

async function renderStampOgPng(card: StampOgCardData): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(buildStampOgSvg(card))).png().toBuffer();
}

/* ===========================================================================
 * GET /users/:username/stamps/:stampId/preview — JSON stamp card for share pages
 * ===========================================================================
 * Used by the share-page server to render OG title/description for
 * /u/<username>?stamp=<id> links. Enforces the same visibility policy as the
 * og-image endpoint; returns 404 whenever the stamp cannot be shown so the
 * caller falls back to the passport preview without leaking anything.
 */
router.get("/users/:username/stamps/:stampId/preview", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { res.status(404).json({ error: "not_found" }); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim().replace(/[^a-z0-9_]/g, "");
  const stampId = req.params.stampId ?? null;
  if (!username || !STAMP_UUID_RE.test(stampId ?? "")) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    const { data: profile } = await sc
      .from("profiles")
      .select("id, username, display_name, name, passport_visibility, is_private")
      .eq("handle", username)
      .maybeSingle();
    if (!profile) { res.status(404).json({ error: "not_found" }); return; }

    // Share pages are rendered for anonymous crawlers — no viewer.
    const { visibility } = await resolveProfileVisibility(sc, null, profile.id, profile);
    if (visibility !== "full" && visibility !== "followers_only") {
      res.status(404).json({ error: "not_found" });
      return;
    }

      const stamp = await fetchPublicStampPreview(sc, profile.id, stampId as string);
    if (!stamp) { res.status(404).json({ error: "not_found" }); return; }

    // Universal display-name rule: share pages are anonymous — owner's real
    // name appears only if they opted in; otherwise clients show @username.
    const ownerAllowName = await nameVisibleFor(sc, profile.id);
    res.status(200).json({
      label: stamp.label,
      artworkUrl: stamp.artworkUrl,
      city: stamp.city,
      country: stamp.country,
      earnedAt: stamp.earnedAt,
      ownerDisplayName: ownerAllowName ? (profile.display_name ?? profile.name ?? null) : null,
      ownerUsername: profile.username ?? username,
    });
  } catch (e: any) {
    req.log.warn({ err: e }, "stamp preview: lookup failed");
    res.status(404).json({ error: "not_found" });
  }
});

router.get("/users/:username/og-image.png", async (req, res) => {
  const sc = getServiceClient();

  const sendPng = async (card: OgCardData | null) => {
    try {
      const png = await renderOgPng(card);
      // Personalized renders (name/stats/avatar) must expire fast so a
      // visibility flip to private stops showing the old preview quickly.
      // Generic renders contain no personal data and can be cached longer.
      const cacheControl = card
        ? "no-store, no-cache, must-revalidate"
        : "public, max-age=600";
      res
        .status(200)
        .set({
          "Content-Type": "image/png",
          "Cache-Control": cacheControl,
        })
        .send(png);
    } catch (e: any) {
      req.log.error({ err: e }, "og-image: render failed");
      sendError(res, "db_error", "Could not render preview image", { exposeDetail: true });
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
      .select("id, username, display_name, name, avatar_url, passport_visibility, is_private, show_profile_picture_publicly")
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

    // ── Stamp variant (?stamp=<id>) — falls back to the passport card ────────
    const stampId = typeof req.query.stamp === "string" ? req.query.stamp : null;
    if (stampId) {
      const stamp = await fetchPublicStampPreview(sc, profile.id, stampId as string);
      if (stamp) {
        try {
          const artworkDataUri = stamp.artworkUrl ? await fetchImageAsDataUri(stamp.artworkUrl) : null;
          const stampOwnerAllowName = await nameVisibleFor(sc, profile.id);
          const png = await renderStampOgPng({
            stampLabel: stamp.label,
            ownerName: stampOwnerAllowName ? (profile.display_name ?? profile.name ?? null) : null,
            ownerUsername: profile.username ?? username,
            place: stamp.city ?? stamp.country ?? null,
            earnedAt: stamp.earnedAt,
            artworkDataUri,
            palette: stamp.palette,
          });
          res
            .status(200)
            // Personalized stamp preview (owner name, stamp label, artwork)
            // must expire fast, same as the personalized passport card.
            .set({ "Content-Type": "image/png", "Cache-Control": "no-store, no-cache, must-revalidate" })
            .send(png);
          return;
        } catch (e: any) {
          req.log.warn({ err: e }, "og-image: stamp render failed, falling back to passport card");
        }
      }
      // Stamp missing/locked/private → fall through to the passport card.
    }

    const [tripResult, stampResult] = await Promise.all([
      countUserTrips(sc, profile.id),
      sc.from("passport_stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id),
    ]);

    // OG image requests are always unauthenticated crawlers (no viewer to be
    // a follower/friend of) — the only tier reachable past the visibility
    // check above is "full", so this is a direct flag check, not a bypass.
    const avatarDataUri =
      profile.avatar_url && (profile as any).show_profile_picture_publicly !== false
        ? await fetchImageAsDataUri(profile.avatar_url)
        : null;

    // Universal display-name rule: OG/share images fall back to @username
    // unless the subject opted in to showing their real name.
    const ogAllowName = await nameVisibleFor(sc, profile.id);
    await sendPng({
      displayName: ogAllowName ? (profile.display_name ?? profile.name ?? null) : null,
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
    .from("passport_stamps")
    .select("id, stamp_type, city, country, awarded_at")
    .eq("user_id", user.id)
    .order("awarded_at", { ascending: false });

  if (error) {
    if ((error as any).code === "PGRST205") {
      res.status(200).json({ stamps: [] });
      return;
    }
    req.log.error({ err: error }, "Failed to load stamps");
    sendError(res, "db_error", error.message);
    return;
  }

  // Live passport_stamps has no kind/label/sublabel/check_in_count/locked
  // columns — derive the legacy PassportStamp shape from the live columns.
  let stamps = (data ?? []).map((r: any) => ({
    id: r.id,
    kind: r.stamp_type,
    label: r.city ?? r.country ?? r.stamp_type,
    sublabel: r.city ? (r.country ?? null) : null,
    earnedAt: r.awarded_at,
    checkInCount: 1,
    locked: false,
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

// ─────────────────────────────────────────────────────────────────────────────
// Passport Projection endpoints (§4/§29/§30) — ADDITIVE, read-only.
//
// One privacy-aware, context-aware projection surface. `:userId` accepts either
// a profile UUID or an @handle. The viewer is resolved from the optional bearer
// token; all privacy filtering happens server-side inside the services.
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a `:userId` route param (UUID or @handle) to a profile id, or null. */
async function resolveProjectionUserId(sc: any, param: string): Promise<string | null> {
  const raw = String(param ?? "").trim();
  if (!raw) return null;
  if (UUID_RE.test(raw)) {
    const { data } = await sc.from("profiles").select("id").eq("id", raw).maybeSingle();
    return data ? (data as any).id : null;
  }
  const handle = raw.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!handle) return null;
  const { data } = await sc.from("profiles").select("id").eq("handle", handle).maybeSingle();
  return data ? (data as any).id : null;
}

// GET /api/passport/:userId/projection — the full §29 aggregate for a viewer.
//
// §31 caching: the response carries a Cache-Control max-age equal to the SHORTEST
// TTL among the sections actually present (so it is never cached past its most
// volatile part — availability/state/trust), plus a per-section `cache.sections`
// map so the client can tier its own cache (identity/stamps for an hour, dynamic
// sections every 30s). A weak ETag over the projection enables 304 revalidation.
// The response is `private` for an authenticated viewer (it is viewer-specific)
// and `public` for the anonymous view (identical for every anonymous caller).
router.get("/passport/:userId/projection", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }
  try {
    const targetId = await resolveProjectionUserId(sc, req.params.userId);
    if (!targetId) { sendError(res, "not_found", "User not found"); return; }
    const viewerId = await getOptionalViewerId(sc, req);
    const projection = await buildPassportProjection(sc, targetId, viewerId);
    if (!projection) { sendError(res, "not_found", "User not found"); return; }

    const cache = buildProjectionCachePolicy(projection);
    const scope = viewerId ? "private" : "public";
    // Weak ETag over the projection body (the cache policy derives from it).
    const etag = `W/"${createHash("sha1").update(JSON.stringify(projection)).digest("hex")}"`;
    res.setHeader("Cache-Control", `${scope}, max-age=${cache.maxAge}`);
    res.setHeader("ETag", etag);
    // A conditional request whose validator still matches → 304, no body.
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).json({ projection, cache });
  } catch (e: any) {
    req.log.error({ err: e }, "passport projection failed");
    sendError(res, "db_error", e?.message ?? "Projection failed");
  }
});

// GET /api/passport/:userId/shared-context — viewer↔owner overlap (§17/§18).
router.get("/passport/:userId/shared-context", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }
  try {
    const targetId = await resolveProjectionUserId(sc, req.params.userId);
    if (!targetId) { sendError(res, "not_found", "User not found"); return; }
    const viewerId = await getOptionalViewerId(sc, req);
    if (!viewerId) { sendError(res, "unauthenticated", "Sign in to view shared context"); return; }
    if (viewerId === targetId) {
      res.status(200).json({ sharedContext: null, reason: "self" });
      return;
    }
    const resolution = await resolvePassportViewerContext(sc, targetId, viewerId);
    // Blocked / unavailable relationships get no overlap facts — mirror the sibling
    // /journeys and /contributions endpoints (a blocked viewer must not receive
    // both-in-city / shared-cities / intent-overlap / compass-city context).
    if (resolution.permissions.isBlocked || resolution.permissions.isUnavailable) {
      res.status(200).json({ sharedContext: null, restricted: true });
      return;
    }
    const sharedContext = await buildSharedContext(sc, targetId, viewerId, {
      canSeeAvailability: resolution.permissions.canSeeAvailability,
      canSeeMutuals: resolution.permissions.canSeeMutuals,
      canSeeTrips: resolution.permissions.canSeeTrips,
      canMakePlan: resolution.permissions.canInviteToTripCrew,
    });
    res.status(200).json({ sharedContext, viewerContext: resolution.context });
  } catch (e: any) {
    req.log.error({ err: e }, "passport shared-context failed");
    sendError(res, "db_error", e?.message ?? "Shared context failed");
  }
});

// GET /api/passport/:userId/journeys — grouped chronological journeys (§14).
router.get("/passport/:userId/journeys", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }
  try {
    const targetId = await resolveProjectionUserId(sc, req.params.userId);
    if (!targetId) { sendError(res, "not_found", "User not found"); return; }
    const viewerId = await getOptionalViewerId(sc, req);
    const resolution = await resolvePassportViewerContext(sc, targetId, viewerId);
    if (resolution.permissions.isBlocked || resolution.permissions.isUnavailable) {
      res.status(200).json({ journeys: { userId: targetId, years: [], featured: null, totalJourneys: 0 }, restricted: true });
      return;
    }
    const isSelf = resolution.context === "self";
    const journeys = await buildJourneys(sc, targetId, {
      isSelf,
      canSeeTrips: resolution.permissions.canSeeTrips,
      canSeeRestricted:
        resolution.permissions.canViewFullProfile ||
        resolution.context === "trip_crew" ||
        resolution.context === "trip_host",
      // Per-memory visibility gate for the memories attached to each journey
      // (§29 step 9) — a public trip must not leak its private memories.
      callerCtx: toCallerContext(resolution.context, resolution.permissions),
      // §14/§24 — block-filter journey people in both directions vs the viewer.
      viewerId,
    });
    res.status(200).json({ journeys, viewerContext: resolution.context });
  } catch (e: any) {
    req.log.error({ err: e }, "passport journeys failed");
    sendError(res, "db_error", e?.message ?? "Journeys failed");
  }
});

// PUT /api/passport/me/travel-dna — owner-only Show/Hide/Not-Me write (§19).
// Persists the caller's own display control over one inferred Travel DNA
// dimension or trait. Owner-scoped (session user only), gated fail-closed by the
// passport_travel_dna_enabled capability flag, written via service_role.
const travelDnaWriteSchema = z.object({
  key: z.string().trim().min(1).max(120),
  kind: z.enum(["dimension", "trait"]),
  state: z.enum(["shown", "hidden", "not_me"]),
});

router.put("/passport/me/travel-dna", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const parsed = travelDnaWriteSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Unavailable"); return; }
  try {
    const result = await writeTravelDnaPref(sc, auth.user.id, parsed.data);
    if (!result.ok) {
      if (result.reason === "feature_disabled") { sendError(res, "feature_disabled", "Travel DNA controls are unavailable"); return; }
      if (result.reason === "invalid_state" || result.reason === "invalid_key") { sendError(res, "invalid_payload", "Invalid Travel DNA preference"); return; }
      sendError(res, "db_error", "Failed to save preference");
      return;
    }
    res.status(200).json({ pref: result.pref });
  } catch (e: any) {
    req.log.error({ err: e }, "passport travel-dna write failed");
    sendError(res, "db_error", e?.message ?? "Travel DNA write failed");
  }
});

// GET /api/passport/:userId/contributions — read-only reputation summary for the
// client ContributionCard (§20/TABLE 21). Paid contributions never inflate the
// factual counts and no private moderation data is exposed (enforced in
// PassportReputationService). Blocked / unavailable relationships get nothing.
router.get("/passport/:userId/contributions", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }
  try {
    const targetId = await resolveProjectionUserId(sc, req.params.userId);
    if (!targetId) { sendError(res, "not_found", "User not found"); return; }
    const viewerId = await getOptionalViewerId(sc, req);
    const resolution = await resolvePassportViewerContext(sc, targetId, viewerId);
    if (resolution.permissions.isBlocked || resolution.permissions.isUnavailable) {
      res.status(200).json({ contributions: null, restricted: true });
      return;
    }
    const contributions = await buildReputationSummary(sc, targetId);
    res.status(200).json({ contributions, viewerContext: resolution.context });
  } catch (e: any) {
    req.log.error({ err: e }, "passport contributions failed");
    sendError(res, "db_error", e?.message ?? "Contributions failed");
  }
});

/* ===========================================================================
 * Temporary / event Passport (§25 "Share Passport options", §31 "Explicitly
 * expire … event Passport, temporary sharing", TABLE 31 Phase 8)
 * ===========================================================================
 * Three endpoints around EventPassportService. The service owns every rule —
 * flag gate, bounded TTL, revocation, the event's own end, co-attendance, and
 * the narrowing to the `event` consumer-projection variant. These handlers only
 * translate its refusals into status codes, so there is exactly ONE place where
 * an event Passport can be granted.
 *
 * With `passport_event_share_enabled` OFF (its seed, migration 2294) every one
 * of them answers `{ enabled: false }` and nothing is minted or resolved.
 */

/** Map a service refusal onto an HTTP answer. */
function sendEventShareRefusal(res: any, reason: string): void {
  switch (reason) {
    case "disabled":
      res.status(200).json({ enabled: false });
      return;
    case "event_not_found":
    case "not_found":
      sendError(res, "not_found", "Share not found");
      return;
    case "event_not_live":
      sendError(res, "invalid_payload", "That event is not currently running");
      return;
    case "owner_not_attending":
      sendError(res, "forbidden", "You are not attending that event");
      return;
    case "revoked":
      sendError(res, "forbidden", "This event Passport was revoked");
      return;
    case "expired":
      sendError(res, "forbidden", "This event Passport has expired");
      return;
    case "not_attending":
      sendError(res, "forbidden", "This event Passport is only for people at the event");
      return;
    default:
      sendError(res, "not_found", "Share not found");
  }
}

const EventShareCreateSchema = z.object({ eventId: z.string().uuid() });

// POST /api/passport/event-share — mint (or re-mint) the caller's event Passport.
router.post("/passport/event-share", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }

  const parsed = EventShareCreateSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "eventId must be a uuid"); return; }

  try {
    const out = await createEventPassportShare(sc, auth.user.id, parsed.data.eventId);
    if (!out.ok) { sendEventShareRefusal(res, out.reason); return; }
    res.status(201).json({
      enabled: true,
      share: {
        token: out.value.token,
        eventId: out.value.eventId,
        expiresAt: out.value.expiresAt,
      },
    });
  } catch (e: any) {
    req.log.error({ err: e }, "event passport share create failed");
    sendError(res, "db_error", e?.message ?? "Share failed");
  }
});

// POST /api/passport/event-share/:eventId/revoke — withdraw the caller's share.
router.post("/passport/event-share/:eventId/revoke", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }

  const eventId = String(req.params.eventId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  try {
    const out = await revokeEventPassportShare(sc, auth.user.id, eventId);
    if (!out.ok) { sendEventShareRefusal(res, out.reason); return; }
    res.status(200).json({ enabled: true, revoked: out.value.revoked });
  } catch (e: any) {
    req.log.error({ err: e }, "event passport share revoke failed");
    sendError(res, "db_error", e?.message ?? "Revoke failed");
  }
});

// GET /api/passport/event-share/:eventId — the caller's OWN live share, if any.
// Expiry is applied on this read too, so the owner is never shown "sharing"
// for a share that has already lapsed (§31 "never render stale … as current").
router.get("/passport/event-share/:eventId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }

  const eventId = String(req.params.eventId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  try {
    if (!(await isFlagEnabled(sc, "passport_event_share_enabled"))) {
      res.status(200).json({ enabled: false, share: null });
      return;
    }
    const share = await getOwnEventPassportShare(sc, auth.user.id, eventId);
    res.status(200).json({
      enabled: true,
      share: share ? { token: share.token, eventId: share.eventId, expiresAt: share.expiresAt } : null,
    });
  } catch (e: any) {
    req.log.error({ err: e }, "event passport share read failed");
    sendError(res, "db_error", e?.message ?? "Share read failed");
  }
});

// GET /api/passport/event-passport/:token — resolve a scanned event Passport.
//
// Authentication is REQUIRED: the share is event-scoped and an anonymous caller
// can never be an attendee, so there is no anonymous read path to fall through
// to. The response is `private, no-store` — it is viewer-specific and expires.
router.get("/passport/event-passport/:token", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "not_found", "Unavailable"); return; }

  try {
    const out = await resolveEventPassport(sc, String(req.params.token ?? ""), auth.user.id);
    if (!out.ok) { sendEventShareRefusal(res, out.reason); return; }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({
      enabled: true,
      share: out.value.share,
      passport: out.value.passport,
    });
  } catch (e: any) {
    req.log.error({ err: e }, "event passport resolve failed");
    sendError(res, "db_error", e?.message ?? "Resolve failed");
  }
});

export default router;
