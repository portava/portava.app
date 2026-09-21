/**
 * LocationPermissionService
 *
 * Reads user_location_preferences and enforces mode rules.
 * Exposes helper functions consumed by Discovery, Pulse, and Safe Return routes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";

const logger = rootLogger.child({ service: "LocationPermissionService" });

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
  /**
   * TRUE when these values do NOT come from the user's stored row because
   * `location_preferences` could not be read. They are then the CLOSED
   * fallback below, not the user's choices, and no caller may present them as
   * "this is how you have things set". Absent-row is NOT degraded: a user who
   * has never opened the settings screen has genuinely made no choice, and the
   * shipped defaults are the policy for them.
   */
  degraded: boolean;
  /** The read error, for operator logs. Only set when `degraded` is true. */
  degradedReason?: string;
}

const MODE_DEFAULT_PULSE_VISIBILITY: Record<LocationMode, PulseVisibility> = {
  off:                  "no_location",
  city_only:            "city_only",
  nearby:               "neighborhood",
  live_during_activity: "neighborhood",
  trusted_circle_live:  "venue_tagged",
};

/**
 * What a user who has never touched the settings screen gets. A SUCCESSFUL read
 * that found no row is a real answer, and these are the shipped policy for it.
 */
const DEFAULT_PREFS: UserLocationPreferences = {
  userId: "",
  locationMode: "city_only",
  sharingPaused: false,
  pulseVisibility: null,
  discoveryVisibility: null,
  safeReturnEnabled: true,
  trustedCircleShare: false,
  hotelBlurEnabled: true,
  degraded: false,
};

/**
 * What an UNREADABLE `location_preferences` gets, and why it is not DEFAULT_PREFS.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error, so `const { data, error } = …;
 * if (error || !data) return DEFAULT_PREFS` answered "this user shares their
 * city and is not paused" for a read that never happened. Those defaults are
 * PERMISSIVE, and the two consumers of this function decide disclosure with
 * them: PulseGeoTagService writes the geo tag a post is discovered by, and
 * routes/discovery.ts scopes nearby results. A user who had set
 * `locationMode: "off"` or `sharingPaused: true` — the two settings whose whole
 * purpose is "do not publish where I am" — had that opt-out silently reversed
 * for the duration of any read blip, and nothing logged.
 *
 * A failed read is not permission. So the closed fallback is the most
 * restrictive row this type can express:
 *
 *   locationMode "off" + sharingPaused  → isSharingActive() is false and
 *                                          effectivePulseVisibility() is
 *                                          `no_location`, so nothing publishes.
 *   hotelBlurEnabled true               → if anything downstream still writes a
 *                                          position, it is blurred.
 *
 * `safeReturnEnabled` deliberately stays TRUE. Every other field here reduces
 * DISCLOSURE, and closed means "share less". That one gates a SAFETY feature,
 * where closed means "keep the check-in timer available" — flipping it to false
 * on a read blip would disable Safe Return for someone who is out alone, which
 * is the exposure this whole exercise exists to prevent, not an example of it.
 */
const CLOSED_PREFS: Omit<UserLocationPreferences, "userId" | "degradedReason"> = {
  locationMode: "off",
  sharingPaused: true,
  pulseVisibility: "no_location",
  discoveryVisibility: "no_location",
  safeReturnEnabled: true,
  trustedCircleShare: false,
  hotelBlurEnabled: true,
  degraded: true,
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

  // A READ ERROR AND AN ABSENT ROW ARE NOT THE SAME ANSWER, and this is the
  // whole point of the split above. `error` first, so the closed fallback can
  // never be reached by a user who simply has no row yet.
  if (error) {
    logger.error(
      { err: error, userId },
      "location_preferences unreadable — falling back CLOSED (no sharing); this user's stored preferences were NOT applied",
    );
    return {
      ...CLOSED_PREFS,
      userId,
      degradedReason: String((error as any)?.message ?? (error as any)?.code ?? "db_error"),
    };
  }

  if (!data) return { ...DEFAULT_PREFS, userId };

  return {
    userId,
    degraded: false,
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
