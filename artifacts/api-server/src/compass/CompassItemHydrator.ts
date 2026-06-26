/**
 * CompassItemHydrator — Phase 3 candidate item loader.
 *
 * Fetches real content from the DB and maps it to CompassItems so the feed
 * builder has a non-empty pool to score. Phase 4 (Front Load Engine) will
 * replace this with a pre-computed cache; this layer is the Phase 3 baseline.
 *
 * Sources:
 *   - posts (recent public posts, scoped to viewer's city + global fallback)
 *   - buddy profiles (rent_buddy_profiles with active status)
 *   - community discovery places (discovery_places in viewer's city)
 *
 * Items are returned as CompassItems ready for the pipeline.
 * All personally-identifying data that is NOT already public is omitted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem } from "./types.js";
import type { CompassProfile } from "./types.js";

const POSTS_WINDOW_HOURS = 72;
const MAX_POSTS   = 50;
const MAX_BUDDIES = 30;
const MAX_PLACES  = 20;

// ── Posts ─────────────────────────────────────────────────────────────────────

async function fetchPosts(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  try {
    const since = new Date(Date.now() - POSTS_WINDOW_HOURS * 60 * 60 * 1_000).toISOString();

    let query = db
      .from("posts")
      .select("id, author_id, content, created_at, location_city, location_country, status, visibility")
      .eq("visibility", "public")
      .eq("status", "active")
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_POSTS);

    // Bias toward viewer's city when known
    if (profile.currentCity) {
      // Fetch city posts first, then fill remainder from global
      const cityRes = await db
        .from("posts")
        .select("id, author_id, content, created_at, location_city, location_country, status, visibility")
        .eq("visibility", "public")
        .eq("status", "active")
        .ilike("location_city", profile.currentCity)
        .gt("created_at", since)
        .order("created_at", { ascending: false })
        .limit(MAX_POSTS / 2);

      const { data: globalData } = await query;
      const { data: cityData } = cityRes;

      const seen = new Set<string>();
      const merged: any[] = [];
      for (const row of [...(cityData ?? []), ...(globalData ?? [])]) {
        if (!seen.has(row.id)) { seen.add(row.id); merged.push(row); }
      }
      return merged.slice(0, MAX_POSTS).map(postToItem);
    }

    const { data } = await query;
    return ((data as any[]) ?? []).map(postToItem);
  } catch {
    return [];
  }
}

function postToItem(post: any): CompassItem {
  return {
    id:              post.id,
    type:            "post",
    authorId:        post.author_id ?? undefined,
    createdAt:       post.created_at,
    contentBody:     post.content ?? null,
    city:            post.location_city ?? null,
    country:         post.location_country ?? null,
    visibilityScope: "public",
    qualityScore:    5,
  };
}

// ── Buddy profiles ────────────────────────────────────────────────────────────

async function fetchBuddies(db: SupabaseClient): Promise<CompassItem[]> {
  try {
    const { data } = await db
      .from("rent_buddy_profiles")
      .select("user_id, status, is_verified, verified_at, profiles!user_id(id, created_at)")
      .eq("status", "active")
      .limit(MAX_BUDDIES);

    return ((data as any[]) ?? []).map((buddy): CompassItem => {
      const profile = Array.isArray(buddy.profiles)
        ? buddy.profiles[0]
        : buddy.profiles;
      return {
        id:               buddy.user_id,
        type:             "buddy",
        authorId:         buddy.user_id,
        targetUserId:     buddy.user_id,
        buddyStatus:      buddy.status,
        isVerified:       Boolean(buddy.is_verified),
        // authorJoinedAt: the profile creation date (for new-user fair exposure)
        authorJoinedAt:   profile?.created_at ?? undefined,
        // buddyApprovedAt: the buddy-platform approval date — used as the
        // "recently approved" signal in fair-exposure eligibility so that
        // older users newly approved as Buddies are correctly given fair exposure.
        buddyApprovedAt:  buddy.verified_at ?? undefined,
        visibilityScope:  "public",
        qualityScore:     buddy.is_verified ? 8 : 6,
      };
    });
  } catch {
    return [];
  }
}

// ── Community discovery places ────────────────────────────────────────────────

async function fetchPlaces(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  if (!profile.currentCity) return [];
  try {
    const { data } = await db
      .from("discovery_places")
      .select("id, city, name, category, status, rating, created_at, submitted_by")
      .ilike("city", profile.currentCity)
      .eq("status", "active")
      .limit(MAX_PLACES);

    return ((data as any[]) ?? []).map((place): CompassItem => ({
      id:              `place:${place.id}`,
      type:            "suggestion",
      authorId:        place.submitted_by ?? undefined,
      contentBody:     place.name,
      interestTags:    [place.category].filter(Boolean),
      city:            place.city ?? null,
      qualityScore:    place.rating ? Math.min(10, (place.rating as number) * 2) : 5,
      visibilityScope: "public",
      createdAt:       place.created_at,
    }));
  } catch {
    return [];
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Fetch a pool of candidate CompassItems for the given user's feed.
 * Never throws — returns an empty array on any DB error.
 */
export async function hydrateCompassItems(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  const [posts, buddies, places] = await Promise.allSettled([
    fetchPosts(db, profile),
    fetchBuddies(db),
    fetchPlaces(db, profile),
  ]);

  const allItems: CompassItem[] = [
    ...(posts.status   === "fulfilled" ? posts.value   : []),
    ...(buddies.status === "fulfilled" ? buddies.value : []),
    ...(places.status  === "fulfilled" ? places.value  : []),
  ];

  // Exclude blocked users
  const blockedSet = new Set([...profile.blockedUserIds, ...profile.blockerUserIds]);
  return allItems.filter(
    (item) => !item.authorId || !blockedSet.has(item.authorId),
  );
}
