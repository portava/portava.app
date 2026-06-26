/**
 * CompassProfileService
 *
 * Builds and caches a user's intelligence profile by joining:
 *   - profiles (languages, budget_style, travel_styles, etc.)
 *   - trust_profiles (overall_score, public_level)
 *   - user_preference_profiles (preferences snapshot)
 *   - user_location_state (current city/country)
 *   - location_preferences (visibility/safety preferences)
 *   - blocks (block_count, blocker_count)
 *   - trips (has_active_trip, upcoming_trip_within_48h)
 *   - rent_buddy_bookings (has_active_booking)
 *   - safe_return_sessions (safe_return_active)
 *
 * Cache: 2 minutes per user. Invalidated immediately on block/report/safety changes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";

const CACHE_TTL_MS = 2 * 60 * 1_000; // 2 minutes

interface CacheEntry {
  profile: CompassProfile;
  cachedAt: number;
}

const _cache = new Map<string, CacheEntry>();

/** Evict a user's cached profile (call after block/report/safety changes). */
export function invalidateCompassProfile(userId: string): void {
  _cache.delete(userId);
}

/** Evict all cached profiles (useful in tests). */
export function clearCompassProfileCache(): void {
  _cache.clear();
}

/** Build a CompassProfile for the given user from multiple table joins. */
async function buildProfile(
  db: SupabaseClient,
  userId: string,
): Promise<CompassProfile> {
  const now = new Date();
  const nowIso = now.toISOString();

  // Run all reads in parallel — non-fatal if any individual table is missing.
  const [
    profileRes,
    trustRes,
    locStateRes,
    locPrefRes,
    blockSentRes,
    blockRecvRes,
    tripsRes,
    safeReturnRes,
    bookingRes,
  ] = await Promise.allSettled([
    db.from("profiles")
      .select("spoken_languages, default_language, budget_style, travel_styles, travel_group_style, travel_pace")
      .eq("id", userId)
      .maybeSingle(),
    db.from("trust_profiles")
      .select("overall_score, public_level")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("user_location_state")
      .select("city, country")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("location_preferences")
      .select("location_mode, sharing_paused, safe_return_enabled")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("blocks")
      .select("id")
      .eq("blocker_id", userId),
    db.from("blocks")
      .select("id")
      .eq("blocked_id", userId),
    db.from("trips")
      .select("id, start_date, end_date, status")
      .or(`owner_id.eq.${userId},id.in.(select trip_id from trip_members where user_id=eq.${userId} and role=in.(owner,member))`),
    db.from("safe_return_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1),
    db.from("rent_buddy_bookings")
      .select("id")
      .eq("traveler_id", userId)
      .eq("status", "active")
      .limit(1),
  ]);

  const profile     = profileRes.status === "fulfilled" ? (profileRes.value.data as any) : null;
  const trust       = trustRes.status === "fulfilled"   ? (trustRes.value.data as any) : null;
  const locState    = locStateRes.status === "fulfilled" ? (locStateRes.value.data as any) : null;
  const locPref     = locPrefRes.status === "fulfilled"  ? (locPrefRes.value.data as any) : null;
  const blocksSent  = blockSentRes.status === "fulfilled" ? ((blockSentRes.value.data as any[]) ?? []) : [];
  const blocksRecv  = blockRecvRes.status === "fulfilled" ? ((blockRecvRes.value.data as any[]) ?? []) : [];
  const trips       = tripsRes.status === "fulfilled" ? ((tripsRes.value.data as any[]) ?? []) : [];
  const safeReturn  = safeReturnRes.status === "fulfilled" ? ((safeReturnRes.value.data as any[]) ?? []) : [];
  const bookings    = bookingRes.status === "fulfilled" ? ((bookingRes.value.data as any[]) ?? []) : [];

  // ── Trip signals ───────────────────────────────────────────────────────────
  const nowMs = now.getTime();
  const h48Ms = 48 * 60 * 60 * 1_000;

  let hasActiveTrip = false;
  let upcomingTripWithin48h = false;

  for (const t of trips) {
    const start = t.start_date ? new Date(t.start_date).getTime() : null;
    const end   = t.end_date   ? new Date(t.end_date).getTime()   : null;
    if (start !== null && end !== null && nowMs >= start && nowMs <= end) {
      hasActiveTrip = true;
    }
    if (start !== null && start > nowMs && start - nowMs <= h48Ms) {
      upcomingTripWithin48h = true;
    }
  }

  // ── Profile fields ─────────────────────────────────────────────────────────
  const languages: string[] = [];
  if (profile?.spoken_languages) languages.push(...profile.spoken_languages);
  if (profile?.default_language && !languages.includes(profile.default_language)) {
    languages.push(profile.default_language);
  }

  const safetyPref: 'standard' | 'cautious' | 'relaxed' =
    locPref?.safe_return_enabled ? 'cautious' : 'standard';

  const visPref: 'public' | 'semi_private' | 'private' =
    locPref?.sharing_paused
      ? 'private'
      : locPref?.location_mode === 'precise'
        ? 'public'
        : 'semi_private';

  return {
    userId,
    preferredCities: [],
    preferredLanguages: languages.filter(Boolean),
    budgetStyle: profile?.budget_style ?? null,
    travelStyles: Array.isArray(profile?.travel_styles) ? profile.travel_styles : [],
    socialStyle: profile?.travel_group_style ?? null,
    safetyPreference: safetyPref,
    visibilityPreference: visPref,
    blockCount: blocksSent.length,
    blockerCount: blocksRecv.length,
    trustScore: trust?.overall_score ?? null,
    trustLevel: trust?.public_level ?? null,
    activeUserScore: null,
    hasActiveTrip,
    hasActiveBooking: bookings.length > 0,
    upcomingTripWithin48h,
    currentCity: locState?.city ?? null,
    currentCountry: locState?.country ?? null,
    safeReturnActive: safeReturn.length > 0,
    computedAt: nowIso,
  };
}

/**
 * Get the Compass profile for a user, using cache when fresh.
 * Pass `forceRefresh = true` to bypass cache (e.g., after a block change).
 */
export async function getCompassProfile(
  db: SupabaseClient,
  userId: string,
  forceRefresh = false,
): Promise<CompassProfile> {
  if (!forceRefresh) {
    const cached = _cache.get(userId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.profile;
    }
  }
  const profile = await buildProfile(db, userId);
  _cache.set(userId, { profile, cachedAt: Date.now() });
  return profile;
}
