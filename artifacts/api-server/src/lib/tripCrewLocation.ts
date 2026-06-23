/**
 * Trip Crew Location — Privacy Guard + Status Resolver
 *
 * These are pure functions (no DB calls) that enforce privacy rules and
 * translate raw crew data into safe display labels.
 *
 * PRIVACY CONTRACT:
 *   - Exact lat/lng are NEVER included in crew map responses.
 *   - Ghost-mode members appear as status "location_hidden" with no area label.
 *   - Non-accepted members (pending, removed) must be rejected upstream; these
 *     helpers assume the caller has already verified membership.
 *   - Live share reveals at most "neighborhood" level; "exact" is not a
 *     valid visibility_level for trip crew (unlike Safe Return which has a
 *     separate live-share flow).
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
  /** From user_location_state */
  locationState: {
    city: string | null;
    district: string | null;
    country: string | null;
    updatedAt: string | null;
  } | null;
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
 * Never returns exact coordinates; at most returns blurred area labels.
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
    return { ...base, ghostMode: true, statusLabel: "location_hidden", areaLabel: null };
  }

  // Prefs default — if no prefs row, treat as hidden
  const visibility = raw.prefs?.defaultVisibility ?? "hidden";
  if (visibility === "hidden") {
    return { ...base, statusLabel: "not_shared", areaLabel: null };
  }

  // Live share overrides default visibility
  if (raw.liveShare) {
    const areaLabel = resolveAreaLabel(raw.locationState, raw.liveShare.visibilityLevel);
    return {
      ...base,
      statusLabel: "live_sharing_active",
      areaLabel,
      liveShareActive: true,
      liveShareExpiresAt: raw.liveShare.expiresAt,
      safeReturnActive: raw.hasSafeReturnActive && (raw.prefs?.shareSafeReturnStatus ?? false),
      planCheckInStatus: raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null,
    };
  }

  // Safe Return takes visual priority (but only if the member opts in)
  if (raw.hasSafeReturnActive && (raw.prefs?.shareSafeReturnStatus ?? false)) {
    const areaLabel = resolveAreaLabel(raw.locationState, visibilityToLevel(visibility));
    return {
      ...base,
      statusLabel: "safe_return_active",
      areaLabel,
      safeReturnActive: true,
      planCheckInStatus: raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null,
    };
  }

  // Arrival / check-in status
  const checkInStatus = raw.prefs?.shareArrivalStatus ? (raw.checkInStatus ?? null) : null;
  if (checkInStatus === "arrived" || checkInStatus === "late") {
    const areaLabel = resolveAreaLabel(raw.locationState, visibilityToLevel(visibility));
    return { ...base, statusLabel: "arrived", areaLabel, planCheckInStatus: checkInStatus };
  }

  // Default visibility-level label
  const level = visibilityToLevel(visibility);
  const statusLabel = levelToStatusLabel(level);
  const areaLabel = resolveAreaLabel(raw.locationState, level);
  return { ...base, statusLabel, areaLabel, planCheckInStatus: checkInStatus };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
