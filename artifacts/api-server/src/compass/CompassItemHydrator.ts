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

const POSTS_WINDOW_HOURS  = 72;
const MAX_POSTS    = 50;
const MAX_BUDDIES  = 30;
const MAX_PLACES   = 20;
const MAX_EVENTS       = 30;
const EVENTS_WINDOW_DAYS = 30;
const MAX_HIDDEN_GEMS  = 20;

// ── Posts ─────────────────────────────────────────────────────────────────────

async function fetchPosts(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  try {
    const since = new Date(Date.now() - POSTS_WINDOW_HOURS * 60 * 60 * 1_000).toISOString();

    let query = db
      .from("posts")
      .select("id, author_id, content, created_at, location_city, location_country, status, visibility, canonical_place_id")
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
        .select("id, author_id, content, created_at, location_city, location_country, status, visibility, canonical_place_id")
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
  const content = post.content ?? "";
  const title = content.trim() || null;
  return {
    id:              post.id,
    type:            "post",
    title:           title,
    category:        "post",
    authorId:        post.author_id ?? undefined,
    createdAt:       post.created_at,
    contentBody:     content,
    city:            post.location_city ?? null,
    country:         post.location_country ?? null,
    visibilityScope: "public",
    qualityScore:    5,
    // Place-affinity boost: carry the canonical place so scoreItem can apply
    // the ×1.15 multiplier when the viewer has recently visited this place.
    placeId:         (post.canonical_place_id as string | null) ?? null,
    data:            { title },
  };
}

// ── Buddy profiles ────────────────────────────────────────────────────────────

async function fetchBuddies(db: SupabaseClient, profile: CompassProfile): Promise<CompassItem[]> {
  // Rent a Buddy is a real-world meetup service — a buddy in another city
  // can never actually be booked by this viewer, so (unlike posts/events,
  // which fall back to a global pool) buddies are strictly scoped to the
  // viewer's current city. Without a known city there is no meaningful
  // "near you" pool, so surface none — matching the Rent a Buddy directory,
  // which also shows nothing until a city is chosen.
  if (!profile.currentCity) return [];
  try {
    const { data } = await db
      .from("rent_buddy_profiles")
      .select("user_id, status, verified, verified_at, city, profiles!user_id(id, created_at)")
      .eq("status", "active")
      .ilike("city", profile.currentCity)
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
        isVerified:       Boolean(buddy.verified),
        // authorJoinedAt: the profile creation date (for new-user fair exposure)
        authorJoinedAt:   profile?.created_at ?? undefined,
        // buddyApprovedAt: the buddy-platform approval date — used as the
        // "recently approved" signal in fair-exposure eligibility so that
        // older users newly approved as Buddies are correctly given fair exposure.
        buddyApprovedAt:  buddy.verified_at ?? undefined,
        visibilityScope:  "public",
        qualityScore:     buddy.verified ? 8 : 6,
      };
    });
  } catch {
    return [];
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

async function fetchEvents(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  try {
    const nowMs      = Date.now();
    const now        = new Date(nowMs).toISOString();
    const windowEnd  = new Date(nowMs + EVENTS_WINDOW_DAYS * 86_400_000).toISOString();

    // Fetch upcoming public events (city-biased when city is known)
    const baseQuery = () =>
      db
        .from("events")
        .select(
          "id, host_id, title, category, starts_at, ends_at, city, max_attendees, going_count, " +
          "visibility, state, location_lat, location_lng, location_name, cover_url, show_exact_location",
        )
        .eq("visibility", "public")
        .in("state", ["open", "full", "waitlist"])
        .gte("starts_at", now)
        .lte("starts_at", windowEnd)
        .limit(MAX_EVENTS);

    let rawEvents: any[] = [];
    if (profile.currentCity) {
      const [cityRes, globalRes] = await Promise.all([
        baseQuery().ilike("city", profile.currentCity),
        baseQuery(),
      ]);
      const seen = new Set<string>();
      for (const ev of [...(cityRes.data ?? []), ...(globalRes.data ?? [])] as any[]) {
        if (!seen.has(ev.id)) { seen.add(ev.id); rawEvents.push(ev); }
      }
    } else {
      const { data } = await baseQuery();
      rawEvents = (data as any[]) ?? [];
    }

    if (rawEvents.length === 0) return [];

    // Fetch viewer's following list to compute attendingFriendCount
    const { data: followRows } = await db
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", profile.userId);

    const followingSet = new Set<string>(
      ((followRows ?? []) as any[]).map((r: any) => r.following_id as string),
    );

    // Fetch all going RSVPs for these events
    const eventIds = rawEvents.map((e: any) => e.id as string);
    const rsvpCount = new Map<string, number>();

    if (followingSet.size > 0) {
      const { data: rsvpRows } = await db
        .from("event_rsvps")
        .select("event_id, user_id")
        .in("event_id", eventIds)
        .eq("status", "going");

      for (const rsvp of (rsvpRows ?? []) as any[]) {
        if (followingSet.has(rsvp.user_id as string)) {
          rsvpCount.set(rsvp.event_id, (rsvpCount.get(rsvp.event_id) ?? 0) + 1);
        }
      }
    }

    return rawEvents.map((event: any): CompassItem => ({
      id:                   String(event.id),
      type:                 "event",
      title:                event.title ?? null,
      category:             event.category ?? "event",
      authorId:             event.host_id ?? undefined,
      city:                 event.city ?? null,
      capacity:             event.max_attendees ?? undefined,
      currentAttendees:     event.going_count ?? undefined,
      visibilityScope:      "public",
      qualityScore:         6,
      createdAt:            event.starts_at,
      attendingFriendCount: rsvpCount.get(event.id) ?? 0,
      data: {
        id:         event.id,
        title:      event.title,
        category:   event.category,
        startsAt:   event.starts_at,
        endsAt:     event.ends_at,
        city:       event.city,
        visibility: event.visibility,
        // REAL event location — only surface coordinates when the host has
        // opted to show the exact location; otherwise city-level only (same
        // privacy gate the events routes apply elsewhere in the app).
        lat:            event.show_exact_location !== false ? (event.location_lat ?? null) : null,
        lng:            event.show_exact_location !== false ? (event.location_lng ?? null) : null,
        locationName:   event.location_name ?? null,
        headerImageUrl: event.cover_url ?? null,
      },
    }));
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
      .select(
        "id, city, name, category, status, rating, created_at, submitted_by, " +
        "lat, lng, neighborhood, blurb, header_image_url, image_url",
      )
      .ilike("city", profile.currentCity)
      .eq("status", "active")
      .limit(MAX_PLACES);

    return ((data as any[]) ?? []).map((place): CompassItem => ({
      id:              `place:${place.id}`,
      type:            "place",
      title:           place.name ?? null,
      category:        place.category ?? "place",
      authorId:        place.submitted_by ?? undefined,
      contentBody:     place.name,
      interestTags:    [place.category].filter(Boolean),
      city:            place.city ?? null,
      qualityScore:    place.rating ? Math.min(10, (place.rating as number) * 2) : 5,
      visibilityScope: "public",
      createdAt:       place.created_at,
      // Place-affinity boost: the raw DB UUID (not the prefixed CompassItem id)
      // is what rank_events records as item_id for place_view events.
      placeId:         String(place.id),
      // Raw DB id stored in data so frontend can build the correct navigation path.
      // lat/lng/image/description are REAL venue data from discovery_places —
      // must be passed through so the client never has to fabricate/null them.
      data: {
        id:             String(place.id),
        name:           place.name,
        category:       place.category,
        city:           place.city,
        lat:            place.lat ?? null,
        lng:            place.lng ?? null,
        neighborhood:   place.neighborhood ?? null,
        description:    place.blurb ?? null,
        headerImageUrl: place.header_image_url ?? place.image_url ?? null,
      },
    }));
  } catch {
    return [];
  }
}

// ── Hidden gems ───────────────────────────────────────────────────────────────

async function fetchHiddenGems(
  db: SupabaseClient,
  profile: CompassProfile,
): Promise<CompassItem[]> {
  if (!profile.currentCity) return [];
  try {
    const { data } = await db
      .from("hidden_gems")
      .select("id, name, description, city, country, submitted_by, category, created_at")
      .ilike("city", profile.currentCity)
      .in("status", ["approved", "active"])
      .order("created_at", { ascending: false })
      .limit(MAX_HIDDEN_GEMS);

    return ((data as any[]) ?? []).map((gem): CompassItem => ({
      id:              `gem:${gem.id}`,
      type:            "hidden_gem",
      title:           gem.name ?? null,
      category:        gem.category ?? "hidden_gem",
      authorId:        gem.submitted_by ?? undefined,
      contentBody:     gem.name,
      interestTags:    [gem.category].filter(Boolean),
      city:            gem.city ?? null,
      country:         gem.country ?? null,
      qualityScore:    7,
      visibilityScope: "public",
      createdAt:       gem.created_at,
      // Place-affinity boost: the raw DB UUID drives the ×1.15 boost when the
      // viewer has recently viewed this gem's place page.
      placeId:         String(gem.id),
      // Raw DB id stored in data so frontend routes to /gems/:id correctly
      data: { id: String(gem.id), name: gem.name, category: gem.category, city: gem.city, country: gem.country },
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
  const [posts, buddies, places, events, hiddenGems] = await Promise.allSettled([
    fetchPosts(db, profile),
    fetchBuddies(db, profile),
    fetchPlaces(db, profile),
    fetchEvents(db, profile),
    fetchHiddenGems(db, profile),
  ]);

  const allItems: CompassItem[] = [
    ...(posts.status       === "fulfilled" ? posts.value       : []),
    ...(buddies.status     === "fulfilled" ? buddies.value     : []),
    ...(places.status      === "fulfilled" ? places.value      : []),
    ...(events.status      === "fulfilled" ? events.value      : []),
    ...(hiddenGems.status  === "fulfilled" ? hiddenGems.value  : []),
  ];

  // Exclude blocked users
  const blockedSet = new Set([...profile.blockedUserIds, ...profile.blockerUserIds]);
  return allItems.filter(
    (item) => !item.authorId || !blockedSet.has(item.authorId),
  );
}
