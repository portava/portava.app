import { enrichSpans } from '../lib/enrichSpans';
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

export default router;
