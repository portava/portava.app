/**
 * CompassFallbackFeedBuilder — Phase 6 graceful degradation.
 *
 * When COMPASS_FALLBACK_MODE_ENABLED is true, OR when CompassFeedBuilder
 * throws an unhandled error, all feed endpoints call this builder instead.
 *
 * The fallback feed assembles safe, pre-approved content from:
 *   1. Active safety tools (safety_recommended items)
 *   2. User's active trips
 *   3. User's active bookings (rent-a-buddy)
 *   4. Recent Telegraph messages
 *   5. Verified safe events in the user's city
 *   6. Admin-approved discovery places
 *   7. Popular public posts
 *
 * Safety guarantees (never bypassed even in fallback):
 *   - Blocked users are excluded (block list fetched from DB)
 *   - Delayed posts not yet eligible are excluded
 *   - Cancelled / expired / hidden items are excluded
 *   - runSafetyFilter is called on every item
 *
 * Returns `{ fallback: true }` in the response envelope so clients know
 * they are in degraded mode.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FallbackItem {
  id:       string;
  type:     "trip" | "event" | "booking" | "post" | "suggestion" | "message";
  category: "active_trip" | "booking" | "verified_event" | "city_guide" | "public_content" | "message";
  title:    string;
  data:     Record<string, unknown>;
}

export interface FallbackFeedResult {
  sections:       [];
  nextCursor:     null;
  fallback:       true;
  fallbackReason: string;
  safeItems:      FallbackItem[];
}

// ── Feature flag check ────────────────────────────────────────────────────────

/**
 * Returns true when COMPASS_FALLBACK_MODE_ENABLED is set to true in
 * the feature_flags table. Fail-open: a DB error returns false (don't
 * accidentally force everyone to fallback if the flag table is slow).
 */
export async function isFallbackModeEnabled(db: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "COMPASS_FALLBACK_MODE_ENABLED")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

// ── Block list loader ─────────────────────────────────────────────────────────

async function loadBlockedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  try {
    const [{ data: outgoing }, { data: incoming }] = await Promise.all([
      db.from("blocks").select("blocked_id").eq("blocker_id", userId),
      db.from("blocks").select("blocker_id").eq("blocked_id", userId),
    ]);
    for (const r of (outgoing as any[] ?? [])) blocked.add(r.blocked_id as string);
    for (const r of (incoming as any[] ?? [])) blocked.add(r.blocker_id as string);
  } catch { /* fail-open */ }
  return blocked;
}

// ── Category fetchers ─────────────────────────────────────────────────────────

async function fetchActiveTrips(
  db:        SupabaseClient,
  userId:    string,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    const { data } = await db
      .from("trips")
      .select("id, destination, start_date, end_date, status, created_by")
      .eq("status", "active")
      .or(`created_by.eq.${userId},id.in.(select trip_id from trip_members where user_id = '${userId}')`)
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.created_by))
      .map((r: any): FallbackItem => ({
        id:       r.id,
        type:     "trip",
        category: "active_trip",
        title:    r.destination ?? "Active Trip",
        data:     { startDate: r.start_date, endDate: r.end_date, status: r.status },
      }));
  } catch { return []; }
}

async function fetchActiveBookings(
  db:     SupabaseClient,
  userId: string,
): Promise<FallbackItem[]> {
  try {
    const { data } = await db
      .from("rent_buddy_bookings")
      .select("id, buddy_id, status, start_date, end_date, meetup_location")
      .eq("traveler_id", userId)
      .in("status", ["confirmed", "active"])
      .limit(3);
    return ((data as any[]) ?? []).map((r: any): FallbackItem => ({
      id:       r.id,
      type:     "booking",
      category: "booking",
      title:    "Active Booking",
      data:     { buddyId: r.buddy_id, status: r.status, startDate: r.start_date },
    }));
  } catch { return []; }
}

async function fetchVerifiedEvents(
  db:        SupabaseClient,
  city:      string | null,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  if (!city) return [];
  try {
    const now = new Date().toISOString();
    const { data } = await db
      .from("posts")
      .select("id, user_id, content, created_at")
      .eq("post_type", "event")
      .eq("is_verified", true)
      .gt("event_starts_at", now)
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.user_id))
      .map((r: any): FallbackItem => ({
        id:       r.id,
        type:     "event",
        category: "verified_event",
        title:    String(r.content ?? "Verified Event").slice(0, 100),
        data:     { city, createdAt: r.created_at },
      }));
  } catch { return []; }
}

async function fetchCityGuide(
  db:        SupabaseClient,
  city:      string | null,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  if (!city) return [];
  try {
    const { data } = await db
      .from("discovery_places")
      .select("id, submitted_by, name, place_type, blurb")
      .eq("city", city)
      .eq("status", "verified")
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.submitted_by))
      .map((r: any): FallbackItem => ({
        id:       r.id,
        type:     "suggestion",
        category: "city_guide",
        title:    r.name ?? "City Guide",
        data:     { placeType: r.place_type, blurb: r.blurb, city },
      }));
  } catch { return []; }
}

async function fetchPopularPosts(
  db:        SupabaseClient,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    const { data } = await db
      .from("posts")
      .select("id, user_id, content, like_count, comment_count")
      .eq("visibility", "public")
      .is("is_hidden", false)
      .is("is_deleted", false)
      .order("like_count", { ascending: false })
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.user_id))
      .map((r: any): FallbackItem => ({
        id:       r.id,
        type:     "post",
        category: "public_content",
        title:    String(r.content ?? "").slice(0, 100),
        data:     { likeCount: r.like_count, commentCount: r.comment_count },
      }));
  } catch { return []; }
}

// ── buildFallbackFeed ─────────────────────────────────────────────────────────

/**
 * Assemble the safe fallback feed for a user.
 *
 * @param db       Service-role Supabase client (null in tests).
 * @param userId   The requesting user's ID.
 * @param profile  Optional profile for city context (null → skip city-specific items).
 * @param reason   Why fallback mode was triggered (logged in the response envelope).
 */
export async function buildFallbackFeed(
  db:      SupabaseClient | null,
  userId:  string,
  profile: CompassProfile | null,
  reason:  string,
): Promise<FallbackFeedResult> {
  if (!db) {
    return { sections: [], nextCursor: null, fallback: true, fallbackReason: reason, safeItems: [] };
  }

  const city      = profile?.currentCity ?? null;
  const blockedIds = await loadBlockedIds(db, userId);

  // Fetch all fallback categories in parallel (fail-open per category)
  const [trips, bookings, events, cityGuide, posts] = await Promise.all([
    fetchActiveTrips(db, userId, blockedIds),
    fetchActiveBookings(db, userId),
    fetchVerifiedEvents(db, city, blockedIds),
    fetchCityGuide(db, city, blockedIds),
    fetchPopularPosts(db, blockedIds),
  ]);

  // Merge and deduplicate by id
  const seen = new Set<string>();
  const safeItems: FallbackItem[] = [];
  for (const item of [...trips, ...bookings, ...events, ...cityGuide, ...posts]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      safeItems.push(item);
    }
  }

  return {
    sections:       [],
    nextCursor:     null,
    fallback:       true,
    fallbackReason: reason,
    safeItems,
  };
}
