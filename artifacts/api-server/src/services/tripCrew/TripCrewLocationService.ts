/**
 * TripCrewLocationService
 *
 * Assembles the crew map for a trip by joining:
 *   - Accepted members list (trips + trip_members)
 *   - Per-user location preferences (trip_crew_location_preferences)
 *   - Current location (user_location_state — city/district always; lat/lng
 *     only forwarded to buildCrewCard when viewer has active live-share)
 *   - Location preferences (user_location_preferences — hotel_blur_enabled)
 *   - Plan check-in status (plan_checkins)
 *   - Safe Return active status (safe_return_sessions)
 *   - Active live-share sessions (trip_crew_location_sessions)
 *
 * buildCrewCard() enforces the privacy contract: exact coords are only
 * included in cards where the viewer has an active live-share grant from
 * that member AND hotel_blur_enabled is false.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCrewCard, type RawMemberLocation, type CrewMemberCard } from "../../lib/tripCrewLocation.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { nameVisibilitySet, presentedName } from "../../lib/publicIdentity.js";
import { fetchBlockedSet } from "../../lib/blocks.js";

const logger = rootLogger.child({ service: "TripCrewLocationService" });

// ── Public API ────────────────────────────────────────────────────────────────

export interface CrewMapResult {
  members: CrewMemberCard[];
  totalCount: number;
}

/**
 * Build the privacy-filtered crew map for a trip.
 * @param db        Service-role Supabase client
 * @param tripId    Target trip
 * @param viewerId  The user requesting the map (must be an accepted member)
 */
export async function getCrewMap(
  db: SupabaseClient,
  tripId: string,
  viewerId: string,
): Promise<CrewMapResult> {
  // 1. Load trip owner + accepted members
  const [ownerRes, membersRes] = await Promise.all([
    db.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
    db.from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .in("role", ["owner", "member", "invited"]),
  ]);

  const ownerId: string | null = (ownerRes.data as any)?.owner_id ?? null;
  const memberRows: any[] = (membersRes.data as any[]) ?? [];

  // Bidirectional block filter — enforced HERE on the server, not only in the
  // client. A blocked user hitting this endpoint directly must never receive a
  // crew member's area label or (with live-share) exact coordinates, and a
  // member the viewer blocked must not appear either. Fail-closed: if the block
  // list can't be read we return no members rather than risk a leak, mirroring
  // lib/mapTravelers' "never leak when block state is uncertain" contract.
  const blockedSet = await fetchBlockedSet(db, viewerId);
  if (blockedSet === null) {
    return { members: [], totalCount: 0 };
  }

  // Collect all user IDs (owner + accepted members + invited), excluding viewer
  // and anyone in a block relationship with the viewer.
  const allUserIds = Array.from(new Set([
    ...(ownerId ? [ownerId] : []),
    ...memberRows.map((r) => r.user_id),
  ])).filter((id) => id !== viewerId && !blockedSet.has(id));

  if (allUserIds.length === 0) {
    return { members: [], totalCount: 0 };
  }

  // 2. Load profiles for names/handles/avatars
  const profilesRes = await db
    .from("profiles")
    .select("id, display_name, name, full_name, username, avatar_url")
    .in("id", allUserIds);
  const profileMap = new Map<string, any>(
    ((profilesRes.data as any[]) ?? []).map((p) => [p.id, p]),
  );

  // 3. Load crew location preferences
  const prefsRes = await db
    .from("trip_crew_location_preferences")
    .select("user_id, default_visibility, ghost_mode_enabled, share_arrival_status, share_safe_return_status")
    .eq("trip_id", tripId)
    .in("user_id", allUserIds);
  const prefsMap = new Map<string, any>(
    ((prefsRes.data as any[]) ?? []).map((p) => [p.user_id, p]),
  );

  // 4a. Load user_location_state — always city/district; lat/lng fetched for
  //     privacy-guard to conditionally expose when live-share is active.
  const locationRes = await db
    .from("user_location_state")
    .select("user_id, city, district, country, updated_at, lat, lng")
    .in("user_id", allUserIds);
  const locationMap = new Map<string, any>(
    ((locationRes.data as any[]) ?? []).map((l) => [l.user_id, l]),
  );

  // 4b. Load canonical user_location_preferences for hotel/home blur flag
  const locPrefsRes = await db
    .from("user_location_preferences")
    .select("user_id, hotel_blur_enabled")
    .in("user_id", allUserIds);
  const hotelBlurSet = new Set<string>(
    ((locPrefsRes.data as any[]) ?? [])
      .filter((r) => r.hotel_blur_enabled === true)
      .map((r) => r.user_id),
  );

  // 5. Load plan check-ins for this trip
  const checkinsRes = await db
    .from("plan_checkins")
    .select("user_id, status")
    .eq("trip_id", tripId)
    .in("user_id", allUserIds);
  const checkinMap = new Map<string, string>(
    ((checkinsRes.data as any[]) ?? []).map((c) => [c.user_id, c.status]),
  );

  // 6. Load active safe-return sessions
  const srRes = await db
    .from("safe_return_sessions")
    .select("user_id")
    .in("user_id", allUserIds)
    .eq("status", "active");
  const activeSRSet = new Set<string>(
    ((srRes.data as any[]) ?? []).map((r) => r.user_id),
  );

  // 7. Load active live-share sessions visible to this viewer
  const now = new Date().toISOString();
  const liveShareRes = await db
    .from("trip_crew_location_sessions")
    .select("id, user_id, visibility_level, expires_at, allowed_member_ids")
    .eq("trip_id", tripId)
    .eq("status", "active")
    .gt("expires_at", now);
  const liveShareMap = new Map<string, any>();
  for (const row of ((liveShareRes.data as any[]) ?? [])) {
    const allowed: string[] = row.allowed_member_ids ?? [];
    if (allowed.includes(viewerId)) {
      liveShareMap.set(row.user_id, row);
    }
  }

  // Universal display-name rule: crew members show real names only when
  // opted in (viewer is already excluded from allUserIds above).
  const allowedCrewNames = await nameVisibilitySet(db, allUserIds);

  // 8. Build cards
  const cards: CrewMemberCard[] = allUserIds.map((uid) => {
    const profile = profileMap.get(uid);
    const prefs = prefsMap.get(uid);
    const loc = locationMap.get(uid);
    const liveShare = liveShareMap.get(uid) ?? null;
    const hotelBlur = hotelBlurSet.has(uid);

    const raw: RawMemberLocation = {
      userId: uid,
      name: presentedName(profile, allowedCrewNames.has(uid)),
      handle: profile?.username ?? null,
      avatarUrl: profile?.avatar_url ?? null,
      prefs: prefs ? {
        defaultVisibility: prefs.default_visibility ?? "city_only",
        ghostModeEnabled: Boolean(prefs.ghost_mode_enabled),
        shareArrivalStatus: prefs.share_arrival_status !== false,
        shareSafeReturnStatus: Boolean(prefs.share_safe_return_status),
      } : null,
      locationState: loc ? {
        city: loc.city ?? null,
        district: loc.district ?? null,
        country: loc.country ?? null,
        updatedAt: loc.updated_at ?? null,
        // lat/lng are forwarded; buildCrewCard only uses them when live-share is active
        lat: loc.lat ?? null,
        lng: loc.lng ?? null,
      } : null,
      hotelBlurEnabled: hotelBlur,
      checkInStatus: checkinMap.get(uid) ?? null,
      hasSafeReturnActive: activeSRSet.has(uid),
      liveShare: liveShare ? {
        id: liveShare.id,
        visibilityLevel: liveShare.visibility_level,
        expiresAt: liveShare.expires_at,
      } : null,
    };

    return buildCrewCard(raw);
  });

  return { members: cards, totalCount: cards.length };
}

/**
 * Get or create the calling user's crew location preferences for a trip.
 */
export async function getCrewPreferences(
  db: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<{
  defaultVisibility: string;
  ghostModeEnabled: boolean;
  shareArrivalStatus: boolean;
  shareSafeReturnStatus: boolean;
  updatedAt: string | null;
}> {
  const { data } = await db
    .from("trip_crew_location_preferences")
    .select("default_visibility, ghost_mode_enabled, share_arrival_status, share_safe_return_status, updated_at")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();

  const row = data as any;
  return {
    defaultVisibility: row?.default_visibility ?? "city_only",
    ghostModeEnabled: Boolean(row?.ghost_mode_enabled),
    shareArrivalStatus: row?.share_arrival_status !== false,
    shareSafeReturnStatus: Boolean(row?.share_safe_return_status),
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * Upsert crew location preferences. Returns true on success.
 */
export async function upsertCrewPreferences(
  db: SupabaseClient,
  tripId: string,
  userId: string,
  patch: {
    defaultVisibility?: string;
    ghostModeEnabled?: boolean;
    shareArrivalStatus?: boolean;
    shareSafeReturnStatus?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const record: Record<string, unknown> = {
    trip_id: tripId,
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  if (patch.defaultVisibility !== undefined) record.default_visibility = patch.defaultVisibility;
  if (patch.ghostModeEnabled !== undefined) record.ghost_mode_enabled = patch.ghostModeEnabled;
  if (patch.shareArrivalStatus !== undefined) record.share_arrival_status = patch.shareArrivalStatus;
  if (patch.shareSafeReturnStatus !== undefined) record.share_safe_return_status = patch.shareSafeReturnStatus;

  const { error } = await db
    .from("trip_crew_location_preferences")
    .upsert(record, { onConflict: "trip_id,user_id" });

  if (error) {
    logger.error({ err: error, tripId, userId }, "upsertCrewPreferences: failed");
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Toggle ghost mode for a user in a trip.
 */
export async function setGhostMode(
  db: SupabaseClient,
  tripId: string,
  userId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return upsertCrewPreferences(db, tripId, userId, { ghostModeEnabled: enabled });
}
