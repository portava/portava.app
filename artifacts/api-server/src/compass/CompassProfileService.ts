/**
 * CompassProfileService
 *
 * Builds and caches a user's intelligence profile by joining:
 *   - profiles (languages, budget_style, travel_styles, etc.)
 *   - trust_profiles (overall_score, public_level)
 *   - user_preference_profiles (preferred cities from explicit_preferences_json)
 *   - user_location_state (current city/country)
 *   - location_preferences (visibility/safety preferences)
 *   - blocks (blockedUserIds, blockerUserIds, block/blocker counts)
 *   - trips + trip_members (hasActiveTrip, upcomingTripWithin48h, hasFutureTripScheduled)
 *   - rent_buddy_bookings (hasActiveBooking)
 *   - safe_return_sessions (safeReturnActive)
 *
 * Cache: 2 minutes per user. Invalidated immediately on block/report/safety changes.
 *
 * Blocked-user exclusion: blockedUserIds and blockerUserIds are populated so that
 * downstream Compass phases (scoring, feed building) can exclude those users entirely.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";
import { getDecayedWeights } from "./CompassSearchDecayService.js";

const CACHE_TTL_MS = 2 * 60 * 1_000; // 2 minutes
const FUTURE_WINDOW_48H_MS = 48 * 60 * 60 * 1_000;

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

/** Safely parse JSON, returning null on failure. */
function safeJson(raw: unknown): any {
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Build a CompassProfile for the given user from multiple table joins. */
async function buildProfile(
  db: SupabaseClient,
  userId: string,
): Promise<CompassProfile> {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // ── Trips: two-step to avoid invalid PostgREST subquery syntax ────────────
  // Step 1: find trip_ids where user is a member (owner or accepted member)
  const tripMemberRes = await db
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", userId)
    .in("role", ["owner", "member"]);

  const memberTripIds: string[] = (tripMemberRes.data as any[] ?? []).map(
    (r: any) => r.trip_id as string,
  );

  // Step 2: fetch owned trips + member trips in parallel
  const [ownedTripsRes, memberTripsRes, ...otherResults] = await Promise.allSettled([
    db.from("trips")
      .select("id, start_date, end_date, status")
      .eq("owner_id", userId),
    memberTripIds.length > 0
      ? db.from("trips")
          .select("id, start_date, end_date, status")
          .in("id", memberTripIds)
      : Promise.resolve({ data: [], error: null }),
    // All other reads
    db.from("profiles")
      .select("spoken_languages, default_language, budget_style, travel_styles, travel_group_style, travel_pace")
      .eq("id", userId)
      .maybeSingle(),
    db.from("trust_profiles")
      .select("overall_score, public_level")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("user_preference_profiles")
      .select("explicit_preferences_json, inferred_preferences_json")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("user_location_state")
      .select("city, country")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("user_location_preferences")
      .select("location_mode, sharing_paused, safe_return_enabled")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("blocks")
      .select("blocked_id")
      .eq("blocker_id", userId),
    db.from("blocks")
      .select("blocker_id")
      .eq("blocked_id", userId),
    db.from("safe_return_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1),
    db.from("rent_buddy_bookings")
      .select("id")
      .eq("traveler_id", userId)
      .in("status", ["confirmed", "in_progress"])
      .limit(1),
    db.from("compass_user_preferences")
      .select("category_weights, ignored_item_ids, muted_hashtags")
      .eq("user_id", userId)
      .maybeSingle(),
    db.from("user_mutes")
      .select("muted_id")
      .eq("muter_id", userId),
  ]);

  // Destructure the other results (indices offset by 2 for ownedTrips + memberTrips)
  const [
    profileRes,
    trustRes,
    prefProfileRes,
    locStateRes,
    locPrefRes,
    blockSentRes,
    blockRecvRes,
    safeReturnRes,
    bookingRes,
    compassPrefsRes,
    mutesRes,
  ] = otherResults;

  // ── Trips aggregation ──────────────────────────────────────────────────────
  const ownedTrips  = ownedTripsRes.status  === "fulfilled" ? ((ownedTripsRes.value.data as any[]) ?? []) : [];
  const memberTrips = memberTripsRes.status === "fulfilled" ? ((memberTripsRes.value.data as any[]) ?? []) : [];
  // Deduplicate by id (a user can appear as owner in trip_members too)
  const tripMap = new Map<string, any>();
  for (const t of [...ownedTrips, ...memberTrips]) tripMap.set(t.id, t);
  const trips = Array.from(tripMap.values());

  let hasActiveTrip = false;
  let upcomingTripWithin48h = false;
  let hasFutureTripScheduled = false;

  for (const t of trips) {
    const start = t.start_date ? new Date(t.start_date).getTime() : null;
    const end   = t.end_date   ? new Date(t.end_date).getTime()   : null;
    if (start !== null && end !== null && nowMs >= start && nowMs <= end) {
      hasActiveTrip = true;
    }
    if (start !== null && start > nowMs) {
      if (start - nowMs <= FUTURE_WINDOW_48H_MS) {
        upcomingTripWithin48h = true;
      } else {
        hasFutureTripScheduled = true;
      }
    }
  }

  // ── Other data ─────────────────────────────────────────────────────────────
  const profile    = profileRes.status    === "fulfilled" ? (profileRes.value.data as any) : null;
  const trust      = trustRes.status      === "fulfilled" ? (trustRes.value.data as any) : null;
  const prefProf   = prefProfileRes.status === "fulfilled" ? (prefProfileRes.value.data as any) : null;
  const locState   = locStateRes.status   === "fulfilled" ? (locStateRes.value.data as any) : null;
  const locPref    = locPrefRes.status    === "fulfilled" ? (locPrefRes.value.data as any) : null;
  const blocksSent = blockSentRes.status  === "fulfilled" ? ((blockSentRes.value.data as any[]) ?? []) : [];
  const blocksRecv = blockRecvRes.status  === "fulfilled" ? ((blockRecvRes.value.data as any[]) ?? []) : [];
  const safeReturn    = safeReturnRes.status    === "fulfilled" ? ((safeReturnRes.value.data as any[]) ?? [])  : [];
  const bookings      = bookingRes.status       === "fulfilled" ? ((bookingRes.value.data as any[]) ?? [])      : [];
  const compassPrefs  = compassPrefsRes?.status === "fulfilled" ? (compassPrefsRes.value.data as any)           : null;
  const mutedRows     = mutesRes?.status       === "fulfilled" ? ((mutesRes.value.data  as any[]) ?? [])        : [];

  // Fail-CLOSED on the safety-critical lists. blocksSent/blocksRecv/mutedRows
  // feed the feed's block/mute exclusion. supabase-js RESOLVES with
  // { data:null, error } on a query error, so the `?? []` above silently turns a
  // failed load into an EMPTY exclusion list — disabling block/mute filtering
  // and surfacing a blocked user's content. If any safety-list load errored,
  // refuse to build the profile rather than serve one that can leak.
  const safetyListErrored =
    blockSentRes.status === "rejected" || (blockSentRes.status === "fulfilled" && (blockSentRes.value as any).error) ||
    blockRecvRes.status === "rejected" || (blockRecvRes.status === "fulfilled" && (blockRecvRes.value as any).error) ||
    (mutesRes ? (mutesRes.status === "rejected" || (mutesRes.status === "fulfilled" && (mutesRes.value as any).error)) : false);
  if (safetyListErrored) {
    throw new Error("CompassProfileService: block/mute safety-list load failed — failing closed");
  }

  // ── Languages ──────────────────────────────────────────────────────────────
  const languages: string[] = [];
  if (profile?.spoken_languages) languages.push(...profile.spoken_languages);
  if (profile?.default_language && !languages.includes(profile.default_language)) {
    languages.push(profile.default_language);
  }

  // ── Preferred cities from user_preference_profiles ────────────────────────
  // explicit_preferences_json may contain { interests, foodPreferences, ... }
  // We also check inferred for city preferences if available.
  const explicitPrefs = safeJson(prefProf?.explicit_preferences_json);
  const inferredPrefs = safeJson(prefProf?.inferred_preferences_json);
  const preferredCities: string[] = [];
  if (Array.isArray(explicitPrefs?.preferredCities)) {
    preferredCities.push(...explicitPrefs.preferredCities);
  }
  if (Array.isArray(inferredPrefs?.preferredCities)) {
    for (const c of inferredPrefs.preferredCities) {
      if (!preferredCities.includes(c)) preferredCities.push(c);
    }
  }

  // ── Safety / visibility from location_preferences ────────────────────────
  const safetyPref: 'standard' | 'cautious' | 'relaxed' =
    locPref?.safe_return_enabled ? 'cautious' : 'standard';

  const visPref: 'public' | 'semi_private' | 'private' =
    locPref?.sharing_paused
      ? 'private'
      : locPref?.location_mode === 'precise'
        ? 'public'
        : 'semi_private';

  // ── Block arrays for downstream exclusion ─────────────────────────────────
  const blockedUserIds: string[] = blocksSent.map((r: any) => r.blocked_id as string);
  const blockerUserIds: string[] = blocksRecv.map((r: any) => r.blocker_id as string);
  const mutedUserIds:   string[] = mutedRows.map((r: any) => r.muted_id as string);

  return {
    userId,
    preferredCities,
    preferredLanguages: languages.filter(Boolean),
    budgetStyle: profile?.budget_style ?? null,
    travelStyles: Array.isArray(profile?.travel_styles) ? profile.travel_styles : [],
    socialStyle: profile?.travel_group_style ?? null,
    safetyPreference: safetyPref,
    visibilityPreference: visPref,
    blockedUserIds,
    blockerUserIds,
    mutedUserIds,
    blockCount: blockedUserIds.length,
    blockerCount: blockerUserIds.length,
    trustScore: trust?.overall_score ?? null,
    trustLevel: trust?.public_level ?? null,
    activeUserScore: null, // Phase 4 (active user scoring) populates this
    hasActiveTrip,
    hasActiveBooking: bookings.length > 0,
    upcomingTripWithin48h,
    hasFutureTripScheduled,
    currentCity: locState?.city ?? null,
    currentCountry: locState?.country ?? null,
    safeReturnActive: safeReturn.length > 0,
    categoryWeights: await getDecayedWeights(
      db,
      userId,
      (compassPrefs?.category_weights as Record<string, number>) ?? {},
    ),
    ignoredItemIds:  (compassPrefs?.ignored_item_ids as string[]) ?? [],
    mutedHashtags:   (compassPrefs?.muted_hashtags as string[]) ?? [],
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
