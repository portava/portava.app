/**
 * Find Your Circle — response shaper.
 *
 * Strips all sensitive fields from a presence row and enforces the visibility
 * mode contract before sending data to a circle member.
 *
 * Visibility mode contract:
 *   status_only     → profile info + status text. No location of any kind.
 *   approximate_area → status + approximate_label (neighbourhood/district).
 *   venue_checkin   → status + venue_label ONLY when checked_in = true.
 *   precise_live    → 403 (deferred to V2; rejected at route level).
 *
 * The response always includes:
 *   userId, avatarUrl, displayName, username, status, visibilityMode,
 *   freshnessLabel, lastUpdatedAt, canMessage, canViewProfile, safetyActionsAllowed
 *
 * The response NEVER includes:
 *   email, phone, precise GPS, private trip/event fields, admin notes,
 *   emergency data (needs_help bool is server-only; routes must not surface it).
 */

export interface CircleProfileSnippet {
  userId: string;
  avatarUrl: string | null;
  displayName: string;
  username: string;
}

export interface ShapedPresence {
  userId: string;
  avatarUrl: string | null;
  displayName: string;
  username: string;
  status: string;
  statusLabel: string | null;
  visibilityMode: string;
  freshnessLabel: string;
  lastUpdatedAt: string | null;
  /** Populated only when visibility allows location info */
  approximateLabel: string | null;
  venueLabel: string | null;
  /**
   * Broad-area coordinates for map pins.
   * venue_checkin and approximate_area modes may populate these once the DB
   * schema includes public_lat / public_lng columns (deferred to V2).
   * Always null in V1.
   */
  publicLat: number | null;
  publicLng: number | null;
  isStale: boolean;
  canMessage: boolean;
  canViewProfile: boolean;
  safetyActionsAllowed: boolean;
  /** true when the member hasn't published any presence for this context yet */
  presenceAbsent: boolean;
}

function freshnessLabel(lastUpdatedAt: string | null, isStale: boolean): string {
  if (!lastUpdatedAt) return "Not yet shared";
  if (isStale) return "Last seen a while ago";
  const diff = Date.now() - new Date(lastUpdatedAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return "More than a day ago";
}

/**
 * Shape a presence row (or null for absent presence) into a safe API response.
 *
 * @param profile        Public profile fields of the target user.
 * @param presenceRow    Raw DB row from circle_presence, or null if not published.
 * @param visibilityMode Effective visibility mode resolved by the access guard.
 * @param isStale        Whether the presence is considered stale.
 */
export function shapePresence(
  profile: CircleProfileSnippet,
  presenceRow: Record<string, any> | null,
  visibilityMode: string,
  isStale: boolean,
): ShapedPresence {
  if (!presenceRow) {
    return {
      userId: profile.userId,
      avatarUrl: profile.avatarUrl,
      displayName: profile.displayName,
      username: profile.username,
      status: "unknown",
      statusLabel: null,
      visibilityMode,
      freshnessLabel: "Not yet shared",
      lastUpdatedAt: null,
      approximateLabel: null,
      venueLabel: null,
      publicLat: null,
      publicLng: null,
      isStale: false,
      canMessage: true,
      canViewProfile: true,
      safetyActionsAllowed: true,
      presenceAbsent: true,
    };
  }

  const status = (presenceRow["status"] as string | null) ?? "active";
  const statusLabel = (presenceRow["status_label"] as string | null) ?? null;
  const lastUpdatedAt = (presenceRow["updated_at"] as string | null) ?? null;

  // Location fields — gate on visibility mode
  let approximateLabel: string | null = null;
  let venueLabel: string | null = null;

  if (visibilityMode === "approximate_area") {
    approximateLabel = (presenceRow["approximate_label"] as string | null) ?? null;
  } else if (visibilityMode === "venue_checkin") {
    const checkedIn = Boolean(presenceRow["checked_in"]);
    if (checkedIn) {
      venueLabel = (presenceRow["venue_label"] as string | null) ?? null;
    }
  }
  // precise_live: rejected at route level — never reaches shaper

  return {
    userId: profile.userId,
    avatarUrl: profile.avatarUrl,
    displayName: profile.displayName,
    username: profile.username,
    status,
    statusLabel,
    visibilityMode,
    freshnessLabel: freshnessLabel(lastUpdatedAt, isStale),
    lastUpdatedAt,
    approximateLabel,
    venueLabel,
    // V1: no coordinate columns in circle_presence — always null.
    // V2 will populate from public_lat / public_lng once schema is extended.
    publicLat: null,
    publicLng: null,
    isStale,
    canMessage: true,
    canViewProfile: true,
    safetyActionsAllowed: true,
    presenceAbsent: false,
  };
}
