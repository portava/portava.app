/**
 * LocationPermissionService
 *
 * Reads user_location_preferences and enforces mode rules.
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

export interface UserLocationPreferences {
  userId: string;
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: PulseVisibility | null;
  discoveryVisibility: PulseVisibility | null;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
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
};

/** Load preferences from DB; returns defaults if row missing. */
export async function loadPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<UserLocationPreferences> {
  const { data, error } = await db
    // `location_preferences`, NOT `user_location_preferences`. The two are
    // separate base tables with near-identical columns — one is an un-retired
    // duplicate of the other — and PATCH /api/me/location-preferences upserts
    // the FORMER. This reader was on the latter, which has no writer anywhere,
    // so `data` was null for every user in every environment and this function
    // silently returned DEFAULT_PREFS forever. Because those defaults are
    // permissive (city_only, not paused), PulseGeoTagService concluded that
    // sharing was active for users who had turned it OFF: the opt-out was
    // stored correctly and then ignored. Nothing failed and nothing logged —
    // an empty table and an absent row are the same value here.
    .from("location_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return { ...DEFAULT_PREFS, userId };

  return {
    userId,
    locationMode:       (data.location_mode as LocationMode) ?? "city_only",
    sharingPaused:      Boolean(data.sharing_paused),
    pulseVisibility:    (data.pulse_visibility as PulseVisibility | null) ?? null,
    discoveryVisibility:(data.discovery_visibility as PulseVisibility | null) ?? null,
    safeReturnEnabled:  data.safe_return_enabled !== false,
    trustedCircleShare: Boolean(data.trusted_circle_share),
    hotelBlurEnabled:   data.hotel_blur_enabled !== false,
  };
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
