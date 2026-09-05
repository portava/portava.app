/**
 * eventPostsDiscovery.ts
 *
 * Fetches user-generated posts that qualify for the Discovery "Live from events"
 * section via two parallel paths:
 *
 *   Path A — explicit event link: post_event_links → posts → events
 *   Path B — venue category:     posts → discovery_places (primary_category = 'events')
 *
 * Both paths enforce: visibility=public, status=active, not delayed, not deleted,
 * author not blocked, post not already seen.
 *
 * Results are merged, deduplicated, scored (freshness + proximity + engagement),
 * diversity-capped (≤ 3 posts per event/venue), and returned as DiscoveryEventPost[].
 *
 * TODO: denormalize is_event_post flag at write time to avoid per-request join
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPostMediaMap, mergePostMedia } from "./postMediaResolve.js";
import { isPostPublished } from "./postVisibility.js";

// ── Demo-event guard ───────────────────────────────────────────────────────────

/**
 * Returns true when an event's tags mark it as a seeded demo or QA fixture.
 *
 * seed-demo-profile.ts tags events with `["demo", ...]`.
 * seed-demo-city-events.ts tags events with `["demo", "demo_seed", ...]`.
 *
 * Exported so tests can assert against this rule without going through the full
 * HTTP pipeline.
 */
export function isDemoEvent(tags: string[]): boolean {
  return tags.some((t) => t === "demo" || t === "demo_seed");
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DiscoveryEventPost {
  id: string;
  authorId: string;
  content: string;
  mediaUrls: string[];
  venueName: string | null;
  locationCity: string | null;
  publicLat: number | null;
  publicLng: number | null;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  linkedEventId: string | null;
  linkedEventTitle: string | null;
  venueLabel: string | null;
  sourceKind: "event_link" | "venue_category";
}

export interface FetchEventPostsParams {
  db: SupabaseClient;
  lat: number;
  lng: number;
  city: string | null;
  radiusKm: number;
  viewerId: string | null;
  blockedIds: Set<string>;
  seenPostIds: Set<string>;
}

// ── Haversine distance (km) ───────────────────────────────────────────────────

function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Scoring ───────────────────────────────────────────────────────────────────

interface RawPost {
  id: string;
  authorId: string;
  content: string;
  mediaUrls: string[];
  venueName: string | null;
  locationCity: string | null;
  publicLat: number | null;
  publicLng: number | null;
  createdAt: string;
  likeCount: number;
  commentCount: number;
  linkedEventId: string | null;
  linkedEventTitle: string | null;
  venueLabel: string | null;
  sourceKind: "event_link" | "venue_category";
  /** Only set for Path A — used to check if event is currently live */
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  /** Group key for diversity cap: event_id (Path A) or location_place_id (Path B) */
  groupKey: string | null;
  /**
   * Coords used for the proximity gate (radiusKm check).
   * Path A: event.location_lat / event.location_lng
   * Path B: place.lat / place.lng, falling back to post.public_lat / public_lng
   * Kept here so the cache can store pre-proximity results and the gate can
   * be re-applied per-request with the actual viewer lat/lng.
   */
  proximityLat: number | null;
  proximityLng: number | null;
}

function scorePost(
  post: RawPost,
  viewerLat: number,
  viewerLng: number,
  maxEngagement: number,
): number {
  const now = Date.now();
  const ageMs = now - new Date(post.createdAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Freshness — exponential decay, half-life ~12 h
  let freshnessScore = Math.exp(-ageHours / 12);

  // Bonus if the linked event is currently live
  if (post.eventStartsAt && post.eventEndsAt) {
    const start = new Date(post.eventStartsAt).getTime();
    const end   = new Date(post.eventEndsAt).getTime();
    if (now >= start && now <= end) {
      freshnessScore = Math.min(1, freshnessScore * 1.2);
    }
  }

  // Proximity (30%) — closer is better; fall back to 1.0 (no penalty) when coords missing
  let proximityScore = 1.0;
  if (post.publicLat != null && post.publicLng != null) {
    const distKm = haversineKm(viewerLat, viewerLng, post.publicLat, post.publicLng);
    // Linear decay: score 1 at 0 km, 0 at 100 km
    proximityScore = Math.max(0, 1 - distKm / 100);
  }

  // Engagement (20%) — normalised against page max
  const engagement = post.likeCount + post.commentCount * 2;
  const engagementScore = maxEngagement > 0 ? Math.min(1, engagement / maxEngagement) : 0;

  return 0.5 * freshnessScore + 0.3 * proximityScore + 0.2 * engagementScore;
}

// ── Diversity cap ─────────────────────────────────────────────────────────────

function applyDiversityCap(posts: RawPost[], cap = 3): RawPost[] {
  const groupCounts = new Map<string, number>();
  const result: RawPost[] = [];
  for (const post of posts) {
    const key = post.groupKey ?? post.id; // ungrouped posts each get their own slot
    const count = groupCounts.get(key) ?? 0;
    if (count < cap) {
      result.push(post);
      groupCounts.set(key, count + 1);
    }
  }
  return result;
}

// ── Static post filters (viewer-independent) ──────────────────────────────────
//
// These are safe to apply before caching: they depend only on the post's own
// fields (visibility, status, soft-delete, scheduled-delay), not on who is
// viewing it.  Viewer-specific checks (block list, seen set) are applied after
// the cache is consulted, in fetchEventPostsForDiscovery.

function postPassesStaticFilters(
  post: { visibility: string; status: string; post_status: string; deleted_at: string | null; publish_eligible_at: string | null },
): boolean {
  if (post.visibility !== "public") return false;
  if (post.status !== "active") return false;
  if (post.deleted_at != null) return false;
  // Delayed-publish gate (§23/§37). This branch used to read
  // `post.post_status === "delayed_post"`. `delayed_post` is not a label of the
  // `delayed_post_status` enum — the real labels are draft / private /
  // pending_location_exit / pending_delay / pending_safety_review / published /
  // canceled / expired (migration 0049) — so the comparison was false on every
  // row and the gate never fired once. Every pending delayed-geotag post walked
  // straight through into event discovery.
  //
  // The canonical predicate is publication state, not a clock: the sweeper that
  // flips post_status to 'published' is the single writer of that decision, and
  // it applies the safety-review hold and the manual-release path that a bare
  // `publish_eligible_at <= now` comparison cannot see. A pending post is
  // refused even when its eligibility time has passed but the sweeper has not
  // run yet — fail closed, never guess on the reader's side.
  if (!isPostPublished(post)) return false;
  return true;
}

// ── L1 in-memory cache for event-post results ─────────────────────────────────
//
// Keyed on (city, radiusKm) — NOT per-viewer.
//
// Why not per-viewer? The expensive work is the DB join (Path A: post_event_links
// → posts → events; Path B: posts → discovery_places via idx_discovery_places_osm_id
// on osm_id = location_place_id).  Block lists and seen-post sets differ per viewer
// but are cheap to apply in-process against the cached slice.  Caching at the
// city+radius granularity means all viewers for the same city share one fetch,
// while viewer-specific filtering (blockedIds, seenPostIds) and proximity scoring
// are applied on the cached results each request.
//
// TTL: 5 minutes — short enough that newly created event posts appear quickly,
// long enough to amortise the join cost across concurrent requests.

const EVENT_POSTS_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

interface EventPostsCacheEntry {
  /** Pre-proximity, pre-viewer-filter raw posts — viewer filters applied on read. */
  posts: RawPost[];
  cachedAt: number;
}

const _eventPostsCache = new Map<string, EventPostsCacheEntry>();

function eventPostsCacheKey(city: string | null, radiusKm: number): string {
  return `${(city ?? "").toLowerCase().trim()}:${radiusKm}`;
}

function eventPostsCacheIsFresh(entry: EventPostsCacheEntry): boolean {
  return Date.now() - entry.cachedAt < EVENT_POSTS_CACHE_TTL_MS;
}

/** Test hook: clear the event-posts cache so each test starts from a fresh state. */
export function _clearEventPostsCache(): void {
  _eventPostsCache.clear();
}

// ── Path A: explicit event link ───────────────────────────────────────────────
//
// Fetches raw posts without proximity or viewer filters.  The caller applies
// those after the cache is consulted (see fetchEventPostsForDiscovery).

async function fetchPathA(
  db: SupabaseClient,
): Promise<RawPost[]> {
  try {
    // Fetch post_event_links joined with posts and events.
    // Proximity filtering is deferred to the caller so the result can be cached
    // and reused across viewers (block lists differ per viewer; proximity coords
    // differ per viewer within the same city+radius bucket).
    const { data, error } = await db
      .from("post_event_links")
      .select(`
        post_id,
        event_id,
        posts!inner (
          id,
          author_id,
          content,
          media_urls,
          location_city,
          location_name,
          public_lat,
          public_lng,
          created_at,
          like_count,
          comment_count,
          visibility,
          status,
          post_status,
          deleted_at,
          publish_eligible_at
        ),
        events!inner (
          id,
          title,
          location_lat,
          location_lng,
          starts_at,
          ends_at,
          location_name,
          tags
        )
      `)
      .limit(200);

    if (error || !data) return [];

    // post_media is canonical for storage-backed media; posts.media_urls holds
    // external references only (ruled 2026-08-12).
    const storageMedia = await fetchPostMediaMap(
      db,
      (data as any[]).map((r: any) => r.posts?.id).filter(Boolean),
    );
    const results: RawPost[] = [];
    for (const row of data as any[]) {
      const post = row.posts;
      const event = row.events;
      if (!post || !event) continue;

      // Skip posts linked to seeded demo/QA events — they were created by
      // seed-demo-profile.ts / seed-demo-city-events.ts and tagged 'demo' or
      // 'demo_seed' precisely so they can be identified and excluded here.
      const eventTags: string[] = Array.isArray(event.tags) ? (event.tags as string[]) : [];
      if (isDemoEvent(eventTags)) continue;

      if (!postPassesStaticFilters(post)) continue;

      results.push({
        id: post.id,
        authorId: post.author_id,
        content: post.content ?? "",
        mediaUrls: mergePostMedia(post, storageMedia),
        venueName: event.location_name ?? post.location_name ?? null,
        locationCity: post.location_city ?? null,
        publicLat: post.public_lat ?? null,
        publicLng: post.public_lng ?? null,
        createdAt: post.created_at,
        likeCount: post.like_count ?? 0,
        commentCount: post.comment_count ?? 0,
        linkedEventId: event.id,
        linkedEventTitle: event.title ?? null,
        venueLabel: event.location_name ?? null,
        sourceKind: "event_link",
        eventStartsAt: event.starts_at ?? null,
        eventEndsAt: event.ends_at ?? null,
        groupKey: event.id,
        proximityLat: event.location_lat ?? null,
        proximityLng: event.location_lng ?? null,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Path B: venue category (discovery_places.primary_category = 'events') ─────
//
// Fetches raw posts without proximity or viewer filters.  The caller applies
// those after the cache is consulted (see fetchEventPostsForDiscovery).

async function fetchPathB(
  db: SupabaseClient,
  city: string | null,
): Promise<RawPost[]> {
  try {
    // Join posts → discovery_places via location_place_id = osm_id
    // Filter for event-category venues.
    let query = db
      .from("posts")
      .select(`
        id,
        author_id,
        content,
        media_urls,
        location_city,
        location_place_id,
        public_lat,
        public_lng,
        created_at,
        like_count,
        comment_count,
        visibility,
        status,
        post_status,
        deleted_at,
        publish_eligible_at,
        discovery_places!posts_location_place_id_fkey (
          name,
          primary_category,
          city,
          lat,
          lng
        )
      `)
      .eq("visibility", "public")
      .eq("status", "active")
      .is("deleted_at", null)
      .not("location_place_id", "is", null)
      .limit(300);

    // City filter as a broad first-pass (cheaper than distance for most queries)
    if (city) {
      query = query.ilike("location_city", city);
    }

    const { data, error } = await query;
    if (error || !data) return [];

    // post_media is canonical for storage-backed media; posts.media_urls holds
    // external references only (ruled 2026-08-12).
    const storageMedia = await fetchPostMediaMap(
      db,
      (data as any[]).map((r: any) => r.posts?.id).filter(Boolean),
    );
    const results: RawPost[] = [];
    for (const post of data as any[]) {
      const place = Array.isArray(post.discovery_places)
        ? post.discovery_places[0]
        : post.discovery_places;

      if (!place) continue;
      if (place.primary_category !== "events") continue;

      if (!postPassesStaticFilters(post)) continue;

      // Store the best available proximity coords alongside the post so the
      // caller can apply the radiusKm gate without another DB round-trip.
      const proximityLat: number | null = place.lat ?? post.public_lat ?? null;
      const proximityLng: number | null = place.lng ?? post.public_lng ?? null;

      results.push({
        id: post.id,
        authorId: post.author_id,
        content: post.content ?? "",
        mediaUrls: mergePostMedia(post, storageMedia),
        venueName: place.name ?? null,
        locationCity: post.location_city ?? place.city ?? null,
        publicLat: post.public_lat ?? null,
        publicLng: post.public_lng ?? null,
        createdAt: post.created_at,
        likeCount: post.like_count ?? 0,
        commentCount: post.comment_count ?? 0,
        linkedEventId: null,
        linkedEventTitle: null,
        venueLabel: place.name ?? null,
        sourceKind: "venue_category",
        groupKey: post.location_place_id ?? null,
        proximityLat,
        proximityLng,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchEventPostsForDiscovery(
  params: FetchEventPostsParams,
): Promise<DiscoveryEventPost[]> {
  const { db, lat, lng, city, radiusKm, blockedIds, seenPostIds } = params;

  // ── L1 cache lookup ──────────────────────────────────────────────────────────
  //
  // The cache stores raw posts that have passed static filters but have NOT yet
  // had proximity or viewer-specific filters applied.  This lets all viewers
  // for the same (city, radiusKm) share a single DB fetch while still getting
  // correct per-viewer results (different block lists, different seen sets,
  // and potentially slightly different viewer positions within the city).
  const cacheKey = eventPostsCacheKey(city, radiusKm);
  let cachedPosts: RawPost[] | null = null;

  const existing = _eventPostsCache.get(cacheKey);
  if (existing && eventPostsCacheIsFresh(existing)) {
    cachedPosts = existing.posts;
  }

  if (!cachedPosts) {
    // Cache miss — run both paths in parallel and store the pre-filter result.
    const [pathA, pathB] = await Promise.all([
      fetchPathA(db),
      fetchPathB(db, city),
    ]);

    // Merge and deduplicate by post id (Path A wins on duplicates for richer metadata)
    const seenIds = new Set<string>();
    const merged: RawPost[] = [];
    for (const post of [...pathA, ...pathB]) {
      if (!seenIds.has(post.id)) {
        seenIds.add(post.id);
        merged.push(post);
      }
    }

    _eventPostsCache.set(cacheKey, { posts: merged, cachedAt: Date.now() });
    cachedPosts = merged;
  }

  // ── Per-request filters (proximity + viewer-specific) ────────────────────────
  //
  // Applied after the cache so that:
  //   • block lists (differ per viewer) are always current
  //   • seen-post sets (differ per viewer) are always current
  //   • proximity uses the actual viewer lat/lng, not the cached requester's coords
  const filtered: RawPost[] = [];
  for (const post of cachedPosts) {
    // Proximity gate — re-applied per request using the viewer's actual position
    if (post.proximityLat != null && post.proximityLng != null) {
      const dist = haversineKm(lat, lng, post.proximityLat, post.proximityLng);
      if (dist > radiusKm) continue;
    }

    // Viewer-specific filters
    if (blockedIds.has(post.authorId)) continue;
    if (seenPostIds.has(post.id)) continue;

    filtered.push(post);
  }

  // Score
  const maxEngagement = filtered.reduce(
    (m, p) => Math.max(m, p.likeCount + p.commentCount * 2),
    0,
  );
  const scored = filtered
    .map((p) => ({ post: p, score: scorePost(p, lat, lng, maxEngagement) }))
    .sort((a, b) => b.score - a.score)
    .map(({ post }) => post);

  // Diversity cap: at most 3 posts per event/venue
  const capped = applyDiversityCap(scored);

  // Return as typed DiscoveryEventPost[]
  return capped.map(
    (p): DiscoveryEventPost => ({
      id: p.id,
      authorId: p.authorId,
      content: p.content,
      mediaUrls: p.mediaUrls,
      venueName: p.venueName,
      locationCity: p.locationCity,
      publicLat: p.publicLat,
      publicLng: p.publicLng,
      createdAt: p.createdAt,
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      linkedEventId: p.linkedEventId,
      linkedEventTitle: p.linkedEventTitle,
      venueLabel: p.venueLabel,
      sourceKind: p.sourceKind,
    }),
  );
}
