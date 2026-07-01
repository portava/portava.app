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
    .select(`${POST_SAFE_COLUMNS}, pulse_geo_tags(${GEO_TAG_COLUMNS}), profiles!author_id(id, username, full_name, avatar_url)`)
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
      // Rich-text span whitelists
      spanTags:         spans.tags,
      spanHashtags:     spans.hashtagUsages,
    };
  });

  // When COMPASS_ENABLED, apply Compass intent-mode ordering to the Pulse feed.
  // Safety Mode: verified-location posts surface first (explicit city+venue labels).
  // Night Mode: filter to last 8 hours of posts (peak night content), fallback to full.
  let orderedPosts = posts;
  // Prompt cards (e.g. safe-return) are returned separately so the `posts`
  // shape stays homogeneous and existing clients are unaffected.
  let prompts: Array<{ type: string; id: string; title: string; body: string; action: string }> = [];
  try {
    const compassEnabled = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "COMPASS_ENABLED")
      .maybeSingle();
    if ((compassEnabled.data as any)?.enabled) {
      const compassProfile = await getCompassProfile(sc, user.id);
      const compassContext = buildCompassContext(compassProfile, defaultSignals(compassProfile));
      const intentMode     = deriveIntentMode(compassContext);
      const primaryMode    = intentMode.primary;

      if (compassContext.contextState === "safety_mode" || primaryMode === "safety_mode") {
        // Safety Mode: surface safe-return prompt cards in a dedicated `prompts`
        // field so existing clients consuming the `posts` array are unaffected.
        // The prompt is typed separately; clients that understand it display it
        // above the post list. Posts with location context come before those without.
        prompts = [
          {
            type:   "safe_return_prompt",
            id:     `safe_return_prompt_${Date.now()}`,
            title:  "Are you safe?",
            body:   "Let your travel crew know you've arrived safely.",
            action: "safe_return",
          },
        ];
        // After prompts: location-rich posts first (actionable context)
        const withLocation    = posts.filter((p: any) => p.venueName || (p.locationCity && p.locationCountry));
        const withoutLocation = posts.filter((p: any) => !(p.venueName || (p.locationCity && p.locationCountry)));
        orderedPosts = [...withLocation, ...withoutLocation];
      } else if (compassContext.contextState === "night_mode" || primaryMode === "night_mode") {
        // Night Mode: filter to last 8 hours — fresh night content only
        const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1_000).toISOString();
        const recent = posts.filter((p: any) => p.createdAt >= cutoff);
        orderedPosts  = recent.length >= 3 ? recent : posts; // graceful fallback
      }
      // All other modes: default recency order (already sorted created_at DESC)
    }
  } catch { /* Compass enrichment is non-fatal — return unmodified posts */ }

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

      placeCards = ((nearbyPlaces ?? []) as any[]).map((p: any) => ({
        type: "place_card",
        id: `place_card_${p.id as string}`,
        placeId: p.id as string,
        name: p.name as string,
        city: (p.city ?? cityParam) as string,
        category: (p.category ?? p.place_type ?? null) as string | null,
        blurb: (p.blurb ?? null) as string | null,
        imageUrl: (p.image_url ?? null) as string | null,
        rating: p.rating != null ? parseFloat(String(p.rating)) : null,
        lat: p.lat != null ? parseFloat(String(p.lat)) : null,
        lng: p.lng != null ? parseFloat(String(p.lng)) : null,
        neighborhood: (p.neighborhood ?? null) as string | null,
      }));
    }
  } catch { /* non-fatal — place cards degrade gracefully */ }

  res.json({ posts: orderedPosts, total: orderedPosts.length, tab, prompts, placeCards });
});

export default router;
