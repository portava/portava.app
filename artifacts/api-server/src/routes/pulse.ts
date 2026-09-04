import { randomUUID } from 'node:crypto';
import { enrichSpans } from '../lib/enrichSpans';
import { rankCandidates } from '../lib/portavaRank';
import { logImpression, logLivePulseServe } from '../lib/rankLog';
import { isFlagEnabled } from '../lib/featureFlags';
import {
  enforceCreatorCapsGeneric,
  emitCreatorCapAnalytics,
} from '../services/ranking/CreatorCapEnforcer.js';
import { getCreatorCaps } from '../services/ranking/rankingConfig.js';
import { buildPlaceAffinities } from '../services/ranking/MediaFeedRankingService.js';
import { getCompassProfile } from "../compass/CompassProfileService";
import { rankItems as drsRankItems } from '../services/ranking/DiscoveryRankingService.js';
import type { RankingInput, RankingViewerContext } from '../services/ranking/DiscoveryRankingService.js';
import { emitFeedSlotAnalytics } from '../services/ranking/FeedSlotAllocator.js';
import { buildCompassContext, defaultSignals } from "../compass/CompassContextEngine";
import { deriveIntentMode } from "../compass/CompassIntentModeEngine";
import { fetchUserTimezone, localHourFor, nowUtcInstant } from "../lib/localTime";
import { excludePrivateAuthorPosts } from '../lib/privacyFilter';
import { resolveMediaForPosts } from "../lib/postMediaResolve.js";

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
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity";
import { getServiceClient } from "../lib/supabase";
import { stampOverlayCol } from "../lib/postMediaOverlay";

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
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at, " +
  "location_name, location_city, location_country, location_source, canonical_place_id";

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
      stamp_overlay:     m.stamp_overlay ?? null,
    }));
}

/* ---------------------------------------------------------------------------
 * GET /api/pulse
 * -------------------------------------------------------------------------*/
router.get("/pulse", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const sessionId = randomUUID();

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
      .from("user_follows")
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
    .select(`${POST_SAFE_COLUMNS}, post_media(${POST_MEDIA_COLUMNS}${await stampOverlayCol(sc)}), pulse_geo_tags(${GEO_TAG_COLUMNS}), profiles!author_id(id, username, display_name, name, full_name, avatar_url, verified, is_official)`)
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
  // Fail-closed: if block state cannot be determined, return an empty feed
  // rather than risk surfacing content from blocked users. blockedSet is hoisted
  // to outer scope so the expanded candidate pool (events, plans, buddies fetched
  // later) can apply the same filter.
  let blockFetchFailed = false;
  const blockedSet = new Set<string>();
  try {
    const [blockedRes, blockerRes] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
      sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
    ]);
    if (blockedRes.error || blockerRes.error) {
      blockFetchFailed = true;
    } else {
      for (const row of (blockedRes.data as any[]) ?? []) blockedSet.add(row.blocked_id as string);
      for (const row of (blockerRes.data as any[]) ?? []) blockedSet.add(row.blocker_id as string);
    }
  } catch {
    blockFetchFailed = true;
  }

  if (blockFetchFailed) {
    req.log.warn({ userId: user.id }, "pulse: block-state unknown — returning empty feed (fail-closed)");
    res.json({ posts: [], total: 0, tab });
    return;
  }

  if (blockedSet.size > 0) {
    rows = rows.filter((row) => !blockedSet.has(row.author_id as string));
  }

  // Private-account guard: exclude posts from private accounts the viewer
  // doesn't follow. Must run after the block filter.
  rows = await excludePrivateAuthorPosts(rows, user.id, sc);

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

  // Batch-fetch featured-by-Portava status so the badge renders without a
  // per-post query.  Non-fatal: if portava_featured is unreachable every post
  // gets null (badge hidden) — feed is still fully functional.
  const featuredPulseMap = new Map<string, string>();
  if (postIds.length > 0) {
    try {
      const { data: featuredRows } = await sc
        .from("portava_featured")
        .select("post_id, category")
        .eq("status", "live")
        .in("post_id", postIds);
      for (const r of (featuredRows as any[]) ?? []) {
        featuredPulseMap.set(r.post_id as string, r.category as string);
      }
    } catch { /* non-fatal: featured badge omitted */ }
  }

  // Universal display-name rule: authors show @handle unless they opted in.
  const allowedAuthorNames = await nameVisibilitySet(sc, rows.map((r: any) => r.author_id));

  // post_media is canonical for storage-backed media; posts.media_urls holds
  // external references only (ruled 2026-08-12). One query per page, then a
  // pure merge — see lib/postMediaResolve.ts.
  const mediaByPost = await resolveMediaForPosts(sc, rows as any[]);

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
      mediaUrls:   mediaByPost.get(row.id) ?? row.media_urls ?? [],
      visibility:  row.visibility,
      createdAt:   row.created_at,
      updatedAt:   row.updated_at ?? undefined,
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
        name:      (row.author_id === user.id || allowedAuthorNames.has(row.author_id as string))
          ? (presentedName(profile, true) ?? profile.username)
          : profile.username,
        avatarUrl:  profile.avatar_url ?? null,
        verified:   (profile.verified as boolean) ?? false,
        isOfficial: (profile.is_official as boolean) ?? false,
      } : null,
      // Structured media items (photo + video); legacy mediaUrls preserved for backward compat
      media: filterPublicMedia(row.post_media),
      // Rich-text span whitelists
      spanTags:         spans.tags,
      spanHashtags:     spans.hashtagUsages,
      // Bookmark state for the authenticated viewer
      savedByMe: savedSet.has(row.id as string),
      // Featured-by-Portava badge category — null when post has not been featured
      featuredByPortava: featuredPulseMap.get(row.id as string) ?? null,
      // Canonical place ID — used by the place-affinity boost in scoreCandidate
      // (placeId on the ranking candidate); carried from DB via POST_SAFE_COLUMNS.
      canonical_place_id: (row.canonical_place_id as string | null) ?? null,
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
  let rankedCandidates: Array<{ kind: string; item: unknown }> = [];
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
      const localHour = localHourFor(nowUtcInstant(), null, await fetchUserTimezone(sc, user.id));
      const compassContext = buildCompassContext(compassProfile, defaultSignals(compassProfile, localHour));
      const intentMode     = deriveIntentMode(compassContext);
      const primaryMode    = intentMode.primary;

      // Load viewer's followed user IDs (for recency boost)
      let followedIds = new Set<string>();
      try {
        const { data: followRows } = await sc
          .from("user_follows")
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

      // ── Fetch events, plans, and buddy candidates for the ranking pool ──────
      const nowMs = Date.now();
      const in24hIso = new Date(nowMs + 24 * 60 * 60 * 1_000).toISOString();
      const nowIso = new Date(nowMs).toISOString();

      // ── Parallel candidate fetches (events + plans + buddies) ───────────────
      // Queries are built first (with optional city scoping) then raced with
      // Promise.allSettled so a rejected source drops only its own results —
      // post candidates and the overall feed are never affected.

      // Events: state=open, starts within 24 h, public.
      let evQ = sc
        .from("events")
        .select("id, host_id, title, category, starts_at, city, max_attendees, going_count, tags")
        .eq("state", "open")
        .eq("visibility", "public")
        .gte("starts_at", nowIso)
        .lte("starts_at", in24hIso)
        .limit(20);
      if (viewerCity) evQ = evQ.ilike("city", `%${viewerCity}%`);

      // Plans: trips with open join slots starting today or tomorrow.
      // show_in_discovery must be true — owners who opted out of discovery
      // should not surface in this ranking pool for other users.
      const tomorrowEnd = new Date(nowMs + 48 * 60 * 60 * 1_000).toISOString().slice(0, 10);
      const todayStart = nowIso.slice(0, 10);
      let planQ = sc
        .from("trips")
        .select("id, owner_id, title, destination_city, start_date, visibility, max_members, trip_members(count)")
        .in("status", ["planning", "upcoming"])
        .gte("start_date", todayStart)
        .lte("start_date", tomorrowEnd)
        .eq("visibility", "public")
        .eq("show_in_discovery", true)
        .limit(20);
      if (viewerCity) planQ = planQ.ilike("destination_city", `%${viewerCity}%`);

      // Buddies: approved, city-scoped, excluding viewer.
      let bQ = sc
        .from("rent_buddy_profiles")
        // trust_score lives on rent_buddy_profiles as trust_score_override
        // (profiles.trust_score is the base score; the override wins for buddies).
        // Approved buddies are gated by admin_status = 'active'.
        .select("id, user_id, city, trust_score_override")
        .eq("admin_status", "active")
        .neq("user_id", user.id)
        .limit(10);
      if (viewerCity) bQ = bQ.ilike("city", `%${viewerCity}%`);

      // Race all three — a rejected promise contributes an empty array.
      const [evResult, planResult, buddyResult] = await Promise.allSettled([evQ, planQ, bQ]);

      const rawEvents: any[] = [];
      if (evResult.status === "fulfilled") {
        for (const ev of ((evResult.value as any).data as any[]) ?? []) {
          if (blockedSet.size > 0 && blockedSet.has(ev.host_id as string)) continue;
          rawEvents.push(ev);
        }
      }

      const rawPlans: any[] = [];
      if (planResult.status === "fulfilled") {
        for (const plan of ((planResult.value as any).data as any[]) ?? []) {
          if (blockedSet.size > 0 && blockedSet.has(plan.owner_id as string)) continue;
          // member_count is not a trips column — derive it from the embedded
          // trip_members aggregate (select "trip_members(count)").
          const memberCount = ((plan.trip_members as any[])?.[0]?.count as number | null) ?? 0;
          plan.member_count = memberCount;
          const maxMembers = plan.max_members as number | null;
          if (maxMembers === null || memberCount < maxMembers) rawPlans.push(plan);
        }
      }

      const rawBuddies: any[] = [];
      if (buddyResult.status === "fulfilled") {
        for (const b of ((buddyResult.value as any).data as any[]) ?? []) {
          if (blockedSet.size > 0 && blockedSet.has(b.user_id as string)) continue;
          rawBuddies.push(b);
        }
      }

      // Batch-fetch author trust scores for posts + event hosts
      const authorIdsForTrust = new Set<string>();
      for (const p of posts) {
        if ((p as any).authorId) authorIdsForTrust.add((p as any).authorId as string);
      }
      for (const ev of rawEvents) {
        if (ev.host_id) authorIdsForTrust.add(ev.host_id as string);
      }
      const trustMap = new Map<string, number>();
      if (authorIdsForTrust.size > 0) {
        try {
          // Trust scores live in trust_profiles.overall_score (0043_trust_engine.sql);
          // there is no user_trust_scores table. NUMERIC comes back as a string,
          // so coerce to number.
          const { data: trustRows } = await sc
            .from("trust_profiles")
            .select("user_id, overall_score")
            .in("user_id", [...authorIdsForTrust]);
          for (const r of (trustRows as any[]) ?? []) {
            const score = Number(r.overall_score);
            if (Number.isFinite(score)) trustMap.set(r.user_id as string, score);
          }
        } catch { /* non-fatal — trust scores contribute 0 when absent */ }
      }

      // ── Official-publisher boost setup ───────────────────────────────────
      // Resolve the @portava account ID and the feature flag once here so the
      // candidate mapper and cap enforcer can both use them without extra queries.
      let publisherBoostEnabled = false;
      let portavaAuthorId: string | null = null;
      try {
        const [flagVal, portavaRow] = await Promise.all([
          isFlagEnabled(sc, "PORTAVA_PUBLISHER_BOOST_ENABLED"),
          sc.from("profiles").select("id").eq("username", "portava").maybeSingle(),
        ]);
        publisherBoostEnabled = flagVal;
        portavaAuthorId = (portavaRow.data as any)?.id ?? null;
      } catch { /* non-fatal — no boost applied when lookup fails */ }

      // ── Unified ranking (portavaRank — spec §42) ─────────────────────────
      // The previous inline scorer (linear recency + follow/hashtag/city
      // boosts) is preserved as features inside the shared scoring core,
      // which adds exponential recency, author-repetition diversity, and
      // deterministic exploration slots so new voices surface. Pulse,
      // Discover, Compass, and Events all rank through this one module.
      //
      // Candidates: posts + events + plans + buddies — all ranked together.
      const postCandidates = posts.map((p: any) => ({
        id: p.id as string,
        kind: "post" as const,
        createdAt: p.createdAt as string | null,
        city: (p.locationCity as string | null) ?? null,
        neighborhood: (p.locationName as string | null) ?? null,
        authorId: (p.authorId as string | null) ?? null,
        authorTrustScore: trustMap.get(p.authorId as string) ?? null,
        // Official-publisher signal: true when the post is from @Portava and the
        // publisher boost feature flag is on.
        isOfficialPublisher: publisherBoostEnabled && portavaAuthorId !== null
          ? (p.authorId as string | null) === portavaAuthorId
          : null,
        tags: Array.isArray(p.spanHashtags)
          ? (p.spanHashtags as Array<{ slug?: string }>)
              .map((h) => (h.slug ?? "").toLowerCase())
              .filter(Boolean)
          : [],
        // placeId drives the ×1.15 place-affinity boost in portavaRank.scoreCandidate.
        // canonical_place_id is now included in POST_SAFE_COLUMNS.
        placeId: (p.canonical_place_id as string | null) ?? null,
        __post: p,
      }));

      const eventCandidates = rawEvents.map((ev: any) => ({
        id: ev.id as string,
        kind: "event" as const,
        startsAt: (ev.starts_at as string | null) ?? null,
        city: ev.city ? (ev.city as string).toLowerCase() : null,
        authorId: (ev.host_id as string | null) ?? null,
        authorTrustScore: trustMap.get(ev.host_id as string) ?? null,
        hasCapacity: ev.max_attendees == null || (ev.going_count ?? 0) < ev.max_attendees,
        category: (ev.category as string | null) ?? null,
        tags: Array.isArray(ev.tags)
          ? (ev.tags as string[]).map((t) => t.toLowerCase())
          : [],
        __event: {
          id: ev.id,
          title: ev.title,
          category: ev.category,
          startsAt: ev.starts_at,
          city: ev.city,
          hasCapacity: ev.max_attendees == null || (ev.going_count ?? 0) < ev.max_attendees,
          goingCount: ev.going_count ?? 0,
          maxAttendees: ev.max_attendees ?? null,
        },
      }));

      const planCandidates = rawPlans.map((plan: any) => ({
        id: plan.id as string,
        kind: "plan" as const,
        startsAt: plan.start_date ? `${plan.start_date as string}T00:00:00Z` : null,
        city: plan.destination_city ? (plan.destination_city as string).toLowerCase() : null,
        authorId: (plan.owner_id as string | null) ?? null,
        hasCapacity: true, // only open-slot trips enter
        __plan: {
          id: plan.id,
          title: plan.title,
          city: plan.destination_city,
          startDate: plan.start_date,
          memberCount: plan.member_count ?? 0,
          maxMembers: plan.max_members ?? null,
        },
      }));

      const buddyCandidates = rawBuddies.map((b: any) => ({
        id: b.user_id as string,
        kind: "buddy" as const,
        authorId: (b.user_id as string | null) ?? null,
        authorTrustScore: b.trust_score_override != null ? (b.trust_score_override as number) : null,
        city: b.city ? (b.city as string).toLowerCase() : null,
        __buddy: {
          id: b.id,
          userId: b.user_id,
          city: b.city,
        },
      }));

      const allCandidates = [
        ...postCandidates,
        ...eventCandidates,
        ...planCandidates,
        ...buddyCandidates,
      ];

      // Build place-affinity map from the viewer's recent place_view events so
      // scoreCandidate can apply the ×1.15 boost for familiar destinations.
      // Fire-and-forget pattern: non-fatal, falls back to no boost on error.
      const placeAffinities = await buildPlaceAffinities(sc, user.id, nowMs);

      let ranked = rankCandidates(
        allCandidates,
        {
          userId: user.id,
          city: viewerCity,
          followedIds,
          interestTags,
          placeAffinities,
        },
        { publisherBoost: publisherBoostEnabled },
      );
      void logImpression(ranked, user.id, "pulse", sessionId);

      // ── DiscoveryRankingService re-ranking pass ────────────────────────────
      // Wraps (does not replace) portavaRank: applies activity boosts, new-
      // contributor boost, fatigue penalties, and underexposure signals on top
      // of the existing score.  In shadow mode (ACTIVITY_DISCOVERY_BOOST_ENABLED
      // = false), DRS computes scores for offline evaluation but preserves the
      // existing portavaRank order so no user-visible change occurs.
      try {
        const drsInputs: RankingInput[] = ranked.map((sc) => {
          const c = sc.candidate as any;
          return {
            itemId:          (c.id ?? "") as string,
            itemType:        (c.kind ?? "post") as string,
            creatorId:       (c.authorId ?? null) as string | null,
            createdAt:       (c.createdAt ?? null) as string | null,
            city:            (c.city ?? null) as string | null,
            country:         null,
            tags:            Array.isArray(c.tags) ? (c.tags as string[]) : [],
            category:        (c.category ?? null) as string | null,
            languageCode:    null,
            hasMedia:        c.kind === "post",
            completeness:    0.7,
            positiveReviewRate: null,
            flagCount:       0,
            saveCount:       0,
            shareCount:      0,
            commentCount:    0,
            impressionCount: 1,
            uniqueViewerCount: 1,
            lat: null, lng: null,
            distanceKm:      (c.distanceKm ?? null) as number | null,
            isDeleted: false, isExpired: false, isSuspended: false,
            isModerated: false, isPrivate: false,
            isAgeRestricted: false, minAgeRequired: null,
            isGeoRestricted: false, geoRestrictionCountries: null,
            authorIsBlockedByViewer: blockedSet.has((c.authorId ?? "") as string),
            authorBlocksViewer: false,
            authorIsMutedByViewer: false,
            viewerHasReportedItem: false,
            viewerHasHiddenItem: false,
            viewerHasHiddenCreator: false,
            repeatCount: null, expiresAt: null, accountAgeDays: null,
            isUnfamiliarCategory: false, isFirstImpression: false,
          };
        });
        const drsViewer: RankingViewerContext = {
          viewerId:          user.id,
          travelStyles:      [...interestTags],
          preferredLanguages: [],
          preferredCities:   viewerCity ? [viewerCity] : [],
          currentCity:       viewerCity || null,
          currentCountry:    null,
          lat: null, lng: null, viewerAge: null,
          followedCreatorIds: followedIds,
          mutedCreatorIds:   new Set(),
          blockedCreatorIds: blockedSet,
          seenItemIds:       new Set(),
          sessionId,
          lastActiveAt:      null,
        };
        const drsResults = await drsRankItems(drsInputs, "pulse", drsViewer, sc);
        // Re-order `ranked` according to DRS output position.
        // Shadow mode: DRS preserves input order → no change.
        // Active mode: DRS sorts by finalScore → new ordering applied.
        if (drsResults.length > 0) {
          const drsOrder = new Map(drsResults.map((r, idx) => [r.itemId, idx]));
          ranked.sort((a, b) => {
            const aIdx = drsOrder.get((a.candidate as any).id as string) ?? ranked.length;
            const bIdx = drsOrder.get((b.candidate as any).id as string) ?? ranked.length;
            return aIdx - bIdx;
          });
        }

        // ── Assembly-phase analytics (fire-and-forget) ───────────────────────
        // Emits rank_events rows for diversity analytics; never affects feed order.
        try {
          const eligibleDrs  = drsResults.filter((r) => r.eligibilityPassed);
          const itemTypeMap  = new Map(drsInputs.map((i) => [i.itemId, i.itemType]));
          const creatorIdMap = new Map(drsInputs.map((i) => [i.itemId, i.creatorId]));
          const capEnforced  = emitCreatorCapAnalytics(
            eligibleDrs, itemTypeMap, creatorIdMap, "pulse", user.id, sessionId, sc,
          );
          emitFeedSlotAnalytics(capEnforced, drsInputs, "pulse", user.id, sessionId, sc);
        } catch { /* non-fatal — analytics must never affect the feed response */ }

        // ── Creator-frequency caps (DISCOVERY_DIVERSITY_ENABLED) ─────────────
        // Applied after DRS reordering so no single followed creator can flood
        // the top of the feed. For the crew (following) tab this is the ONLY
        // diversity control applied — no slot allocation.
        const diversityOn = await isFlagEnabled(sc, "DISCOVERY_DIVERSITY_ENABLED").catch(() => false);
        if (diversityOn && ranked.length > 0) {
          const caps = await getCreatorCaps(sc).catch(() => ({ maxPerPage: 3, maxConsecutive: 2 }));
          // Official-publisher items are exempt from per-creator frequency caps
          // when the publisher boost is enabled — @Portava posts are never
          // fully suppressed by the diversity limiter.
          ranked = enforceCreatorCapsGeneric(
            ranked,
            (x) => ((x.candidate as any).authorId as string | null | undefined) ?? null,
            caps,
            publisherBoostEnabled
              ? (x) => (x.candidate as any).isOfficialPublisher === true
              : undefined,
          );
        }
      } catch { /* non-fatal — portavaRank order is preserved on any DRS error */ }

      // ── Extract results preserving backward compatibility ──────────────
      // `posts` stays post-only so existing mobile pagination/cursors work.
      // `rankedCandidates` is a new field carrying all kinds with discriminators
      // for clients that support the expanded feed.
      orderedPosts = ranked
        .filter((x) => !!(x.candidate as any).__post)
        .map((x) => (x.candidate as any).__post);

      rankedCandidates = ranked
        .map((x) => {
          const c = x.candidate as any;
          if (c.__post)   return { kind: 'post'  as const, item: c.__post };
          if (c.__event)  return { kind: 'event' as const, item: c.__event };
          if (c.__plan)   return { kind: 'plan'  as const, item: c.__plan };
          if (c.__buddy)  return { kind: 'buddy' as const, item: c.__buddy };
          return null;
        })
        .filter(Boolean) as Array<{ kind: string; item: unknown }>;

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

  // perf-trim: rankedCandidates stripped — not rendered by any client component; internal ranking state only
  res.json({ posts: orderedPosts, total: orderedPosts.length, tab, prompts, placeCards, sessionId });
});

/* ---------------------------------------------------------------------------
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
 * -------------------------------------------------------------------------*/

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

  const todayEnd = new Date(now);
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
  // Minted here — same position and same name as GET /pulse — so that every
  // serve row written below carries it and the client can echo it back on
  // POST /rank-events/outcome, narrowing the attribution lookup in
  // routes/rankEvents.ts (user_id + item_id + surface + outcome='impression',
  // most recent served_at wins) to one specific response.
  //
  // This is precision, NOT the mechanism that keeps Live Pulse outcomes off
  // ranked impressions: that lookup only applies .eq("session_id") when the
  // client actually sends one, so a null would skip it entirely.  What makes
  // the two streams non-colliding is that these rows are written on
  // surface='live_pulse' — a separate key space from the ranked writer's
  // 'pulse'.  See logLivePulseServe in lib/rankLog.
  const sessionId = randomUUID();

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
    // "No blocks" and "the blocks query was rejected" both leave blockedSet
    // empty, and every rail below (events, plans, buddies, bookings, requests)
    // filters on it — so a schema/query error silently surfaces blocked users
    // across the whole Live rail. The feed endpoint at the top of this file
    // treats the same unknown as fail-closed; this one stays best-effort by
    // design, but the failure must at least be visible. PostgREST returns such
    // errors in `error`, so the catch never sees them.
    if (outRes.error || inRes.error) {
      req.log?.warn(
        {
          userId: user.id,
          outCode: (outRes.error as any)?.code,
          inCode: (inRes.error as any)?.code,
          err: outRes.error ?? inRes.error,
        },
        "pulse/live: block-state read failed — blocked users are NOT being filtered from this response",
      );
    }
    for (const r of (outRes.data as any[]) ?? []) blockedSet.add(r.blocked_id as string);
    for (const r of (inRes.data as any[]) ?? []) blockedSet.add(r.blocker_id as string);
  } catch (err) {
    req.log?.warn(
      { err, userId: user.id },
      "pulse/live: block-state read rejected — blocked users are NOT being filtered from this response",
    );
  }

  // Internal-only fields, stripped before the response is serialised:
  //   _urgency     — sort key (see urgency()).
  //   _rankItemId  — the id this item's entity is known by in rank_events, when
  //                  that differs from the client-facing `item_id`.  The rail's
  //                  `item_id` is whatever the app needs to navigate; the ranked
  //                  writer may key the same entity differently.  Live Pulse
  //                  rows land on their own surface ('live_pulse'), so a
  //                  mismatch no longer collides with ranked rows — but one
  //                  entity must still have ONE id across surfaces or every
  //                  per-entity rollup and cross-surface comparison misses.
  //                  Only available_buddy needs this today (rail id =
  //                  rent_buddy_profiles.id, ranker id = the buddy's user_id).
  const items: (LivePulseItem & { _urgency?: number; _rankItemId?: string })[] = [];
  const seen = new Set<string>();

  function addItem(item: LivePulseItem & { _urgency?: number; _rankItemId?: string }) {
    const key = `${item.item_type}:${item.item_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

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
          ? Math.ceil((new Date(session.timer_end_at as string).getTime() - nowMs) / 60_000)
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
      const fourHoursAgo = new Date(nowMs - 4 * 60 * 60 * 1000).toISOString();
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
        const { data: blockedProfiles, error: blockedProfilesErr } = await sc
          .from("rent_buddy_profiles")
          .select("id")
          .in("user_id", [...blockedSet]);
        // A rejected query is indistinguishable from "none of the blocked users
        // has a buddy profile", and this set is the ONLY block filter on the
        // buddy side of the booking rail (the secondary guard below covers the
        // traveler side only). Fail-open stays, but not silently.
        if (blockedProfilesErr) {
          req.log?.warn(
            {
              userId: user.id,
              code: (blockedProfilesErr as any)?.code,
              err: blockedProfilesErr,
            },
            "pulse/live: blocked-user → buddy-profile mapping failed — buddy-side block filter is OFF for this response",
          );
        }
        for (const bp of (blockedProfiles as any[]) ?? []) {
          blockedProfileSet.add(bp.id as string);
        }
      } catch (err) {
        req.log?.warn(
          { err, userId: user.id },
          "pulse/live: blocked-user → buddy-profile mapping rejected — buddy-side block filter is OFF for this response",
        );
      }
    }

    const [travelerRes, buddyProfileRes] = await Promise.all([
      sc.from("buddy_bookings")
        .select("id, buddy_id, booking_date, city, status")
        .eq("traveler_id", user.id)
        .eq("status", "requested"),
      // rent_buddy_profiles is the correct table; gate on admin_status = 'active'
      sc.from("rent_buddy_profiles")
        .select("id")
        .eq("user_id", user.id)
        .eq("admin_status", "active")
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
          .select("id, name, city, category, save_count, latitude, longitude")
          .eq("status", "active")
          .order("save_count", { ascending: false })
          .limit(100);
        gems = ((data as any[]) ?? [])
          .map((g: any) => ({
            ...g,
            _distKm: (g.latitude != null && g.longitude != null)
              ? haversineKmGems(lat, lng, g.latitude as number, g.longitude as number)
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
        .eq("admin_status", "active")
        .ilike("city", `%${buddyCity}%`)
        .neq("user_id", user.id)
        .limit(3);

      for (const bp of (availableBuddies as any[]) ?? []) {
        if (blockedSet.has(bp.user_id as string)) continue;
        addItem({
          id:                `available_buddy:${bp.id as string}`,
          item_type:         'available_buddy',
          item_id:           bp.id as string,
          // Telemetry id ≠ presentation id.  The card's item_id must stay the
          // rent_buddy_profiles.id because both actions navigate by profile id
          // (navigate_buddy_profile, request_buddy?buddyId=<profile-id>), but
          // the ranked writer keys buddy candidates by user_id
          // (`id: b.user_id`, see buddyCandidates above), so rank_events rows
          // for item_kind='buddy' must use user_id too.  Already selected
          // above, so no extra column and no extra round trip.  If it is ever
          // null the buddy row is dropped rather than written under the wrong
          // namespace — see buildLivePulseServeRows in lib/rankLog.
          _rankItemId:       (bp.user_id as string | null) ?? undefined,
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

  const responseItems: LivePulseItem[] = items.map(
    ({ _urgency: _u, _rankItemId: _r, ...rest }) => rest,
  );

  // ── Serve telemetry — fire-and-forget, non-fatal ───────────────────────────
  // Emitted here (and only here) because this is the one point where the served
  // list is final: the urgency sort above has run, so the array index IS the
  // position the viewer saw.  These items are urgency-assembled, not ranked, so
  // no features are written; the rows land on surface='live_pulse' (their own
  // key space, NOT the ranked writer's 'pulse'), event_type marks the
  // provenance, and item_id is always the canonical entity id (never the
  // composite `item.id`).
  //
  // Requires migration 0199_rank_events_live_pulse_surface.sql to be live: the
  // insert below only warns on failure, so shipping ahead of the CHECK widening
  // drops every row silently.
  // Excluded item types (circle, safe_return, compass, buddy_request) emit
  // nothing — see LIVE_PULSE_ITEM_KIND in lib/rankLog.
  //
  // `items` is passed rather than `responseItems` because it still carries
  // _rankItemId; the two arrays are index-identical (responseItems is a 1:1
  // map of items), so `position` is unaffected.
  void logLivePulseServe(items, user.id, sessionId, (err) => {
    // Optional chaining: pinoHttp is mounted app-wide in production, but tests
    // mount this router on a bare express app where req.log is undefined.
    req.log?.warn({ err, userId: user.id }, "pulse/live: rank_events serve insert failed (non-fatal)");
  });

  res.json({ items: responseItems, fallbackContext: fallbackContext ?? null, sessionId });
});

export default router;
