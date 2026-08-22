/**
 * placeLiving — Living Destination Page API.
 *
 *   GET  /api/places/:id/living
 *        Returns the full living-page payload (cached, SWR).
 *
 *   GET  /api/places/:id/living/timeline?slice=today|week|month|year|dry_season|rainy_season
 *        Returns the time-sliced post feed for a place.
 *
 * Auth: public, auth optional — authenticated callers may receive personalised
 * fields in future; for now the payload is identical either way.
 *
 * Cache strategy:
 *   • place_living_cache is served when < 1 h old (hot place) or < 24 h old
 *     (sparse place, total posts < 5).
 *   • On miss or stale: all sub-calls are made in parallel; any individual
 *     failure sets that field to null (no 500s).
 *   • A background revalidation job is enqueued on every cache miss.
 */

import { Router } from "express";
import { readLiveCrowdLevel } from "../lib/liveClaimRead.js";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { optionalUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { toCanonicalPlace } from "../lib/places/placeResolve.js";
import { getWeatherContext } from "../lib/weatherCache.js";
import { getBestOf, enqueueLivingCacheInvalidation } from "../lib/places/placeCollections.js";
import { generateAiSummary } from "../lib/places/placeAiSummary.js";
import { isLivePlacesCapabilityEnabled } from "../lib/featureFlags.js";
import { isEligiblePlaceDayPost } from "../lib/places/placeDays.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Cache TTLs ─────────────────────────────────────────────────────────────────
const HOT_CACHE_TTL_MS    = 1  * 60 * 60 * 1_000; //  1 hour
const SPARSE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const SPARSE_POST_THRESHOLD = 5;

// ── Timeline slice schema ──────────────────────────────────────────────────────
const VALID_SLICES = ["today", "week", "month", "year", "dry_season", "rainy_season"] as const;
type TimelineSlice = (typeof VALID_SLICES)[number];

// Tropical dry-season months (November–April = months 11,12,1,2,3,4)
const DRY_SEASON_MONTHS  = new Set([11, 12, 1, 2, 3, 4]);
const RAINY_SEASON_MONTHS = new Set([5, 6, 7, 8, 9, 10]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function isoNow(): string { return new Date().toISOString(); }

function buildDirectionsUrl(lat: number, lng: number, name: string): {
  appleMaps: string;
  googleMaps: string;
  waze: string;
} {
  const label = encodeURIComponent(name);
  return {
    appleMaps:  `https://maps.apple.com/?daddr=${lat},${lng}&q=${label}`,
    googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    waze:       `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  };
}

/** Safely call a sub-task; returns null on any error. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ── Shared place + refs loader ─────────────────────────────────────────────────

async function loadPlaceGroup(
  sc: any,
  placeId: string,
): Promise<{ place: any; survivorId: string; refs: any[] } | null> {
  const { data: place } = await sc
    .from("places")
    .select("*")
    .eq("id", placeId)
    .maybeSingle();
  if (!place) return null;

  const survivorId: string = (place as any).merged_into_place_id ?? placeId;
  let survivorPlace = place;
  if (survivorId !== placeId) {
    const { data: sp } = await sc.from("places").select("*").eq("id", survivorId).maybeSingle();
    if (!sp) return null;
    survivorPlace = sp;
  }

  const { data: merged } = await sc
    .from("places")
    .select("id")
    .eq("merged_into_place_id", survivorId);
  const ids = [survivorId, ...((merged as any[]) ?? []).map((m: any) => m.id)];
  const { data: refs } = await sc
    .from("external_place_references")
    .select("*")
    .in("place_id", ids);

  return { place: survivorPlace, survivorId, refs: (refs as any[]) ?? [] };
}

// ── Assembler ──────────────────────────────────────────────────────────────────

async function assembleLivingPayload(sc: any, placeId: string): Promise<any> {
  // Load place group (required — 404 if missing)
  const group = await loadPlaceGroup(sc, placeId);
  if (!group) return null;

  // Use the survivor/canonical ID for all place-scoped queries so that
  // requests against merged place IDs see the correct post/aggregation data.
  const { survivorId } = group;
  const canonical = toCanonicalPlace(group.place, group.refs);
  const coords = canonical.coordinates;

  // Fire all sub-calls in parallel; any failure → null field
  const [
    weather,
    bestOf,
    bucketRows,
    dedupGroups,
    topContributorRows,
    postSample,
    ratingRows,
  ] = await Promise.all([
    // Weather: use city name (or coords if available)
    safe(() =>
      getWeatherContext(
        canonical.city ?? canonical.name,
        undefined,
        undefined,
      ),
    ),

    // Best-of collections (keyed to survivor)
    safe(() => getBestOf(survivorId, sc)),

    // Coverage buckets (all buckets for this place)
    safe(async () => {
      const { data, error } = await sc
        .from("place_coverage_buckets")
        .select("bucket, post_count")
        .eq("canonical_place_id", survivorId)
        .order("post_count", { ascending: false });
      if (error) return null;
      return (data as any[]) ?? [];
    }),

    // Near-duplicate groups (top 5 by member_count)
    safe(async () => {
      const { data, error } = await sc
        .from("media_dedup_groups")
        .select("id, member_count, sample_media_ids")
        .eq("canonical_place_id", survivorId)
        .order("member_count", { ascending: false })
        .limit(5);
      if (error) return null;
      return (data as any[]) ?? [];
    }),

    // Top contributor (keyed to survivor)
    safe(async () => {
      const { data, error } = await sc
        .from("place_top_contributors")
        .select("user_id, contribution_count")
        .eq("place_id", survivorId)
        .order("contribution_count", { ascending: false })
        .limit(1);
      if (error || !data || (data as any[]).length === 0) return null;
      return (data as any[])[0] ?? null;
    }),

    // Post sample for AI summary + bucket content + today timeline
    // Includes post_buckets so bucket cards can be populated from the post data.
    safe(async () => {
      const { data, error } = await sc
        .from("posts")
        // `status` is projected even though it is also an .eq() predicate:
        // isEligiblePlaceDayPost reads post.status, and PostgREST returns ONLY
        // the projected columns, so omitting it here would leave p.status
        // undefined and the filter below would reject every post — emptying the
        // living page rather than securing it.
        .select("id, content, media_urls, media_type, media_thumbnail_url, author_id, created_at, like_count, save_count, share_count, post_buckets, visibility, status, post_status, publish_at")
        .eq("canonical_place_id", survivorId)
        .eq("status", "active")
        // The living page is an ANONYMOUS surface (optionalUser, mounted bare)
        // served through the service-role client, which bypasses RLS. Without a
        // visibility predicate it returned private and trip_only captions, and
        // not-yet-published delayed posts, to any caller at all.
        .eq("visibility", "public")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return null;
      // Second gate, same predicate the Place Day feed uses — covers
      // post_status and publish_at, which no SQL predicate above enforces.
      return ((data as any[]) ?? []).filter((p: any) => isEligiblePlaceDayPost(p));
    }),

    // WorthIt rating: aggregate from post engagement signals (best-effort)
    safe(async () => {
      const { data, error } = await sc
        .from("posts")
        .select("like_count")
        .eq("canonical_place_id", survivorId)
        .eq("status", "active")
        // Aggregate only over posts this anonymous surface may actually count.
        // Private and trip_only engagement must not move a public rating.
        .eq("visibility", "public");
      if (error) return null;
      return (data as any[]) ?? [];
    }),
  ]);

  const allPosts = postSample ?? [];
  const totalPostCount = allPosts.length; // approximate — real count would need COUNT(*)

  // ── sparseMode ────────────────────────────────────────────────────────────────
  const sparseMode = totalPostCount < SPARSE_POST_THRESHOLD;

  // ── hero ──────────────────────────────────────────────────────────────────────
  const heroVideoUrl  = bestOf?.videos?.[0]?.mediaUrl ?? null;
  const heroImageUrl  = bestOf?.photos?.[0]?.mediaUrl ?? canonical.headerImageUrl ?? null;
  const hero = { imageUrl: heroImageUrl, videoUrl: heroVideoUrl };

  // ── rating ────────────────────────────────────────────────────────────────────
  let rating: any = null;
  if (ratingRows && ratingRows.length > 0) {
    const totalVotes = ratingRows.length;
    const totalLikes = ratingRows.reduce((s: number, r: any) => s + (r.like_count ?? 0), 0);
    const avgScore   = totalVotes > 0 ? Math.round((totalLikes / totalVotes) * 10) / 10 : null;
    rating = { score: avgScore, voteCount: totalVotes, rawLikes: totalLikes };
  }

  // ── bestTime + crowdLevel ─────────────────────────────────────────────────────
  // These were two dead reads: `places` has no best_time or crowd_level column
  // (both live on hidden_gems), and the `as any` casts hid the type error, so
  // each always evaluated to null while looking like a real read. crowdLevel now
  // comes from the live-claim projection; with the flag off or no claim present
  // it returns exactly the null it always did.
  const crowdLevel = await readLiveCrowdLevel(sc, placeId);
  // bestTime has no claim type in the IG-01 registry, so it stays honestly null
  // rather than reading a column that does not exist.
  const bestTime: string | null = null;

  // ── directionsUrl ─────────────────────────────────────────────────────────────
  const directionsUrl = coords
    ? buildDirectionsUrl(coords.lat, coords.lng, canonical.name)
    : null;

  // ── officialInfo ──────────────────────────────────────────────────────────────
  const officialInfo = {
    hours:        canonical.openingHours,
    isOpenNow:    canonical.isOpenNow,
    address:      canonical.formattedAddress ?? canonical.address,
    phone:        canonical.phone,
    website:      canonical.website,
    priceLevel:   canonical.priceLevel,
    rating:       canonical.rating,
    reviewCount:  canonical.reviewCount,
    bookingUrl:   canonical.bookingUrl,
    attribution:  canonical.attribution,
  };

  // ── AI summary ────────────────────────────────────────────────────────────────
  const aiSummaryPosts = allPosts.slice(0, 10).map((p: any) => ({
    id:      p.id as string,
    caption: p.content as string | null,
  }));
  const aiSummary = await safe(() =>
    generateAiSummary(
      placeId,
      canonical.name,
      aiSummaryPosts,
      { address: canonical.formattedAddress, description: canonical.description, category: canonical.category },
      sc,
    ),
  );

  // ── buckets ───────────────────────────────────────────────────────────────────
  const bucketMap = new Map<string, number>(
    (bucketRows ?? []).map((r: any) => [r.bucket as string, r.post_count as number]),
  );

  // Build bucket content: top-10 posts per bucket that match the bucket type
  const buckets = Array.from(bucketMap.entries())
    .filter(([, count]) => count >= 1)
    .map(([bucket, postCount]) => {
      // Sample posts that match this bucket (by post_buckets array field)
      const bucketPosts = allPosts
        .filter((p: any) => Array.isArray(p.post_buckets) && p.post_buckets.includes(bucket))
        .slice(0, 10)
        .map((p: any) => ({
          id:           p.id,
          mediaUrl:     Array.isArray(p.media_urls) ? p.media_urls[0] ?? null : null,
          thumbnailUrl: p.media_thumbnail_url ?? null,
          caption:      p.content ?? null,
        }));

      return {
        bucket,
        posts:     bucketPosts,
        postCount,
        isThin:    postCount < 5,
      };
    });

  // ── thinBuckets ───────────────────────────────────────────────────────────────
  const thinBuckets = Array.from(bucketMap.entries())
    .filter(([, count]) => count === 0)
    .map(([bucket]) => bucket);

  // ── timeline (today default) ──────────────────────────────────────────────────
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const timelinePosts = allPosts
    .filter((p: any) => (p.created_at as string) >= cutoff24h)
    .slice(0, 50)
    .map((p: any) => ({
      id:           p.id,
      mediaUrl:     Array.isArray(p.media_urls) ? p.media_urls[0] ?? null : null,
      thumbnailUrl: p.media_thumbnail_url ?? null,
      caption:      p.content ?? null,
      authorId:     p.author_id ?? null,
      createdAt:    p.created_at ?? null,
      like_count:   typeof p.like_count === 'number' ? p.like_count : 0,
    }));

  const timeline = {
    slice:       "today" as TimelineSlice,
    posts:       timelinePosts,
    crowdLevel,
    weatherBrief: weather?.briefSummary ?? null,
  };

  // ── bestOf ────────────────────────────────────────────────────────────────────
  const bestOfOut = bestOf
    ? {
        videos:      bestOf.videos.slice(0, 25),
        photos:      bestOf.photos.slice(0, 25),
        viewpoints:  bestOf.viewpoints.slice(0, 5),
        foodNearby:  bestOf.foodNearby.slice(0, 10),
        experiences: bestOf.experiences.slice(0, 10),
      }
    : null;

  // ── dedupGroups ───────────────────────────────────────────────────────────────
  const dedupGroupsOut = (dedupGroups ?? []).map((g: any) => ({
    groupId:    g.id,
    memberCount: g.member_count ?? 0,
    sampleUrls:  ((g.sample_media_ids ?? []) as string[]).slice(0, 3),
  }));

  // ── topContributor ────────────────────────────────────────────────────────────
  let topContributor: any = null;
  if (topContributorRows) {
    // Fetch display info for the top contributor
    // safe(), not `.catch()` on the builder. A PostgREST query builder is a
    // thenable — it implements `then` to satisfy PromiseLike — and does not
    // necessarily expose `.catch`. Because `sc` is typed `any` here, TypeScript
    // never checked that call, so a missing `.catch` surfaces only at runtime,
    // as a TypeError thrown on the one path that reaches it: a living-page
    // cache miss for a place that HAS a top contributor. Every one of the seven
    // sibling sub-calls in this file already uses safe() (lines 132-200); this
    // was the only one that hand-rolled its own error handling.
    const profile = await safe(async () => {
      const { data } = await sc
        .from("profiles")
        .select("id, display_name, avatar_url, username")
        .eq("id", (topContributorRows as any).user_id)
        .maybeSingle();
      return data;
    });
    topContributor = {
      userId:            (topContributorRows as any).user_id,
      displayName:       (profile as any)?.display_name ?? (profile as any)?.username ?? null,
      avatarUrl:         (profile as any)?.avatar_url ?? null,
      contributionCount: (topContributorRows as any).contribution_count ?? 0,
    };
  }

  return {
    placeId,
    sparseMode,
    hero,
    rating,
    bestTime,
    crowdLevel,
    weather:      weather ? { forecasts: weather.forecasts, briefSummary: weather.briefSummary } : null,
    directionsUrl,
    officialInfo,
    aiSummary,
    buckets,
    timeline,
    bestOf:       bestOfOut,
    dedupGroups:  dedupGroupsOut,
    topContributor,
    thinBuckets,
    generatedAt:  isoNow(),
  };
}

// ── GET /api/places/:id/living ─────────────────────────────────────────────────
router.get("/places/:id/living", asyncHandler(async (req, res) => {
  // Auth optional — auth not required for living page reads
  await optionalUser(req);

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!(await isLivePlacesCapabilityEnabled(sc, "live_places_enabled"))) {
    req.log?.info?.({ capability: "live_places_enabled" }, "live-places capability denied");
    sendError(res, "feature_disabled", "Live Places is unavailable");
    return;
  }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  // 1. Check cache
  const { data: cached } = await sc
    .from("place_living_cache")
    .select("payload, cached_at, sparse")
    .eq("place_id", id)
    .maybeSingle();

  const nowMs = Date.now();

  if (cached) {
    const ageMs = nowMs - new Date((cached as any).cached_at).getTime();
    const isSparse = (cached as any).sparse as boolean;
    const ttl = isSparse ? SPARSE_CACHE_TTL_MS : HOT_CACHE_TTL_MS;

    if (ageMs < ttl) {
      res.setHeader("X-Cache", "HIT");
      res.json((cached as any).payload);
      return;
    }
    // Stale — serve stale immediately, enqueue background revalidation
    res.setHeader("X-Cache", "STALE");
    res.json((cached as any).payload);
    // Best-effort background revalidation (don't await)
    void (async () => {
      try {
        const payload = await assembleLivingPayload(sc, id);
        if (!payload) return;
        const revalMs = Date.now();
        await sc.from("place_living_cache").upsert(
          {
            place_id:  id,
            payload,
            cached_at: new Date(revalMs).toISOString(),
            sparse:    payload.sparseMode,
          },
          { onConflict: "place_id" },
        );
        await enqueueLivingCacheInvalidation(id, sc);
      } catch (err) {
        req.log?.warn({ err, place_id: id }, "placeLiving: background revalidation failed");
      }
    })();
    return;
  }

  // 2. Cache miss: build fresh payload
  const payload = await assembleLivingPayload(sc, id);
  if (!payload) { sendError(res, "not_found", "Place not found"); return; }

  // Write to cache (best-effort)
  void sc
    .from("place_living_cache")
    .upsert(
      {
        place_id:  id,
        payload,
        cached_at: new Date(nowMs).toISOString(),
        sparse:    payload.sparseMode,
      },
      { onConflict: "place_id" },
    )
    .then(({ error }: any) => {
      if (error) console.warn("placeLiving: cache write failed:", error.message);
    });

  // Enqueue for precompute worker (best-effort)
  void enqueueLivingCacheInvalidation(id, sc);

  res.setHeader("X-Cache", "MISS");
  res.json(payload);
}));

// ── GET /api/places/:id/living/timeline ───────────────────────────────────────
router.get("/places/:id/living/timeline", asyncHandler(async (req, res) => {
  await optionalUser(req);

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!(await isLivePlacesCapabilityEnabled(sc, "live_places_enabled"))) {
    req.log?.info?.({ capability: "live_places_enabled" }, "live-places capability denied");
    sendError(res, "feature_disabled", "Live Places is unavailable");
    return;
  }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const sliceRaw = (req.query.slice as string | undefined) ?? "today";
  if (!VALID_SLICES.includes(sliceRaw as TimelineSlice)) {
    sendError(res, "invalid_payload", `slice must be one of: ${VALID_SLICES.join(", ")}`);
    return;
  }
  const slice = sliceRaw as TimelineSlice;

  // Resolve merged place IDs to the survivor/canonical ID — same logic as the
  // living assembler — so timeline slices are consistent with the main payload.
  const group = await loadPlaceGroup(sc, id);
  if (!group) { sendError(res, "not_found", "Place not found"); return; }
  const { survivorId } = group;

  const now = new Date();
  let query = sc
    .from("posts")
    // `status` projected deliberately — isEligiblePlaceDayPost reads it, and
    // PostgREST returns only projected columns, so omitting it would make the
    // filter below reject every row and empty the timeline.
    .select("id, content, media_urls, media_type, media_thumbnail_url, author_id, created_at, like_count, post_buckets, visibility, status, post_status, publish_at")
    .eq("canonical_place_id", survivorId)
    .eq("status", "active")
    // Anonymous surface: public content only. See the assembler query above.
    .eq("visibility", "public")
    .order("created_at", { ascending: false });

  if (slice === "today") {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    query = query.gte("created_at", cutoff).limit(50);
  } else if (slice === "week") {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    query = query.gte("created_at", cutoff).limit(50);
  } else if (slice === "month") {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    query = query.gte("created_at", d.toISOString()).limit(50);
  } else if (slice === "year") {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - 1);
    query = query.gte("created_at", d.toISOString()).limit(50);
  } else if (slice === "dry_season" || slice === "rainy_season") {
    // Filter by EXTRACT(MONTH) — Supabase doesn't support SQL functions in the
    // JS client query builder, so we fetch all and filter in-memory.
    query = query.limit(500);
  }

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  // Second gate, deliberately redundant with the SQL predicates above: it also
  // covers post_status and publish_at, so a delayed post whose geofence has not
  // cleared cannot surface on an anonymous page just because it is public.
  let posts: any[] = ((data as any[]) ?? []).filter((p: any) => isEligiblePlaceDayPost(p));

  // Season filtering (in-memory)
  if (slice === "dry_season" || slice === "rainy_season") {
    const months = slice === "dry_season" ? DRY_SEASON_MONTHS : RAINY_SEASON_MONTHS;
    posts = posts
      .filter((p: any) => {
        const m = new Date(p.created_at as string).getMonth() + 1; // 1-based
        return months.has(m);
      })
      .slice(0, 50);
  }

  const formattedPosts = posts.map((p: any) => ({
    id:           p.id,
    mediaUrl:     Array.isArray(p.media_urls) ? p.media_urls[0] ?? null : null,
    thumbnailUrl: p.media_thumbnail_url ?? null,
    caption:      p.content ?? null,
    authorId:     p.author_id ?? null,
    createdAt:    p.created_at ?? null,
    mediaType:    p.media_type ?? null,
    buckets:      p.post_buckets ?? [],
    like_count:   typeof p.like_count === 'number' ? p.like_count : 0,
  }));

  // Inject current crowdLevel + weather brief in response.
  // Was a hardcoded null waiting on a worker that never existed; now reads the
  // same projection as the other surface, so there is one source, not two.
  const crowdLevel = await readLiveCrowdLevel(sc, (group.place as any)?.id ?? null);
  const weatherBrief = await safe(async () => {
    const wx = await getWeatherContext(
      (group.place as any).city ?? (group.place as any).name,
    );
    return wx?.briefSummary ?? null;
  });

  res.json({
    placeId:     survivorId,
    slice,
    posts:       formattedPosts,
    total:       formattedPosts.length,
    crowdLevel,
    weatherBrief,
  });
}));

export default router;
