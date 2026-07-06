import { enrichSpans } from '../lib/enrichSpans';
import { isFlagEnabled } from '../lib/featureFlags';
import { getCompassProfile } from "../compass/CompassProfileService";
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine";

/**
 * Pulse feed routes
 *
 * GET /api/pulse  — location-scoped Pulse feed
 *   Auth required. Returns posts + their pulse_geo_tags context.
 *   Exact GPS coordinates are never returned; only safe public labels.
 *
 * Tabs / filters:
 *   tab=city        — any post with city/neighborhood/venue-tagged visibility
 *   tab=nearby      — city_only or better + requester has nearby sharing
 *   tab=neighborhood — neighborhood or venue_tagged only
 *   tab=trip        — trip-attached posts only
 *   tab=crew        — posts from followed users only
 *   tab=all (default) — all non-hidden posts
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

const VALID_TABS = ["all", "city", "nearby", "neighborhood", "trip", "crew", "airport"] as const;
type PulseTab = typeof VALID_TABS[number];

// Visibility levels that each tab considers visible
const TAB_VISIBILITY: Record<PulseTab, string[] | null> = {
  all:          null,                                                       // no filter
  city:         ["city_only", "neighborhood", "venue_tagged"],
  nearby:       ["city_only", "neighborhood", "venue_tagged", "exact_hidden"],
  neighborhood: ["neighborhood", "venue_tagged"],
  trip:         null,                                                       // trip_id IS NOT NULL filter instead
  crew:         null,                                                       // followed-users filter instead
  airport:      null,                                                       // airport city filter from query param
};

const pulseQuerySchema = z.object({
  tab:    z.enum(VALID_TABS).optional().default("all"),
  limit:  z.coerce.number().int().min(1).max(50).optional().default(20),
  before: z.string().datetime().optional(),
  // airport tab: filter by airport city
  airportCity: z.string().max(100).optional(),
  // location context — used to fill in place recommendation cards when posts are thin
  city: z.string().max(200).optional(),
  lat:  z.coerce.number().optional(),
  lng:  z.coerce.number().optional(),
});

// Safe columns — exact GPS is never projected
const POST_SAFE_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, " +
  "location_name, location_city, location_country, location_source";

const GEO_TAG_COLUMNS =
  "location_visibility, city, district, country, country_code, venue_name, hotel_blur_applied";

const POST_MEDIA_COLUMNS =
  "id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status";

/** Filter and shape the post_media array for public consumption.
 *  Excludes failed/pending and rejected/flagged items; sorts by sort_order.
 *  Returns snake_case keys to match post_media column names. */
function filterPublicMedia(raw: any): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m.processing_status === 'ready' && m.moderation_status !== 'rejected' && m.moderation_status !== 'flagged')
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

/* ===========================================================================
 * GET /api/pulse
 * =========================================================================*/
router.get("/pulse", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = pulseQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { tab, limit, before, airportCity, city: cityParam, lat: latParam, lng: lngParam } = parsed.data;

  // For crew tab we need the followed-user IDs first
  let crewIds: string[] | null = null;
  if (tab === "crew") {
    const { data: followRows } = await client
      .from("follows")
      .select("following_id")
      .eq("follower_id", user.id);
    crewIds = (followRows as any[] ?? []).map((r: any) => r.following_id);
    if (crewIds.length === 0) {
      res.json({ posts: [], total: 0, tab });
      return;
    }
  }

  // Build base query: posts joined with pulse_geo_tags
  // We use the service client to bypass RLS for the join read, but only project safe columns
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  // Fetch caller's hidden post IDs before the main query so the DB-level LIMIT
  // applies to visible posts only — avoiding premature hasMore=false for pages
  // that happen to contain hidden entries.
  const hiddenPostIds: string[] = [];
  try {
    const { data: hiddenRows } = await sc
      .from("post_hides")
      .select("post_id")
      .eq("user_id", user.id);
    for (const r of hiddenRows ?? []) hiddenPostIds.push((r as any).post_id);
  } catch { /* best-effort: feed continues even if the hide table is unreachable */ }

  let query = sc
    .from("posts")
    .select(`${POST_SAFE_COLUMNS}, post_media(${POST_MEDIA_COLUMNS}), pulse_geo_tags(${GEO_TAG_COLUMNS}), profiles!author_id(id, username, full_name, avatar_url)`)
    .eq("status", "active")
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt("created_at", before);
  }
  if (hiddenPostIds.length > 0) {
    query = query.not("id", "in", `(${hiddenPostIds.join(",")})`);
  }

  // Tab-specific filters
  if (tab === "trip") {
    query = query.not("trip_id", "is", null);
  } else if (tab === "crew" && crewIds) {
    query = query.in("author_id", crewIds);
  } else if (tab === "airport" && airportCity) {
    query = query.ilike("location_city", `%${airportCity}%`);
  }

  const { data, error } = await query;
  if (error) {
    req.log.error({ err: error }, "pulse feed query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Apply visibility tab filter client-side (pulse_geo_tags may be null for older posts)
  const visibilityFilter = TAB_VISIBILITY[tab];
  let rows = (data as any[]) ?? [];
  if (visibilityFilter !== null && tab !== "trip" && tab !== "crew") {
    rows = rows.filter((row) => {
      const geoTag = Array.isArray(row.pulse_geo_tags)
        ? row.pulse_geo_tags[0]
        : row.pulse_geo_tags;
      if (!geoTag) return tab === "all" || tab === "city"; // no tag → include for broad tabs
      return visibilityFilter.includes(geoTag.location_visibility);
    });
  }

  // ── Pre-shape: blocked-author filter + delayed-location guard ─────────────
  // Both guards run on raw rows (before camelCase shaping) so they can access
  // the snake_case DB column names (author_id, location_source).
  //
  // This block is a best-effort load; if the blocks query fails the feed is
  // served without the filter (non-fatal — Compass ranking will degrade too).
  try {
    const [blockedRes, blockerRes] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
      sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
    ]);
    const blockedSet = new Set<string>();
    for (const row of (blockedRes.data as any[]) ?? []) blockedSet.add(row.blocked_id as string);
    for (const row of (blockerRes.data as any[]) ?? []) blockedSet.add(row.blocker_id as string);

    if (blockedSet.size > 0) {
      rows = rows.filter((row) => !blockedSet.has(row.author_id as string));
    }
  } catch { /* non-fatal */ }

  // Delayed-posting location guard: posts whose location has not yet been
  // cleared by the delayed-publish job must have location fields scrubbed
  // before they enter the response — real-time GPS must never reach other users.
  rows = rows.map((row: any) => {
    if (row.location_source === "delayed_pending" || row.location_source === "pending_location_exit") {
      return {
        ...row,
        location_name:    null,
        location_city:    null,
        location_country: null,
        venue_name:       null,
        // Keep visibility label generic so clients don't infer location
        pulse_geo_tags: null,
      };
    }
    return row;
  });

  // Post-level moderation guard: exclude posts whose media was entirely
  // rejected or failed.  A post that *had* media but has zero ready items
  // after filtering must not appear in the feed.  Text-only posts (no
  // post_media rows at all) are always allowed through.
  rows = rows.filter((row: any) => {
    const rawMedia = Array.isArray(row.post_media) ? row.post_media : [];
    if (rawMedia.length === 0) return true; // text-only post — always allow
    const ready = rawMedia.filter(
      (m: any) => m.processing_status === 'ready' &&
                  m.moderation_status !== 'rejected' &&
                  m.moderation_status !== 'flagged',
    );
    return ready.length > 0;
  });

  // Enrich posts with positioned @mention + #hashtag spans
  const spansMap = await enrichSpans(
    sc, 'post',
    rows.map((r: any) => ({ id: r.id as string, content: (r.content ?? '') as string })),
    user.id,
  );

  // Batch-fetch which posts the viewer has bookmarked so we can include savedByMe
  // in the response without a per-post query.
  const postIds = rows.map((r: any) => r.id as string);
  const savedSet = new Set<string>();
  if (postIds.length > 0) {
    try {
      const { data: saveRows } = await sc
        .from("post_saves")
        .select("post_id")
        .eq("user_id", user.id)
        .in("post_id", postIds);
      for (const r of (saveRows as any[]) ?? []) savedSet.add(r.post_id as string);
    } catch { /* non-fatal — savedByMe defaults to false */ }
  }

  // Shape responses — NEVER include exact coords
  const posts = rows.map((row: any) => {
    const geoTag = Array.isArray(row.pulse_geo_tags)
      ? row.pulse_geo_tags[0]
      : row.pulse_geo_tags;
    const profile = Array.isArray(row.profiles)
      ? row.profiles[0]
      : row.profiles;
    const spans = spansMap[row.id] ?? { tags: [], hashtagUsages: [] };
    return {
      id:          row.id,
      authorId:    row.author_id,
      tripId:      row.trip_id ?? null,
      content:     row.content,
      mediaUrls:   row.media_urls ?? [],
      visibility:  row.visibility,
      createdAt:   row.created_at,
      // location labels — safe, no coords
      locationName:    row.location_name ?? null,
      locationCity:    geoTag?.city ?? row.location_city ?? null,
      locationCountry: geoTag?.country ?? row.location_country ?? null,
      locationDistrict: geoTag?.district ?? null,
      venueName:       geoTag?.venue_name ?? null,
      locationVisibility: geoTag?.location_visibility ?? "city_only",
      hotelBlurApplied:   geoTag?.hotel_blur_applied ?? false,
      // author (safe public profile)
      author: profile ? {
        id:        profile.id,
        username:  profile.username,
        name:      profile.full_name ?? profile.username,
        avatarUrl: profile.avatar_url ?? null,
      } : null,
      // Structured media items (photo + video); legacy mediaUrls preserved for backward compat
      media: filterPublicMedia(row.post_media),
      // Rich-text span whitelists
      spanTags:         spans.tags,
      spanHashtags:     spans.hashtagUsages,
      // Bookmark state for the authenticated viewer
      savedByMe: savedSet.has(row.id as string),
    };
  });

  // ── Compass ranking pass ────────────────────────────────────────────────────
  // Block filtering and delayed-location guarding already happened in the
  // pre-shape section above (operating on raw rows).  This pass applies
  // Compass-specific scoring signals to re-rank the already-filtered posts.
  //
  // Signals:
  //   a. Followed-user recency boost
  //   b. Hashtag interest boost (from compass_user_preferences)
  //   c. Viewer's current Compass city boost
  let orderedPosts = posts;
  let prompts: Array<{ type: string; id: string; title: string; body: string; action: string }> = [];

  try {
    const compassEnabled = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "COMPASS_ENABLED")
      .maybeSingle();

    if ((compassEnabled.data as any)?.enabled) {
      // ── Compass profile for ranking signals ───────────────────────
      const compassProfile = await getCompassProfile(sc, user.id);
      const compassContext = buildCompassContext(compassProfile, defaultSignals(compassProfile));
      const intentMode     = deriveIntentMode(compassContext);
      const primaryMode    = intentMode.primary;

      // Load viewer's followed user IDs (for recency boost)
      let followedIds = new Set<string>();
      try {
        const { data: followRows } = await sc
          .from("follows")
          .select("following_id")
          .eq("follower_id", user.id);
        for (const row of (followRows as any[]) ?? []) {
          followedIds.add(row.following_id as string);
        }
      } catch { /* non-fatal */ }

      // Load viewer's interest hashtags (for hashtag boost)
      let interestTags: Set<string> = new Set();
      try {
        const { data: prefRow } = await sc
          .from("compass_user_preferences")
          .select("interests")
          .eq("user_id", user.id)
          .maybeSingle();
        const interests: string[] = (prefRow as any)?.interests ?? [];
        interestTags = new Set(interests.map((t: string) => t.toLowerCase()));
      } catch { /* non-fatal */ }

      const viewerCity = (compassProfile.currentCity ?? "").toLowerCase();

      // ── Scoring function ─────────────────────────────────────────────────
      // Base score: recency (0–100, linearly decays over 7 days).
      // Boosts are additive multipliers (not caps) so strong signals compound.
      const NOW_MS = Date.now();
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
      const TWO_HOURS_MS  = 2 * 60 * 60 * 1_000;

      function scorePost(p: any): number {
        const ageMs = NOW_MS - new Date(p.createdAt).getTime();
        const recency = Math.max(0, 1 - ageMs / SEVEN_DAYS_MS); // 0–1

        let boost = 0;

        // a. Followed-user recency boost — posts from followed users within 2 h
        //    get a strong boost; older posts from followed users get a mild boost.
        if (followedIds.has(p.authorId)) {
          boost += ageMs <= TWO_HOURS_MS ? 0.5 : 0.2;
        }

        // b. Hashtag interest boost — any matching hashtag slug in the post
        if (interestTags.size > 0 && Array.isArray(p.spanHashtags)) {
          const matched = (p.spanHashtags as Array<{ slug: string }>)
            .some((h) => interestTags.has(h.slug?.toLowerCase() ?? ""));
          if (matched) boost += 0.3;
        }

        // c. City boost — posts from the viewer's current Compass city
        if (viewerCity && (p.locationCity ?? "").toLowerCase().includes(viewerCity)) {
          boost += 0.2;
        }

        return recency + boost;
      }

      // Re-rank by score descending (stable: equal scores keep createdAt order)
      const scored = posts.map((p: any) => ({ p, score: scorePost(p) }));
      scored.sort((a: any, b: any) => b.score - a.score);
      orderedPosts = scored.map((x: any) => x.p);

      // ── Intent-mode overlays (applied after ranking) ─────────────────────
      if (compassContext.contextState === "safety_mode" || primaryMode === "safety_mode") {
        prompts = [
          {
            type:   "safe_return_prompt",
            id:     `safe_return_prompt_${Date.now()}`,
            title:  "Are you safe?",
            body:   "Let your travel crew know you've arrived safely.",
            action: "safe_return",
          },
        ];
        // After prompts: location-rich posts first within the ranked set
        const withLocation    = orderedPosts.filter((p: any) => p.venueName || (p.locationCity && p.locationCountry));
        const withoutLocation = orderedPosts.filter((p: any) => !(p.venueName || (p.locationCity && p.locationCountry)));
        orderedPosts = [...withLocation, ...withoutLocation];
      } else if (compassContext.contextState === "night_mode" || primaryMode === "night_mode") {
        // Night Mode: filter to last 8 hours — fresh night content only
        const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1_000).toISOString();
        const recent = orderedPosts.filter((p: any) => p.createdAt >= cutoff);
        orderedPosts = recent.length >= 3 ? recent : orderedPosts;
      }
    }
  } catch { /* Compass ranking is non-fatal — return unmodified posts on any error */ }

  // Place recommendation cards — appended when live post count is below threshold.
  // Queries discovery_places for the requested city so the Pulse Wall shows nearby
  // places even when the social feed is thin. Non-fatal: always fails-open to [].
  const PLACE_CARD_THRESHOLD = 5;
  let placeCards: unknown[] = [];
  try {
    if (orderedPosts.length < PLACE_CARD_THRESHOLD && cityParam) {
      const cityBase = cityParam.split(",")[0]?.trim() ?? cityParam;
      const { data: nearbyPlaces } = await sc
        .from("discovery_places")
        .select("id, name, city, category, place_type, blurb, image_url, rating, lat, lng, neighborhood")
        .or(`city.ilike.%${cityBase}%`)
        .eq("status", "active")
        .order("saved_count", { ascending: false })
        .limit(10);

      // Inline haversine (km) — used for proximity sort when caller supplies coords
      const haversineKm = (la1: number, lo1: number, la2: number, lo2: number): number => {
        const R = 6371;
        const dLat = ((la2 - la1) * Math.PI) / 180;
        const dLon = ((lo2 - lo1) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      const mapped = ((nearbyPlaces ?? []) as any[]).map((p: any) => {
        const pLat = p.lat != null ? parseFloat(String(p.lat)) : null;
        const pLng = p.lng != null ? parseFloat(String(p.lng)) : null;
        const distanceKm =
          latParam != null && lngParam != null && pLat != null && pLng != null
            ? Math.round(haversineKm(latParam, lngParam, pLat, pLng) * 10) / 10
            : null;
        return {
          type: "place_card",
          id: `place_card_${p.id as string}`,
          placeId: p.id as string,
          name: p.name as string,
          city: (p.city ?? cityParam) as string,
          category: (p.category ?? p.place_type ?? null) as string | null,
          blurb: (p.blurb ?? null) as string | null,
          imageUrl: (p.image_url ?? null) as string | null,
          rating: p.rating != null ? parseFloat(String(p.rating)) : null,
          distanceKm,
          neighborhood: (p.neighborhood ?? null) as string | null,
        };
      });

      // When caller provides GPS coords, radius-filter to ≤50 km then sort by proximity.
      // This keeps place cards relevant to the user's actual location rather than just
      // any place in the city string. Falls back to saved_count order when no coords.
      const RADIUS_KM = 50;
      placeCards =
        latParam != null && lngParam != null
          ? mapped
              .filter((p: any) => p.distanceKm == null || (p.distanceKm as number) <= RADIUS_KM)
              .sort((a: any, b: any) => {
                if (a.distanceKm == null) return 1;
                if (b.distanceKm == null) return -1;
                return (a.distanceKm as number) - (b.distanceKm as number);
              })
          : mapped;
    }
  } catch { /* non-fatal — place cards degrade gracefully */ }

  res.json({ posts: orderedPosts, total: orderedPosts.length, tab, prompts, placeCards });
});

/* ===========================================================================
 * GET /api/pulse/live
 *
 * Aggregates real-time items from Safe Return, Events, Trips, Circles,
 * Rent-a-Buddy, Hidden Gems, and Compass picks into a single ranked,
 * deduplicated, privacy-filtered rail for the Pulse screen.
 *
 * Priority order (lower number = higher urgency):
 *   0 — Safety (active Safe Return session)
 *   1 — User-owned items starting soon (hosted events/trips)
 *   2 — Joined items starting soon
 *   3 — Pending requests (Action Needed)
 *   4 — Ongoing / Ends Soon
 *   5 — Active circles (gathering now)
 *   6 — Tonight
 *   7 — Tomorrow
 *   8 — Upcoming (≤14 days)
 *   9 — Discovery (gems, Compass picks)
 *
 * Privacy guarantees:
 *   - No exact GPS coordinates in response
 *   - Blocked users (both directions) excluded from all sources
 *   - Events: only public + friends_only visibility shown to non-hosts
 *   - Invite-only events excluded unless caller is host
 *   - Capacity check: ended/cancelled/draft events excluded
 *   - Buddy items: only approved/auto_approved profiles shown
 *   - Feature-flagged sources are skipped when flag is disabled (fail-open)
 *   - Trips: only public + friends visibility to non-members
 *
 * Query params:
 *   context     — 'nearMe'|'currentCity'|'tripCity'|'savedCity'|'specificTrip'|'myPlans'
 *   lat/lng     — optional caller location (not reflected in response)
 *   citySlug    — city name for location-scoped queries
 *   tripId      — required when context='specificTrip'
 *
 * Response: { items: LivePulseItem[], fallbackContext?: string }
 * =========================================================================*/

export type LivePulseItemType =
  | 'event'
  | 'trip'
  | 'trip_request'
  | 'buddy_request'
  | 'available_buddy'
  | 'hidden_gem'
  | 'compass'
  | 'circle'
  | 'safe_return';

export type StatusLabel =
  | 'Starting Soon' | 'Ongoing' | 'Ends Soon' | 'Tonight' | 'Tomorrow'
  | 'Upcoming' | 'Action Needed' | 'My Plan';

export interface LivePulseItem {
  id: string;
  item_type: LivePulseItemType;
  item_id: string;
  status_label: StatusLabel;
  title: string;
  subtitle: string | null;
  city: string | null;
  starts_at: string | null;
  ends_at: string | null;
  people_count: number | null;
  user_relationship: 'host' | 'joined' | 'saved' | 'pending' | 'available' | null;
  primary_action: { label: string; type: string } | null;
  secondary_action: { label: string; type: string } | null;
  reason_labels: string[];
  expires_at: string | null;
  is_joinable: boolean;
}

/** Compute the human-readable status label from timing data. */
export function computeStatusLabel(
  startsAt: string | null,
  endsAt: string | null,
): StatusLabel {
  const now = Date.now();
  if (!startsAt) return 'My Plan';

  const startMs = new Date(startsAt).getTime();
  const endMs   = endsAt ? new Date(endsAt).getTime() : null;

  if (endMs !== null && endMs <= now) return 'My Plan'; // ended — caller filters
  if (startMs <= now) {
    if (endMs !== null && endMs - now <= 45 * 60 * 1000) return 'Ends Soon';
    return 'Ongoing';
  }

  const minsToStart = (startMs - now) / 60_000;
  if (minsToStart <= 60) return 'Starting Soon';

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (startMs <= todayEnd.getTime()) return 'Tonight';

  const tomorrowEnd = new Date(todayEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  if (startMs <= tomorrowEnd.getTime()) return 'Tomorrow';

  const daysAway = (startMs - now) / 86_400_000;
  if (daysAway <= 14) return 'Upcoming';
  return 'My Plan';
}

/**
 * Assign a numeric urgency for ranking (lower = higher priority):
 *   0 — Safety (Safe Return)
 *   1 — User-owned items starting soon
 *   2 — Joined items starting soon
 *   3 — Pending requests (Action Needed)
 *   4 — Ongoing / Ends Soon
 *   5 — Circles active now
 *   6 — Tonight
 *   7 — Tomorrow
 *   8 — Upcoming
 *   9 — Discovery
 */
function urgency(item: LivePulseItem & { _urgency?: number }): number {
  if (item._urgency !== undefined) return item._urgency;
  if (item.item_type === 'safe_return') return 0;
  if (item.user_relationship === 'pending') return 3;
  if (item.item_type === 'circle') return 5;
  const sl = item.status_label;
  if (sl === 'Starting Soon' && item.user_relationship === 'host') return 1;
  if (sl === 'Starting Soon' && item.user_relationship === 'joined') return 2;
  if (sl === 'Starting Soon') return 2;
  if (sl === 'Ongoing' || sl === 'Ends Soon') return 4;
  if (sl === 'Tonight') return 6;
  if (sl === 'Tomorrow') return 7;
  if (sl === 'Upcoming') return 8;
  return 9; // discovery, My Plan, etc.
}

const livePulseQuerySchema = z.object({
  context:  z.enum(['nearMe', 'currentCity', 'tripCity', 'savedCity', 'specificTrip', 'myPlans']).optional().default('myPlans'),
  lat:      z.coerce.number().optional(),
  lng:      z.coerce.number().optional(),
  citySlug: z.string().max(200).optional(),
  tripId:   z.string().uuid().optional(),
});

router.get("/pulse/live", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const parsed = livePulseQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  let { context, citySlug, tripId } = parsed.data;
  const { lat, lng } = parsed.data;

  // Validate that specificTrip context includes a tripId
  if (context === 'specificTrip' && !tripId) {
    sendError(res, 'invalid_payload', 'tripId is required when context is specificTrip');
    return;
  }

  // ── Location-off fallback: nearMe without coordinates → tripCity → savedCity → myPlans ──
  let fallbackContext: string | undefined;
  if (context === 'nearMe' && (lat === undefined || lng === undefined)) {
    fallbackContext = 'tripCity';
    context = 'tripCity';
  }

  // ── Load feature flags in parallel ─────────────────────────────────────
  const [safeReturnEnabled, hiddenGemsEnabled, circlesEnabled] = await Promise.all([
    isFlagEnabled(sc, 'safe_return_enabled').catch(() => false),
    isFlagEnabled(sc, 'hidden_gems_enabled').catch(() => false),
    isFlagEnabled(sc, 'find_your_circle_enabled').catch(() => false),
  ]);

  // ── Load blocked user IDs (both directions) ──────────────────────────────
  const blockedSet = new Set<string>();
  try {
    const [outRes, inRes] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
      sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
    ]);
    for (const r of (outRes.data as any[]) ?? []) blockedSet.add(r.blocked_id as string);
    for (const r of (inRes.data as any[]) ?? []) blockedSet.add(r.blocker_id as string);
  } catch { /* non-fatal */ }

  const items: (LivePulseItem & { _urgency?: number })[] = [];
  const seen = new Set<string>();

  function addItem(item: LivePulseItem & { _urgency?: number }) {
    const key = `${item.item_type}:${item.item_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }

  const now = new Date().toISOString();

  // ── 0. Safe Return — active sessions (urgency 0, highest priority) ─────────
  if (safeReturnEnabled) {
    try {
      const { data: sessions } = await sc
        .from("safe_return_sessions")
        .select("id, status, timer_end_at, trip_id, escalation_level")
        .eq("user_id", user.id)
        .in("status", ["active", "pending"])
        .gt("timer_end_at", now)
        .order("timer_end_at", { ascending: true })
        .limit(1);

      for (const session of (sessions as any[]) ?? []) {
        const minutesLeft = session.timer_end_at
          ? Math.ceil((new Date(session.timer_end_at as string).getTime() - Date.now()) / 60_000)
          : null;
        const subtitle = minutesLeft !== null ? `Check-in in ${minutesLeft} min` : 'Check-in required';
        addItem({
          id:                `safe_return:${session.id as string}`,
          item_type:         'safe_return',
          item_id:           session.id as string,
          status_label:      'Action Needed',
          title:             'Safe Return Active',
          subtitle,
          city:              null,
          starts_at:         null,
          ends_at:           (session.timer_end_at as string | null) ?? null,
          people_count:      null,
          user_relationship: 'joined',
          primary_action:    { label: 'Check In Safe', type: 'confirm_safe_return' },
          secondary_action:  { label: 'Extend Timer', type: 'extend_safe_return' },
          reason_labels:     ['Safety'],
          expires_at:        (session.timer_end_at as string | null) ?? null,
          is_joinable:       false,
          _urgency:          0,
        });
      }
    } catch { /* non-fatal */ }
  }

  // ── 1. Events — hosted and RSVP'd ─────────────────────────────────────────
  try {
    const [hostedRes, rsvpRowsRes] = await Promise.all([
      sc.from("events")
        .select("id, title, starts_at, ends_at, city, state, visibility, max_attendees, going_count")
        .eq("host_id", user.id)
        .in("state", ["open", "started"])
        .gt("ends_at", now),
      sc.from("event_rsvps")
        .select("event_id, status")
        .eq("user_id", user.id)
        .in("status", ["going", "maybe"]),
    ]);

    // Apply city filter for hosted events when context scopes to a city
    // Note: hosted events are shown regardless of visibility — the host always sees their own events.
    for (const ev of (hostedRes.data as any[]) ?? []) {
      if (citySlug && (context === 'currentCity' || context === 'savedCity' || context === 'tripCity')) {
        const evCity = ((ev.city as string | null) ?? '').toLowerCase().replace(/\s+/g, '-');
        if (evCity !== citySlug) continue;
      }
      const sl = computeStatusLabel(ev.starts_at, ev.ends_at);
      if (sl === 'My Plan') continue;
      const maxAtt = ev.max_attendees as number | null;
      const goingCount = (ev.going_count as number | null) ?? 0;
      const atCapacity = maxAtt !== null && goingCount >= maxAtt;
      addItem({
        id:                `event:${ev.id as string}`,
        item_type:         'event',
        item_id:           ev.id as string,
        status_label:      sl,
        title:             ev.title as string,
        subtitle:          ev.city ? `Hosted · ${ev.city as string}` : 'Hosted',
        city:              (ev.city as string | null) ?? null,
        starts_at:         (ev.starts_at as string | null) ?? null,
        ends_at:           (ev.ends_at as string | null) ?? null,
        people_count:      goingCount,
        user_relationship: 'host',
        primary_action:    { label: 'Manage', type: 'navigate_event' },
        secondary_action:  null,
        reason_labels:     atCapacity ? ['Your event', 'Full'] : ['Your event'],
        expires_at:        (ev.ends_at as string | null) ?? null,
        is_joinable:       !atCapacity,
        // No _urgency override — let urgency() derive from status_label + user_relationship='host'
      });
    }

    const rsvpEventIds = ((rsvpRowsRes.data as any[]) ?? []).map((r: any) => r.event_id as string);
    if (rsvpEventIds.length > 0) {
      const { data: rsvpEvents } = await sc
        .from("events")
        .select("id, title, starts_at, ends_at, city, state, visibility, going_count, max_attendees, host_id")
        .in("id", rsvpEventIds)
        .in("state", ["open", "started"])
        .gt("ends_at", now)
        .neq("host_id", user.id);

      for (const ev of (rsvpEvents as any[]) ?? []) {
        if (blockedSet.has(ev.host_id as string)) continue;
        // Privacy: only public + friends_only are shown for joined events
        if (ev.visibility !== 'public' && ev.visibility !== 'friends_only') continue;
        if (citySlug && (context === 'currentCity' || context === 'savedCity' || context === 'tripCity')) {
          const evCity = ((ev.city as string | null) ?? '').toLowerCase().replace(/\s+/g, '-');
          if (evCity !== citySlug) continue;
        }
        const sl = computeStatusLabel(ev.starts_at, ev.ends_at);
        if (sl === 'My Plan') continue;
        const maxAtt = ev.max_attendees as number | null;
        const goingCount = (ev.going_count as number | null) ?? 0;
        const atCapacity = maxAtt !== null && goingCount >= maxAtt;
        addItem({
          id:                `event:${ev.id as string}`,
          item_type:         'event',
          item_id:           ev.id as string,
          status_label:      sl,
          title:             ev.title as string,
          subtitle:          (ev.city as string | null) ?? null,
          city:              (ev.city as string | null) ?? null,
          starts_at:         (ev.starts_at as string | null) ?? null,
          ends_at:           (ev.ends_at as string | null) ?? null,
          people_count:      goingCount,
          user_relationship: 'joined',
          primary_action:    { label: 'View', type: 'navigate_event' },
          secondary_action:  atCapacity ? null : { label: 'Invite', type: 'share_event' },
          reason_labels:     ["You're going"],
          expires_at:        (ev.ends_at as string | null) ?? null,
          is_joinable:       !atCapacity,
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── 2. Trips — user is a member ────────────────────────────────────────────
  let callerTripIds: string[] = [];
  const tripCityMap = new Map<string, string | null>(); // tripId → destinationCity

  try {
    const { data: memberRows } = await sc
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", user.id)
      .in("role", ["owner", "co_host", "member"]);

    callerTripIds = ((memberRows as any[]) ?? []).map((r: any) => r.trip_id as string);
    const roleMap = new Map<string, string>(((memberRows as any[]) ?? []).map((r: any) => [r.trip_id as string, r.role as string]));

    if (callerTripIds.length > 0) {
      // When context is specificTrip, narrow to that trip only
      const queryTripIds = context === 'specificTrip' && tripId
        ? callerTripIds.filter(id => id === tripId)
        : callerTripIds;

      if (queryTripIds.length > 0) {
        const { data: trips } = await sc
          .from("trips")
          .select("id, title, destination_city, start_date, end_date, status, visibility, owner_id")
          .in("id", queryTripIds)
          .in("status", ["planning", "upcoming", "active"]);

        for (const trip of (trips as any[]) ?? []) {
          const city = (trip.destination_city as string | null) ?? null;
          tripCityMap.set(trip.id as string, city);

          const sl = computeStatusLabel(trip.start_date, trip.end_date);
          // City filter for currentCity / savedCity context
          if (citySlug && (context === 'currentCity' || context === 'savedCity')) {
            const tripCitySlug = (city ?? '').toLowerCase().replace(/\s+/g, '-');
            if (tripCitySlug !== citySlug) continue;
          }
          // tripCity: derive citySlug from active trip destination if not set
          if (context === 'tripCity' && !citySlug && city) {
            citySlug = city.toLowerCase().replace(/\s+/g, '-');
          }

          const role = roleMap.get(trip.id as string) ?? 'member';
          const isHost = role === 'owner' || role === 'co_host';
          addItem({
            id:                `trip:${trip.id as string}`,
            item_type:         'trip',
            item_id:           trip.id as string,
            status_label:      sl,
            title:             trip.title as string,
            subtitle:          city,
            city,
            starts_at:         (trip.start_date as string | null) ?? null,
            ends_at:           (trip.end_date as string | null) ?? null,
            people_count:      null,
            user_relationship: isHost ? 'host' : 'joined',
            primary_action:    { label: 'View Trip', type: 'navigate_trip' },
            secondary_action:  isHost ? { label: 'Invite', type: 'invite_to_trip' } : null,
            reason_labels:     [isHost ? 'Your trip' : 'Trip member'],
            expires_at:        (trip.end_date as string | null) ?? null,
            is_joinable:       false,
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  // ── Location fallback: tripCity had no active trip → try savedCity → myPlans ─
  if (context === 'tripCity' && !citySlug) {
    try {
      const { data: profileRow } = await sc
        .from("profiles")
        .select("home_city")
        .eq("id", user.id)
        .maybeSingle();
      const homeCity = (profileRow as any)?.home_city as string | null;
      if (homeCity) {
        citySlug = homeCity.toLowerCase().replace(/\s+/g, '-');
        fallbackContext = 'savedCity';
        context = 'savedCity';
      } else {
        fallbackContext = 'myPlans';
        context = 'myPlans';
      }
    } catch {
      fallbackContext = 'myPlans';
      context = 'myPlans';
    }
  }

  // ── 3. Circles — active gatherings in user's trips/events ─────────────────
  if (circlesEnabled && callerTripIds.length > 0) {
    try {
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const { data: presences } = await sc
        .from("circle_presence")
        .select("context_id, user_id, updated_at")
        .eq("context_type", "trip")
        .in("context_id", callerTripIds)
        .neq("user_id", user.id)
        .gt("updated_at", fourHoursAgo);

      // Group by context_id (trip) and count unique members
      const tripPresenceCounts = new Map<string, number>();
      for (const p of (presences as any[]) ?? []) {
        if (blockedSet.has(p.user_id as string)) continue;
        const tid = p.context_id as string;
        tripPresenceCounts.set(tid, (tripPresenceCounts.get(tid) ?? 0) + 1);
      }

      for (const [circTripId, memberCount] of tripPresenceCounts) {
        const city = tripCityMap.get(circTripId) ?? null;
        addItem({
          id:                `circle:${circTripId}`,
          item_type:         'circle',
          item_id:           circTripId,
          status_label:      'Ongoing',
          title:             'Circle Active',
          subtitle:          city ?? 'Your trip circle is gathering',
          city,
          starts_at:         null,
          ends_at:           null,
          people_count:      memberCount,
          user_relationship: 'joined',
          primary_action:    { label: 'Open Circle', type: 'navigate_circle' },
          secondary_action:  null,
          reason_labels:     [`${memberCount} member${memberCount !== 1 ? 's' : ''} present`],
          expires_at:        null,
          is_joinable:       false,
          _urgency:          5,
        });
      }
    } catch { /* non-fatal */ }
  }

  // ── 4. Buddy bookings — pending requests (both directions) ─────────────────
  try {
    // Build a set of blocked profile IDs (buddy_bookings.buddy_id is a profile ID, not user ID)
    // blockedSet contains user IDs; we need to map those to profile IDs for the traveler-side check.
    const blockedProfileSet = new Set<string>();
    if (blockedSet.size > 0) {
      try {
        const { data: blockedProfiles } = await sc
          .from("rent_buddy_profiles")
          .select("id")
          .in("user_id", [...blockedSet]);
        for (const bp of (blockedProfiles as any[]) ?? []) {
          blockedProfileSet.add(bp.id as string);
        }
      } catch { /* non-fatal — fail open; user-ID check below is a secondary guard */ }
    }

    const [travelerRes, buddyProfileRes] = await Promise.all([
      sc.from("buddy_bookings")
        .select("id, buddy_id, booking_date, city, status")
        .eq("traveler_id", user.id)
        .eq("status", "requested"),
      // rent_buddy_profiles is the correct table; gate on approved moderation_status
      sc.from("rent_buddy_profiles")
        .select("id")
        .eq("user_id", user.id)
        .in("moderation_status", ["approved", "auto_approved"])
        .maybeSingle(),
    ]);

    for (const bk of (travelerRes.data as any[]) ?? []) {
      // buddy_id is a profile ID; compare against blockedProfileSet (not blockedSet of user IDs)
      if (blockedProfileSet.has(bk.buddy_id as string)) continue;
      if (citySlug && context !== 'myPlans') {
        const bkCity = ((bk.city as string | null) ?? '').toLowerCase().replace(/\s+/g, '-');
        if (bkCity !== citySlug) continue;
      }
      addItem({
        id:                `buddy_request:${bk.id as string}`,
        item_type:         'buddy_request',
        item_id:           bk.id as string,
        status_label:      'Action Needed',
        title:             'Buddy Request Pending',
        subtitle:          (bk.city as string | null) ?? null,
        city:              (bk.city as string | null) ?? null,
        starts_at:         (bk.booking_date as string | null) ?? null,
        ends_at:           null,
        people_count:      null,
        user_relationship: 'pending',
        primary_action:    { label: 'View Request', type: 'navigate_buddy_booking' },
        secondary_action:  { label: 'Cancel', type: 'cancel_buddy_booking' },
        reason_labels:     ['Awaiting response'],
        expires_at:        null,
        is_joinable:       false,
        _urgency:          3,
      });
    }

    // As a buddy — only show if caller has an approved buddy profile
    const buddyProfileRow = buddyProfileRes.data as any;
    if (buddyProfileRow?.id) {
      const { data: incomingBookings } = await sc
        .from("buddy_bookings")
        .select("id, traveler_id, booking_date, city, status")
        .eq("buddy_id", buddyProfileRow.id as string)
        .eq("status", "requested");

      for (const bk of (incomingBookings as any[]) ?? []) {
        if (blockedSet.has(bk.traveler_id as string)) continue;
        addItem({
          id:                `buddy_request:${bk.id as string}`,
          item_type:         'buddy_request',
          item_id:           bk.id as string,
          status_label:      'Action Needed',
          title:             'New Booking Request',
          subtitle:          (bk.city as string | null) ?? null,
          city:              (bk.city as string | null) ?? null,
          starts_at:         (bk.booking_date as string | null) ?? null,
          ends_at:           null,
          people_count:      null,
          user_relationship: 'pending',
          primary_action:    { label: 'Respond', type: 'navigate_buddy_booking' },
          secondary_action:  { label: 'Decline', type: 'decline_buddy_booking' },
          reason_labels:     ['Action needed'],
          expires_at:        null,
          is_joinable:       false,
          _urgency:          3,
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── 5. Hidden Gems — top-rated active gems in the target city ─────────────
  // When context=nearMe with coordinates, apply haversine radius (50 km) instead
  // of city-name filter so gems truly near the user surface first.
  if (hiddenGemsEnabled) {
    const NEAR_ME_RADIUS_KM = 50;
    const haversineKmGems = (la1: number, lo1: number, la2: number, lo2: number): number => {
      const R = 6371;
      const dLat = (la2 - la1) * Math.PI / 180;
      const dLon = (lo2 - lo1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) *
                Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    try {
      let gems: any[] | null = null;
      if (context === 'nearMe' && lat !== undefined && lng !== undefined) {
        // Proximity mode: fetch all active gems with coordinates, filter by radius
        const { data } = await sc
          .from("hidden_gems")
          .select("id, name, city, category, save_count, lat, lng")
          .eq("status", "active")
          .order("save_count", { ascending: false })
          .limit(100);
        gems = ((data as any[]) ?? [])
          .map((g: any) => ({
            ...g,
            _distKm: (g.lat != null && g.lng != null)
              ? haversineKmGems(lat, lng, g.lat as number, g.lng as number)
              : null,
          }))
          .filter((g: any) => g._distKm !== null && (g._distKm as number) <= NEAR_ME_RADIUS_KM)
          .sort((a: any, b: any) => (a._distKm as number) - (b._distKm as number))
          .slice(0, 3);
      } else {
        const gemCity = citySlug?.replace(/-/g, ' ');
        if (gemCity) {
          const { data } = await sc
            .from("hidden_gems")
            .select("id, name, city, category, save_count")
            .eq("status", "active")
            .ilike("city", `%${gemCity}%`)
            .order("save_count", { ascending: false })
            .limit(3);
          gems = (data as any[]) ?? [];
        }
      }

      for (const gem of gems ?? []) {
        const distKm = (gem._distKm as number | null) ?? null;
        addItem({
          id:                `hidden_gem:${gem.id as string}`,
          item_type:         'hidden_gem',
          item_id:           gem.id as string,
          status_label:      'My Plan',
          title:             gem.name as string,
          subtitle:          distKm !== null
            ? `${distKm < 1 ? '<1' : Math.round(distKm)} km away`
            : ((gem.category as string | null) ?? null),
          city:              (gem.city as string | null) ?? null,
          starts_at:         null,
          ends_at:           null,
          people_count:      (gem.save_count as number | null) ?? null,
          user_relationship: 'available',
          primary_action:    { label: 'Explore', type: 'navigate_gem' },
          secondary_action:  { label: 'Save', type: 'save_gem' },
          reason_labels:     distKm !== null ? ['Near You'] : ['Hidden Gem'],
          expires_at:        null,
          is_joinable:       false,
          _urgency:          9,
        });
      }
    } catch { /* non-fatal */ }
  }

  // ── 6. Compass picks — personalised gems from user's preferred cities ──────
  if (hiddenGemsEnabled) {
    try {
      const { data: compassProfile } = await sc
        .from("compass_user_profiles")
        .select("preferred_cities, current_city")
        .eq("user_id", user.id)
        .maybeSingle();

      const profile = compassProfile as any;
      const compassCities: string[] = [];
      if (profile?.current_city) compassCities.push(profile.current_city as string);
      if (Array.isArray(profile?.preferred_cities)) {
        for (const c of profile.preferred_cities as string[]) compassCities.push(c);
      }

      // Deduplicate against already-seen city from context
      const gemCityNorm = (citySlug ?? '').replace(/-/g, ' ').toLowerCase();
      const uniqueCompassCities = compassCities
        .filter(c => c.toLowerCase() !== gemCityNorm)
        .slice(0, 2); // top 2 extra cities only

      for (const compassCity of uniqueCompassCities) {
        const { data: picks } = await sc
          .from("hidden_gems")
          .select("id, name, city, category, save_count")
          .eq("status", "active")
          .ilike("city", `%${compassCity}%`)
          .order("save_count", { ascending: false })
          .limit(2);

        for (const gem of (picks as any[]) ?? []) {
          addItem({
            id:                `compass:${gem.id as string}`,
            item_type:         'compass',
            item_id:           gem.id as string,
            status_label:      'My Plan',
            title:             gem.name as string,
            subtitle:          (gem.city as string | null) ?? null,
            city:              (gem.city as string | null) ?? null,
            starts_at:         null,
            ends_at:           null,
            people_count:      (gem.save_count as number | null) ?? null,
            user_relationship: 'available',
            primary_action:    { label: 'Explore', type: 'navigate_gem' },
            secondary_action:  { label: 'Save', type: 'save_gem' },
            reason_labels:     ['Compass Pick'],
            expires_at:        null,
            is_joinable:       false,
            _urgency:          9,
          });
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── 7. Available buddies — discovery cards for approved buddies in city ─────
  // Only shown when a city is in scope; excludes the caller and blocked users.
  try {
    const buddyCitySlug = citySlug;
    if (buddyCitySlug) {
      const buddyCity = buddyCitySlug.replace(/-/g, ' ');
      const { data: availableBuddies } = await sc
        .from("rent_buddy_profiles")
        .select("id, user_id, city, bio")
        .in("moderation_status", ["approved", "auto_approved"])
        .ilike("city", `%${buddyCity}%`)
        .neq("user_id", user.id)
        .limit(3);

      for (const bp of (availableBuddies as any[]) ?? []) {
        if (blockedSet.has(bp.user_id as string)) continue;
        addItem({
          id:                `available_buddy:${bp.id as string}`,
          item_type:         'available_buddy',
          item_id:           bp.id as string,
          status_label:      'My Plan',
          title:             'Buddy Available',
          subtitle:          (bp.city as string | null) ?? null,
          city:              (bp.city as string | null) ?? null,
          starts_at:         null,
          ends_at:           null,
          people_count:      null,
          user_relationship: 'available',
          primary_action:    { label: 'View Profile', type: 'navigate_buddy_profile' },
          // 'request_buddy' navigates to /(rent-a-buddy)/request-buddy?buddyId=<profile-id>
          // (not navigate_buddy_booking which expects an existing booking ID)
          secondary_action:  { label: 'Request', type: 'request_buddy' },
          reason_labels:     ['Available in your city'],
          expires_at:        null,
          is_joinable:       true,
          _urgency:          8,
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── 8. Saved events — user's bookmarked upcoming events ──────────────────
  // Shows events the user saved (event_saves) that are not already in the rail
  // via RSVP. Provides discovery context for plans the user wants to attend.
  try {
    const { data: saveRows } = await sc
      .from("event_saves")
      .select("event_id")
      .eq("user_id", user.id);

    const savedEventIds = ((saveRows as any[]) ?? []).map((r: any) => r.event_id as string);
    // Skip IDs already in the deduplicated items set
    const alreadyAdded = new Set(items.map((i) => i.id));
    const newSavedIds = savedEventIds.filter((id: string) => !alreadyAdded.has(`event:${id}`));

    if (newSavedIds.length > 0) {
      const { data: savedEvents } = await sc
        .from("events")
        .select("id, title, starts_at, ends_at, city, state, visibility, going_count, max_attendees, host_id")
        .in("id", newSavedIds)
        .in("state", ["open", "started"])
        .gt("ends_at", now)
        .in("visibility", ["public", "friends_only"]);

      for (const ev of (savedEvents as any[]) ?? []) {
        if (blockedSet.has(ev.host_id as string)) continue;
        if (citySlug && (context === 'currentCity' || context === 'savedCity' || context === 'tripCity')) {
          const evCity = ((ev.city as string | null) ?? '').toLowerCase().replace(/\s+/g, '-');
          if (evCity !== citySlug) continue;
        }
        const sl = computeStatusLabel(ev.starts_at, ev.ends_at);
        if (sl === 'My Plan') continue;
        const maxAtt = ev.max_attendees as number | null;
        const goingCount = (ev.going_count as number | null) ?? 0;
        const atCapacity = maxAtt !== null && goingCount >= maxAtt;
        addItem({
          id:                `event:${ev.id as string}`,
          item_type:         'event',
          item_id:           ev.id as string,
          status_label:      sl,
          title:             ev.title as string,
          subtitle:          (ev.city as string | null) ?? null,
          city:              (ev.city as string | null) ?? null,
          starts_at:         (ev.starts_at as string | null) ?? null,
          ends_at:           (ev.ends_at as string | null) ?? null,
          people_count:      goingCount,
          user_relationship: 'saved',
          primary_action:    { label: 'View', type: 'navigate_event' },
          secondary_action:  { label: 'RSVP Going', type: 'rsvp_event_going' },
          reason_labels:     atCapacity ? ['Saved', 'Full'] : ['Saved'],
          expires_at:        (ev.ends_at as string | null) ?? null,
          is_joinable:       !atCapacity,
          // No _urgency override — let urgency() derive from status_label + user_relationship='saved'
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── 9. Trip join requests — pending requests to join host's trips ─────────
  // Surfaces Action Needed items for trips the user owns with pending requests.
  try {
    const { data: ownedTrips } = await sc
      .from("trips")
      .select("id, destination_city")
      .eq("owner_id", user.id);

    const ownedTripIds = ((ownedTrips as any[]) ?? []).map((t: any) => t.id as string);
    if (ownedTripIds.length > 0) {
      const { data: pendingRequests } = await sc
        .from("trip_join_requests")
        .select("id, trip_id, user_id, created_at")
        .in("trip_id", ownedTripIds)
        .eq("status", "pending");

      // Group by trip_id — one rail item per trip with pending count
      const byTrip = new Map<string, { count: number; dest: string | null; earliest: string }>();
      for (const req of (pendingRequests as any[]) ?? []) {
        if (blockedSet.has(req.user_id as string)) continue;
        const tid = req.trip_id as string;
        const dest = ((ownedTrips as any[]) ?? []).find((t: any) => t.id === tid)?.destination_city as string | null ?? null;
        const existing = byTrip.get(tid);
        const ts = req.created_at as string;
        if (!existing) {
          byTrip.set(tid, { count: 1, dest, earliest: ts });
        } else {
          existing.count += 1;
          if (ts < existing.earliest) existing.earliest = ts;
        }
      }

      for (const [tripId, { count, dest, earliest }] of byTrip) {
        addItem({
          id:                `trip_request:${tripId}`,
          item_type:         'trip_request',
          item_id:           tripId,
          status_label:      'Action Needed',
          title:             dest ? `Join request for ${dest}` : 'Trip join request',
          subtitle:          count === 1 ? '1 request pending' : `${count} requests pending`,
          city:              dest ?? null,
          starts_at:         earliest,
          ends_at:           null,
          people_count:      count,
          user_relationship: 'pending',
          primary_action:    { label: 'Review', type: 'navigate_trip' },
          secondary_action:  null,
          reason_labels:     ['Action Needed'],
          expires_at:        null,
          is_joinable:       false,
          _urgency:          3,
        });
      }
    }
  } catch { /* non-fatal */ }

  // ── Sort by urgency, then by starts_at ascending ───────────────────────────
  items.sort((a, b) => {
    const ua = urgency(a);
    const ub = urgency(b);
    if (ua !== ub) return ua - ub;
    const aStart = a.starts_at ? new Date(a.starts_at).getTime() : Infinity;
    const bStart = b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
    return aStart - bStart;
  });

  const responseItems: LivePulseItem[] = items.map(({ _urgency: _u, ...rest }) => rest);

  res.json({ items: responseItems, fallbackContext: fallbackContext ?? null });
});

export default router;
