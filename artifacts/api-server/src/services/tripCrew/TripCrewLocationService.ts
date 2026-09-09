/**
 * TripCrewLocationService
 *
 * Assembles the crew map for a trip by joining:
 *   - Accepted members list (trips + trip_members)
 *   - Per-user location preferences (trip_crew_location_preferences)
 *   - Current location (user_location_state — city/district always; lat/lng
 *     only forwarded to buildCrewCard when viewer has active live-share)
 *   - Location preferences (location_preferences — hotel_blur_enabled)
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

/**
 * Refusal for a crew-map input that could not be READ.
 *
 * supabase-js RESOLVES on a database error — `{ data: null, error: {...} }` —
 * so a table that could not be read is byte-for-byte indistinguishable from an
 * empty one at the call site. Every "no rows" default in getCrewMap below is
 * therefore also the DB-error default, and three of them defaulted toward
 * DISCLOSURE: no prefs row means ghost mode off, no location_preferences row
 * means hotel blur off, no trip_members rows means the crew is just its owner.
 *
 * `status` and `code` are read by the global error handler (lib/errorEnvelope),
 * so throwing this becomes 503 `degraded_unavailable` with `retryable: true` —
 * the code this codebase uses for "the check could not be PERFORMED", as
 * opposed to db_error (500) which reads as "your request was wrong or we broke".
 */
export class CrewMapUnavailableError extends Error {
  readonly status = 503;
  readonly code = "degraded_unavailable" as const;
  readonly table: string;
  constructor(table: string, detail: string) {
    super(`crew map input ${table} unavailable — refusing to answer: ${detail}`);
    this.name = "CrewMapUnavailableError";
    this.table = table;
  }
}

function crewMapUnavailable(table: string, error: any): CrewMapUnavailableError {
  return new CrewMapUnavailableError(table, String(error?.message ?? error?.code ?? "db_error"));
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface CrewMapResult {
  /**
   * True when `plan_checkins` could not be read. Every card's
   * `planCheckInStatus` is then `null`, which renders as "has not arrived" —
   * a claim about a person made from a query that failed. A caller that shows
   * arrival state MUST show "unknown" instead when this is true.
   */
  checkInsUnreadable?: boolean;
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
      .select("user_id, status")
      .eq("trip_id", tripId)
      .in("role", ["owner", "member", "invited"]),
  ]);

  // REFUSE, do not shrink. An unreadable trip_members returned `[]`, which this
  // function renders as "the crew is the owner and nobody else" — a confident
  // claim about who is on the trip, assembled from a query that did not answer.
  // Fail-closed-with-partial-data is not available here: the roster IS the
  // response.
  if (membersRes.error) throw crewMapUnavailable("trip_members", membersRes.error);
  if (ownerRes.error) throw crewMapUnavailable("trips", ownerRes.error);

  const ownerId: string | null = (ownerRes.data as any)?.owner_id ?? null;
  // trip_members.status ('invited','accepted','declined','removed','left' —
  // migration 0078) is the other half of membership, and the role column does
  // not change when someone is removed. Filtering on role alone published a
  // REMOVED member's area label — and, under an active live share, their exact
  // coordinates — to the crew of a trip they are no longer on. 'invited' stays
  // in: this map deliberately shows pending invitees.
  const memberRows: any[] = ((membersRes.data as any[]) ?? []).filter((r) => {
    const status = (r as any).status;
    return status == null || status === "accepted" || status === "invited";
  });

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
  // REFUSE. Every card on the map is a person, and a card with no profile is
  // an anonymous pin next to a location — the crew is shown WHERE somebody is
  // without being told WHO. There is no honest sub-part of that to serve.
  if (profilesRes.error) throw crewMapUnavailable("profiles", profilesRes.error);
  const profileMap = new Map<string, any>(
    ((profilesRes.data as any[]) ?? []).map((p) => [p.id, p]),
  );

  // 3. Load crew location preferences
  const prefsRes = await db
    .from("trip_crew_location_preferences")
    .select("user_id, default_visibility, ghost_mode_enabled, share_arrival_status, share_safe_return_status")
    .eq("trip_id", tripId)
    .in("user_id", allUserIds);
  // REFUSE. This row is each member's OWN answer to "what may the crew see of
  // me on this trip", and buildCrewCard reads a missing row as ghost mode OFF.
  // So an unreadable table silently inverted the one setting the module calls
  // an absolute choice: a member with ghost mode on and an active live share
  // came back as `ghostMode:false, statusLabel:"live_sharing_active"` with an
  // area label. Unlike the hotel-blur read below, this one governs EVERY card's
  // disclosure level, so there is no honest sub-part of the response left to
  // serve — the request is refused instead.
  if (prefsRes.error) throw crewMapUnavailable("trip_crew_location_preferences", prefsRes.error);
  const prefsMap = new Map<string, any>(
    ((prefsRes.data as any[]) ?? []).map((p) => [p.user_id, p]),
  );

  // 4a. Load user_location_state — always city/district; lat/lng fetched for
  //     privacy-guard to conditionally expose when live-share is active.
  const locationRes = await db
    .from("user_location_state")
    .select("user_id, city, district, country, updated_at, lat, lng")
    .in("user_id", allUserIds);
  // REFUSE. This IS the map. An unreadable location table produced a full crew
  // map on which every member had no location — indistinguishable from a crew
  // that has genuinely shared nothing, and the more alarming reading of the two
  // when someone is looking for a person.
  if (locationRes.error) throw crewMapUnavailable("user_location_state", locationRes.error);
  const locationMap = new Map<string, any>(
    ((locationRes.data as any[]) ?? []).map((l) => [l.user_id, l]),
  );

  // 4b. Load location_preferences for hotel/home blur flag
  const locPrefsRes = await db
    .from("location_preferences")
    .select("user_id, hotel_blur_enabled")
    .in("user_id", allUserIds);
  // FAIL CLOSED AT THE FIELD, don't refuse the request. hotel_blur_enabled
  // gates one thing and one thing only: the exact-coordinate upgrade inside an
  // already-granted live share. An empty set means "nobody blurs", and that was
  // also what a DB error produced — so an unreadable location_preferences
  // published exact lat/lng for a member whose setting says never to. Treating
  // every member as blurred when the table cannot be read withholds the
  // strongest claim in the payload and leaves the rest of the map (area labels,
  // check-ins, freshness) intact and true, which a 503 would not.
  const hotelBlurUnreadable = Boolean(locPrefsRes.error);
  if (hotelBlurUnreadable) {
    logger.warn(
      { err: locPrefsRes.error, tripId },
      "getCrewMap: location_preferences unreadable — withholding exact coordinates for every member",
    );
  }
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
  // FAIL CLOSED AT THE FIELD, like the hotel blur above rather than like the
  // refusals. A check-in status governs one badge; an unreadable table used to
  // produce `planCheckInStatus: null`, which renders as "has not arrived" — a
  // claim about a person, made from a query that failed. `null` is kept, and
  // `checkInsUnreadable` travels with the response so the caller can render
  // "unknown" instead of "not arrived".
  const checkInsUnreadable = Boolean(checkinsRes.error);
  if (checkInsUnreadable) {
    logger.warn({ err: checkinsRes.error, tripId },
      "getCrewMap: plan_checkins unreadable — arrival status is UNKNOWN, not 'not arrived'");
  }
  const checkinMap = new Map<string, string>(
    ((checkinsRes.data as any[]) ?? []).map((c) => [c.user_id, c.status]),
  );

  // 6. Load active safe-return sessions
  const srRes = await db
    .from("safe_return_sessions")
    .select("user_id")
    .in("user_id", allUserIds)
    .eq("status", "active");
  // REFUSE. This is the safety-critical one. An unreadable table produced
  // `hasSafeReturnActive: false` for everybody, so the crew was told NOBODY is
  // on an active Safe Return walk home when the truth was "we could not look".
  // That is the one wrong answer on this map that could stop someone checking
  // on a person who needed it, and there is no degraded version of it worth
  // serving.
  if (srRes.error) throw crewMapUnavailable("safe_return_sessions", srRes.error);
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
  // REFUSE. An unreadable session table means every live share disappears, so
  // a viewer who HAS been granted one sees the sharer as not sharing. That is
  // the same class as the preference refusal above: the row decides each
  // card's disclosure level, and getting it wrong understates what the viewer
  // is entitled to see while looking exactly like the truth.
  if (liveShareRes.error) throw crewMapUnavailable("trip_crew_location_sessions", liveShareRes.error);
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
      hotelBlurEnabled: hotelBlurUnreadable || hotelBlur,
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

  return { members: cards, totalCount: cards.length, checkInsUnreadable };
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
  // FAIL-CLOSED. This read USED to leave `error` unbound, which made an
  // UNREADABLE preference row indistinguishable from an ABSENT one — and the
  // defaults for "absent" are the SHARING defaults. A user with ghost mode ON
  // was shown "ghost mode off, sharing city" on their own privacy screen, and
  // would have had no reason to doubt it.
  //
  // services/airport/LayoverPrivacyGuard.ts had already found this, written it
  // down, and left it as out of that lane's ownership. It is fixed here.
  //
  // A failure THROWS: the route (routes/tripCrewLocation.ts) already catches
  // and answers db_error, which is the honest answer to "we could not read your
  // privacy settings". Returning a default would be answering a question about
  // consent with a guess.
  const { data, error } = await db
    .from("trip_crew_location_preferences")
    .select("default_visibility, ghost_mode_enabled, share_arrival_status, share_safe_return_status, updated_at")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`trip_crew_location_preferences unreadable: ${error.message}`);
  }

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
