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

// ── Common post filters ───────────────────────────────────────────────────────

function postPassesFilters(
  post: { visibility: string; status: string; post_status: string; deleted_at: string | null; author_id: string; publish_eligible_at: string | null },
  blockedIds: Set<string>,
  seenPostIds: Set<string>,
  postId: string,
): boolean {
  if (post.visibility !== "public") return false;
  if (post.status !== "active") return false;
  if (post.deleted_at != null) return false;
  if (post.post_status === "delayed_post") {
    // Allow if publish_eligible_at is in the past
    if (!post.publish_eligible_at) return false;
    if (new Date(post.publish_eligible_at).getTime() > Date.now()) return false;
  }
  if (blockedIds.has(post.author_id)) return false;
  if (seenPostIds.has(postId)) return false;
  return true;
}

// ── Path A: explicit event link ───────────────────────────────────────────────

async function fetchPathA(
  db: SupabaseClient,
  lat: number,
  lng: number,
  radiusKm: number,
  blockedIds: Set<string>,
  seenPostIds: Set<string>,
): Promise<RawPost[]> {
  try {
    // Fetch post_event_links joined with posts and events.
    // We'll filter by event location proximity in application code since
    // Supabase JS client doesn't support st_distance on raw query easily.
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
          location_name
        )
      `)
      .limit(200);

    if (error || !data) return [];

    const results: RawPost[] = [];
    for (const row of data as any[]) {
      const post = row.posts;
      const event = row.events;
      if (!post || !event) continue;

      // Filter by event proximity
      if (event.location_lat != null && event.location_lng != null) {
        const dist = haversineKm(lat, lng, event.location_lat, event.location_lng);
        if (dist > radiusKm) continue;
      }

      if (!postPassesFilters(post, blockedIds, seenPostIds, post.id)) continue;

      results.push({
        id: post.id,
        authorId: post.author_id,
        content: post.content ?? "",
        mediaUrls: Array.isArray(post.media_urls) ? post.media_urls : [],
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
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Path B: venue category (discovery_places.primary_category = 'events') ─────

async function fetchPathB(
  db: SupabaseClient,
  lat: number,
  lng: number,
  city: string | null,
  radiusKm: number,
  blockedIds: Set<string>,
  seenPostIds: Set<string>,
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

    const results: RawPost[] = [];
    for (const post of data as any[]) {
      const place = Array.isArray(post.discovery_places)
        ? post.discovery_places[0]
        : post.discovery_places;

      if (!place) continue;
      if (place.primary_category !== "events") continue;

      // Proximity filter using place coords if available, else post public coords
      const placeLat = place.lat ?? post.public_lat;
      const placeLng = place.lng ?? post.public_lng;
      if (placeLat != null && placeLng != null) {
        const dist = haversineKm(lat, lng, placeLat, placeLng);
        if (dist > radiusKm) continue;
      }

      if (!postPassesFilters(post, blockedIds, seenPostIds, post.id)) continue;

      results.push({
        id: post.id,
        authorId: post.author_id,
        content: post.content ?? "",
        mediaUrls: Array.isArray(post.media_urls) ? post.media_urls : [],
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

  // Run both paths in parallel
  const [pathA, pathB] = await Promise.all([
    fetchPathA(db, lat, lng, radiusKm, blockedIds, seenPostIds),
    fetchPathB(db, lat, lng, city, radiusKm, blockedIds, seenPostIds),
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

  // Score
  const maxEngagement = merged.reduce(
    (m, p) => Math.max(m, p.likeCount + p.commentCount * 2),
    0,
  );
  const scored = merged
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
