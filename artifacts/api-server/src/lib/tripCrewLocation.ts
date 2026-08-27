/**
 * Trip Crew Location — Privacy Guard + Status Resolver
 *
 * These are pure functions (no DB calls) that enforce privacy rules and
 * translate raw crew data into safe display labels.
 *
 * PRIVACY CONTRACT:
 *   - Exact lat/lng are ONLY included when the viewer has an active live-share
 *     grant from that member AND the member has not enabled hotel/home blur.
 *   - Ghost-mode members appear as status "location_hidden" with no area label.
 *   - Non-accepted members (pending, removed) must be rejected upstream; these
 *     helpers assume the caller has already verified membership.
 *   - Live share reveals at most "nearby" visibility (no higher level).
 *   - Hotel/home blur: when hotel_blur_enabled=true in location_preferences,
 *     exact coords are withheld even during active live-share.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type CrewStatusLabel =
  | "not_shared"        // member hasn't enabled sharing
  | "city_only"         // only city name visible
  | "neighborhood"      // neighborhood visible
  | "nearby"            // "Nearby [venue]" text
  | "arrived"           // checked in at plan item
  | "safe_return_active"
  | "live_sharing_active"
  | "location_hidden";  // ghost mode

export type CrewVisibility = "hidden" | "city_only" | "neighborhood" | "nearby" | "arrived_only";

export interface RawMemberLocation {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  /** From trip_crew_location_preferences */
  prefs: {
    defaultVisibility: CrewVisibility;
    ghostModeEnabled: boolean;
    shareArrivalStatus: boolean;
    shareSafeReturnStatus: boolean;
  } | null;
  /** From user_location_state — city/district always; lat/lng only when live-share active */
  locationState: {
    city: string | null;
    district: string | null;
    country: string | null;
    updatedAt: string | null;
    /** Exact coordinates — only populated when caller has active live-share access */
    lat?: number | null;
    lng?: number | null;
  } | null;
  /**
   * True when the member's location_preferences has hotel_blur_enabled=true.
   * When set, exact coords are withheld even during live-share.
   */
  hotelBlurEnabled?: boolean;
  /** From plan_checkins for this trip */
  checkInStatus: string | null;
  /** True if user has an active safe_return_session */
  hasSafeReturnActive: boolean;
  /** Active live share session (if any) the viewer is allowed to see */
  liveShare: {
    id: string;
    visibilityLevel: "city_only" | "neighborhood" | "nearby";
    expiresAt: string;
  } | null;
}

export interface CrewMemberCard {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  statusLabel: CrewStatusLabel;
  /** Human-readable area label e.g. "IT Park, Cebu City" — null when hidden */
  areaLabel: string | null;
  /**
   * Exact coordinates — only present when viewer has active live-share access
   * from this member and hotel/home blur is not enabled.
   */
  exactCoords?: { lat: number; lng: number } | null;
  planCheckInStatus: string | null;
  safeReturnActive: boolean;
  liveShareActive: boolean;
  liveShareExpiresAt: string | null;
  ghostMode: boolean;
  updatedAt: string | null;
}

// ── TripCrewPrivacyGuard ──────────────────────────────────────────────────────

/**
 * Transforms raw member data into a privacy-safe CrewMemberCard.
 *
 * Exact coordinates (exactCoords) are ONLY included when:
 *   1. The viewer has an active live-share grant from this member (raw.liveShare != null), AND
 *   2. The member has not enabled hotel/home blur (raw.hotelBlurEnabled != true), AND
 *   3. raw.locationState.lat and .lng are populated (passed in by the service).
 *
 * In all other cases exactCoords is absent/null.
 */
export function buildCrewCard(raw: RawMemberLocation): CrewMemberCard {
  const base = {
    userId: raw.userId,
    name: raw.name,
    handle: raw.handle,
    avatarUrl: raw.avatarUrl,
    planCheckInStatus: null as string | null,
    safeReturnActive: false,
    liveShareActive: false,
    liveShareExpiresAt: null as string | null,
    ghostMode: false,
    updatedAt: raw.locationState?.updatedAt ?? null,
  };

  // Ghost mode — member is invisible
  const ghostMode = raw.prefs?.ghostModeEnabled ?? false;
  if (ghostMode) {
    return { ...base, ghostMode: true, statusLabel: "location_hidden", areaLabel: null, exactCoords: null };
  }

  // Live share overrides the default visibility — INCLUDING a 'hidden' default.
  // A live share is an affirmative, time-boxed act of sharing; it must be honored
  // even when the member's passive default is 'hidden'. This check MUST precede
  // the hidden-default short-circuit below, which previously returned 'not_shared'
  // first and silently discarded the member's explicit live share. (Ghost mode
  // above still wins — that is an absolute "invisible" choice.)
  if (raw.liveShare) {
    const areaLabel = resolveAreaLabel(raw.locationState, raw.liveShare.visibilityLevel);

    // Include exact coords only when hotel blur is disabled and coords are available
    const exactCoords = resolveExactCoords(raw);

    return {
      ...base,
      statusLabel: "live_sharing_active",
      areaLabel,
      exactCoords,
      liveShareActive: true,
      liveShareExpiresAt: raw.liveShare.expiresAt,
      safeReturnActive: raw.hasSafeReturnActive && (raw.prefs?.shareSafeReturnStatus ?? false),
      planCheckInStatus: raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null,
    };
  }

  // Prefs default — if no prefs row, treat as not_shared
  const visibility = raw.prefs?.defaultVisibility ?? "hidden";
  if (visibility === "hidden") {
    return { ...base, statusLabel: "not_shared", areaLabel: null, exactCoords: null };
  }

  // Safe Return takes visual priority (but only if the member opts in)
  if (raw.hasSafeReturnActive && (raw.prefs?.shareSafeReturnStatus ?? false)) {
    const areaLabel = resolveAreaLabel(raw.locationState, visibilityToLevel(visibility));
    return {
      ...base,
      statusLabel: "safe_return_active",
      areaLabel,
      exactCoords: null,
      safeReturnActive: true,
      planCheckInStatus: raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null,
    };
  }

  // Arrival / check-in status
  const checkInStatus = raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null;
  if (checkInStatus === "arrived" || checkInStatus === "late") {
    const areaLabel = resolveAreaLabel(raw.locationState, visibilityToLevel(visibility));
    return { ...base, statusLabel: "arrived", areaLabel, exactCoords: null, planCheckInStatus: checkInStatus };
  }

  // Default visibility-level label
  const level = visibilityToLevel(visibility);
  const statusLabel = levelToStatusLabel(level);
  const areaLabel = resolveAreaLabel(raw.locationState, level);
  return { ...base, statusLabel, areaLabel, exactCoords: null, planCheckInStatus: checkInStatus };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns exact coords for a live-share card — only when:
 *   - liveShare is active, AND
 *   - hotel blur is NOT enabled, AND
 *   - lat + lng are actually available in locationState.
 */
function resolveExactCoords(
  raw: RawMemberLocation,
): { lat: number; lng: number } | null {
  if (!raw.liveShare) return null;
  if (raw.hotelBlurEnabled) return null;
  const lat = raw.locationState?.lat;
  const lng = raw.locationState?.lng;
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

type BlurLevel = "city_only" | "neighborhood" | "nearby";

function visibilityToLevel(v: CrewVisibility): BlurLevel {
  if (v === "neighborhood") return "neighborhood";
  if (v === "nearby" || v === "arrived_only") return "nearby";
  return "city_only";
}

function levelToStatusLabel(level: BlurLevel): CrewStatusLabel {
  if (level === "neighborhood") return "neighborhood";
  if (level === "nearby") return "nearby";
  return "city_only";
}

function resolveAreaLabel(
  loc: RawMemberLocation["locationState"],
  level: BlurLevel,
): string | null {
  if (!loc) return null;
  if (level === "city_only") {
    return loc.city ?? null;
  }
  if (level === "neighborhood") {
    const parts = [loc.district, loc.city].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  // nearby — same as neighborhood for our approximation
  const parts = [loc.district, loc.city].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Returns true when the given userId is an accepted member of tripId.
 * Used by routes after verifying auth to gate all crew-map access.
 * Non-accepted (pending, removed, non-member) users receive 403.
 */
export function isAccepted(role: "owner" | "member" | null): boolean {
  return role === "owner" || role === "member";
}
