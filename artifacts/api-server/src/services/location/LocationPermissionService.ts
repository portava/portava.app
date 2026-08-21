/**
 * LocationPermissionService
 *
 * Reads the canonical user_location_preferences table and enforces mode rules.
 * Exposes helper functions consumed by Discovery, Pulse, and Safe Return routes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type LocationMode =
  | "off"
  | "city_only"
  | "nearby"
  | "live_during_activity"
  | "trusted_circle_live";

export type PulseVisibility =
  | "city_only"
  | "neighborhood"
  | "venue_tagged"
  | "exact_hidden"
  | "no_location";

const LOCATION_MODES = new Set<LocationMode>([
  "off",
  "city_only",
  "nearby",
  "live_during_activity",
  "trusted_circle_live",
]);
export interface UserLocationPreferences {
  userId: string;
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: PulseVisibility | null;
  discoveryVisibility: PulseVisibility | null;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
  journeyObservationEnabled: boolean;
  journeyConsentScope: string | null;
  journeyConsentVersion: number | null;
  journeyConsentGrantedAt: string | null;
  journeyConsentRevokedAt: string | null;
}

const MODE_DEFAULT_PULSE_VISIBILITY: Record<LocationMode, PulseVisibility> = {
  off:                  "no_location",
  city_only:            "city_only",
  nearby:               "neighborhood",
  live_during_activity: "neighborhood",
  trusted_circle_live:  "venue_tagged",
};

const DEFAULT_PREFS: UserLocationPreferences = {
  userId: "",
  locationMode: "city_only",
  sharingPaused: false,
  pulseVisibility: null,
  discoveryVisibility: null,
  safeReturnEnabled: true,
  trustedCircleShare: false,
  hotelBlurEnabled: true,
  journeyObservationEnabled: false,
  journeyConsentScope: null,
  journeyConsentVersion: null,
  journeyConsentGrantedAt: null,
  journeyConsentRevokedAt: null,
};

/** Load preferences from DB; returns defaults if row missing. */
export async function loadPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<UserLocationPreferences> {
  const { data, error } = await db
    .from("user_location_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return { ...DEFAULT_PREFS, userId };

  return {
    userId,
    locationMode:       toLocationMode(data.location_mode, "city_only"),
    sharingPaused:      Boolean(data.sharing_paused),
    pulseVisibility:    toPulseVisibility(data.pulse_visibility),
    discoveryVisibility:toPulseVisibility(data.discovery_visibility),
    safeReturnEnabled:  data.safe_return_enabled !== false,
    trustedCircleShare: Boolean(data.trusted_circle_share),
    hotelBlurEnabled:   data.hotel_blur_enabled !== false,
    journeyObservationEnabled: Boolean(data.journey_observation_enabled),
    journeyConsentScope: typeof data.journey_consent_scope === "string"
      ? data.journey_consent_scope
      : null,
    journeyConsentVersion: typeof data.journey_consent_version === "number"
      ? data.journey_consent_version
      : null,
    journeyConsentGrantedAt: typeof data.journey_consent_granted_at === "string"
      ? data.journey_consent_granted_at
      : null,
    journeyConsentRevokedAt: typeof data.journey_consent_revoked_at === "string"
      ? data.journey_consent_revoked_at
      : null,
  };
}

/**
 * Authorization reads must not inherit loadPreferences' UI defaults. A missing
 * row or DB error means there is no provable Journey consent, so return null.
 */
export async function loadJourneyAuthorizationPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<UserLocationPreferences | null> {
  try {
    const { data, error } = await db
      .from("user_location_preferences")
      .select(
        "user_id, location_mode, sharing_paused, pulse_visibility, discovery_visibility, safe_return_enabled, trusted_circle_share, hotel_blur_enabled, journey_observation_enabled, journey_consent_scope, journey_consent_version, journey_consent_granted_at, journey_consent_revoked_at",
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error || !data) return null;
    const locationMode = toLocationMode(data.location_mode, "off");
    // Legacy mode values are intentionally not accepted for this new purpose:
    // the owner must save a current compatible mode as well as explicit Journey
    // opt-in before precise ingestion can begin.
    if (!LOCATION_MODES.has(String(data.location_mode) as LocationMode)) return null;
    return {
      userId,
      locationMode,
      sharingPaused: Boolean(data.sharing_paused),
      pulseVisibility: toPulseVisibility(data.pulse_visibility),
      discoveryVisibility: toPulseVisibility(data.discovery_visibility),
      safeReturnEnabled: data.safe_return_enabled !== false,
      trustedCircleShare: Boolean(data.trusted_circle_share),
      hotelBlurEnabled: data.hotel_blur_enabled !== false,
      journeyObservationEnabled: data.journey_observation_enabled === true,
      journeyConsentScope: typeof data.journey_consent_scope === "string"
        ? data.journey_consent_scope
        : null,
      journeyConsentVersion: typeof data.journey_consent_version === "number"
        ? data.journey_consent_version
        : null,
      journeyConsentGrantedAt: typeof data.journey_consent_granted_at === "string"
        ? data.journey_consent_granted_at
        : null,
      journeyConsentRevokedAt: typeof data.journey_consent_revoked_at === "string"
        ? data.journey_consent_revoked_at
        : null,
    };
  } catch {
    return null;
  }
}
/** Effective pulse visibility for a user given their mode + override. */
export function effectivePulseVisibility(prefs: UserLocationPreferences): PulseVisibility {
  if (prefs.sharingPaused) return "no_location";
  if (prefs.pulseVisibility) return prefs.pulseVisibility;
  return MODE_DEFAULT_PULSE_VISIBILITY[prefs.locationMode];
}

/** Can this user's location be used for nearby discovery? */
export function canUseNearbyDiscovery(prefs: UserLocationPreferences): boolean {
  if (prefs.sharingPaused) return false;
  if (prefs.locationMode === "off") return false;
  return true;
}

/** Is sharing location active at all (not paused + not off)? */
export function isSharingActive(prefs: UserLocationPreferences): boolean {
  return !prefs.sharingPaused && prefs.locationMode !== "off";
}

/** Location mode descriptors for the settings UI. */
export const LOCATION_MODE_DESCRIPTIONS: Record<LocationMode, { label: string; description: string }> = {
  off: {
    label: "Off",
    description: "No location data is shared or used. Discovery and Pulse show destination content only.",
  },
  city_only: {
    label: "City only",
    description: "Only your city is used. Great for discovery without sharing your neighborhood.",
  },
  nearby: {
    label: "Nearby",
    description: "Your neighborhood is used for nearby discovery and pulse. No exact location shared.",
  },
  live_during_activity: {
    label: "Live during activity",
    description: "Shares approximate location while plans or meetups are active. Stops after activity ends.",
  },
  trusted_circle_live: {
    label: "Trusted circle live share",
    description: "Shares your approximate location with your trusted circle. You control who sees it.",
  },
};

const PULSE_VISIBILITIES = new Set<PulseVisibility>([
  "city_only",
  "neighborhood",
  "venue_tagged",
  "exact_hidden",
  "no_location",
]);

function toLocationMode(value: unknown, fallback: LocationMode): LocationMode {
  if (typeof value === "string" && LOCATION_MODES.has(value as LocationMode)) {
    return value as LocationMode;
  }
  // Historical canonical rows used these values before migration 0131 widened
  // the constraint. Keep existing non-Journey behavior deterministic.
  if (value === "city") return "city_only";
  if (value === "precise") return "live_during_activity";
  return fallback;
}

const AUDIENCE_VISIBILITIES = new Set([
  "everyone",
  "circle",
  "trip_members",
  "nobody",
]);

function toPulseVisibility(value: unknown): PulseVisibility | null {
  if (typeof value !== "string") return null;
  if (PULSE_VISIBILITIES.has(value as PulseVisibility)) {
    return value as PulseVisibility;
  }
  // The legacy table's visibility columns used audience controls rather than
  // geographic precision. Never reinterpret an unexpected legacy value as
  // more precise access if one reaches this boundary.
  if (value === "nobody") return "no_location";
  if (AUDIENCE_VISIBILITIES.has(value)) return null;
  return null;
}
