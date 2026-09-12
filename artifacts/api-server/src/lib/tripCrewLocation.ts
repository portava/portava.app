/**
 * Trip Crew Location — Privacy Guard + Status Resolver
 *
 * These are pure functions (no DB calls) that enforce privacy rules and
 * translate raw crew data into safe display labels.
 *
 * PRIVACY CONTRACT:
 *   - Exact lat/lng are ONLY included when the viewer has an active live-share
 *     grant from that member AND the member has not enabled hotel/home blur.
 *     "Active" is enforced here, against the `now` passed in: a grant whose
 *     `expiresAt` has passed — or cannot be parsed — releases nothing. The
 *     caller filtering expired rows in SQL is defence in depth, not the check.
 *   - Ghost-mode members appear as status "location_hidden" with no area label.
 *   - Non-accepted members (pending, removed) must be rejected upstream; these
 *     helpers assume the caller has already verified membership.
 *   - Live share reveals at most "nearby" visibility (no higher level).
 *   - Hotel/home blur: when hotel_blur_enabled=true in location_preferences,
 *     exact coords are withheld even during active live-share.
 */

import { freshnessBucket } from "./mapTravelers.js";
import { canSeePresence } from "./tripPresencePolicy.js";
import { classifyPresence, type PresenceFreshnessClass, type PresenceConfidence } from "./tripPresenceFreshness.js";
import { incrementTripMetric } from "./tripMetrics.js";
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
    /** The ROW's clock (`updated_at`): moves on any patch, a hand-picked city included. */
    updatedAt: string | null;
    /** The POSITION's clock (`last_known_at`): moves only with a coordinate. §10.2 is judged on this when present. */
    lastKnownAt?: string | null;
    /** `user_location_state.source` — the client's own word for how it got the fix. §10.1 `source`. */
    source?: string | null;
    /** `user_location_state.accuracy_meters`. §10.1 `confidence`, banded by lib/tripPresenceFreshness.ts. */
    accuracyMeters?: number | null;
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

/**
 * Presence freshness for a crew card.
 *
 *   "live"   position updated within 15 minutes
 *   "recent" within 60 minutes
 *   "stale"  older than 60 minutes — last-known, NOT live truth
 *   null     no position timestamp at all; age unknown, so currency
 *            cannot be claimed. Treated exactly like "stale" for the
 *            purposes of what this module will draw.
 *
 * THE BOUNDS ARE NOT INVENTED HERE. They come from lib/mapTravelers'
 * freshnessBucket, the same function the main Map and circleLocationsRead
 * use, so the two maps cannot drift apart on what "live" means.
 * (lib/circleLocationsRead.ts:285 states the same rule for the same reason.)
 * freshnessBucket returns null beyond 60 minutes; the Map DROPS those
 * travellers, but Trips must not — spec §10.2: "Last-known data may remain
 * useful but is not live truth." So here that null becomes "stale" and the
 * member is kept with an area label.
 */
export type CrewFreshness = "live" | "recent" | "stale";

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
  /**
   * How current this member's position is. null when there is no position
   * timestamp at all (age unknown). Spec §10.2 requires the marker's visual
   * treatment and accessible text to expose this; supplying the bucket is the
   * server's half of that, rendering it is the client's.
   */
  freshness: CrewFreshness | null;
  // ── §10.1 / §10.2, by the spec's names (census-trips §40.6) ──────────────
  /** §10.2 LIVE | RECENT | LAST_KNOWN | OFFLINE, judged on the position's own clock. */
  freshnessClass: PresenceFreshnessClass;
  /** §10.1 observed_at: the instant the class is about — `last_known_at` when the row has one, else `updated_at`. */
  observedAt: string | null;
  observedAtSource: "last_known_at" | "updated_at" | null;
  /** §10.1 source: the client's own word for how it got the fix; null when it said nothing. */
  source: string | null;
  /** §10.1 confidence: the device's accuracy, banded. Independent of freshness on purpose. */
  confidence: PresenceConfidence;
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
export function buildCrewCard(
  raw: RawMemberLocation,
  now: number = Date.now(),
): CrewMemberCard {
  // Spec §10.2: "The Trip Map must never draw a stale location as if it were
  // current." freshnessBucket returns null past 60 minutes; for Trips that is
  // "stale" (kept, labelled), not "drop". A missing timestamp stays null: we
  // do not know the age, so we cannot assert currency.
  //
  // §40.6: judged on the POSITION's clock. `updated_at` moves on any patch (a
  // hand-picked city this morning); `last_known_at` moves only with a
  // coordinate; judging currency on the former called a week-old point LIVE.
  // The legacy bucket stays on the card under its old name, computed on the
  // same instant the class is.
  const presence = classifyPresence({
    lastKnownAt: raw.locationState?.lastKnownAt ?? null,
    updatedAt: raw.locationState?.updatedAt ?? null,
    expiresAt: null,
    source: raw.locationState?.source ?? null,
    accuracyMeters: raw.locationState?.accuracyMeters ?? null,
  }, now);
  const freshness: CrewFreshness | null = presence.observedAt
    ? (freshnessBucket(presence.observedAt, now) ?? "stale")
    : null;
  // "Current" means a position we can positively vouch for as live or recent.
  // Anything else — stale, or unknown age — must not be drawn as current.
  const positionIsCurrent = presence.drawableAsCurrent;

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
    freshness,
    freshnessClass: presence.freshnessClass,
    observedAt: presence.observedAt,
    observedAtSource: presence.observedAtSource,
    source: presence.source,
    confidence: presence.confidence,
  };

  // §6.1 canSeePresence decides the FORK — ghost, live-share, hidden default —
  // and this card only renders the branch it picked. The predicate lives in
  // lib/tripPresencePolicy.ts and is tested as a rule against every actor
  // kind; keeping the ordering here as well would be two copies of one rule.
  const decision = canSeePresence({
    ghostModeEnabled: raw.prefs?.ghostModeEnabled ?? false,
    defaultVisibility: raw.prefs?.defaultVisibility ?? null,
    liveShareExpiresAt: raw.liveShare?.expiresAt ?? null,
  }, now);

  // Ghost mode — member is invisible
  if (!decision.allowed && decision.reason === "TRIP_PRESENCE_GHOST") {
    return { ...base, ghostMode: true, statusLabel: "location_hidden", areaLabel: null, exactCoords: null };
  }

  // TIME-BOXED MEANS THE BOX IS CHECKED HERE. This module's header promises
  // exact coordinates only under "an active live-share grant", and until
  // 2026-09-11 it took `raw.liveShare != null` as proof of that — the comment
  // below asserted "the GRANT has not expired" as a premise. The premise held
  // only because TripCrewLocationService filters `.gt("expires_at", now)` in
  // SQL, in a different file. A guard whose contract is enforced somewhere else
  // is not a guard; a second caller, or an edit to that WHERE clause, would
  // release coordinates with nothing here objecting. `now` is already a
  // parameter and the expiry already arrives on the grant, so the check is one
  // comparison.
  //
  // FAIL CLOSED on an unparseable timestamp: an unknown grant state is not
  // permission. `Date.parse` returns NaN there, and every comparison with NaN
  // is false, so the `>` below rejects it — stated explicitly because relying
  // on NaN semantics silently is how this kind of check rots.
  // The predicate above did this comparison (an unparseable expiry fails
  // closed there too); `grantIsActive` is its verdict, named for the reader.
  const grantIsActive = decision.allowed && decision.via === "live_share";

  // Live share overrides the default visibility — INCLUDING a 'hidden' default.
  // A live share is an affirmative, time-boxed act of sharing; it must be honored
  // even when the member's passive default is 'hidden'. This check MUST precede
  // the hidden-default short-circuit below, which previously returned 'not_shared'
  // first and silently discarded the member's explicit live share. (Ghost mode
  // above still wins — that is an absolute "invisible" choice.)
  if (raw.liveShare && grantIsActive) {
    const areaLabel = resolveAreaLabel(raw.locationState, raw.liveShare.visibilityLevel);

    // Include exact coords only when hotel blur is disabled, coords are
    // available, AND the position is one we can vouch for as current. An exact
    // coordinate is the strongest possible claim that someone is somewhere
    // RIGHT NOW; publishing a three-day-old one as a live-share pin is the
    // §10.2 violation in its most acute form. The live share itself stays
    // active (liveShareActive: true) because the GRANT has not expired — checked
    // above, not assumed — what is stale is the position, and those are
    // different facts.
    const exactCoords = positionIsCurrent ? resolveExactCoords(raw) : null;
    // §21.1 stale_presence_render_attempt_total: an active GRANT over a
    // LAST_KNOWN or expired position is exactly the case §10.2 forbids
    // drawing as current. Counted where it is refused, so the regression the
    // metric exists for is measurable (census-trips TR399).
    if (!positionIsCurrent && presence.observedAt !== null && resolveExactCoords(raw) !== null) {
      incrementTripMetric("stale_presence_render_attempt_total", { reason: "live_share_grant_over_last_known_position" });
    }

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

  // Prefs default — if no prefs row, treat as not_shared. The predicate has
  // already said so (TRIP_PRESENCE_HIDDEN); this is the card for that answer.
  const visibility = raw.prefs?.defaultVisibility ?? "hidden";
  if (!decision.allowed) {
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
export function resolveExactCoords(
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
