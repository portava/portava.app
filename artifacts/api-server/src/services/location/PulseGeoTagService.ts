/**
 * PulseGeoTagService
 *
 * Writes a `pulse_geo_tags` row when a Pulse post is created.
 * Enforces three privacy rules in order:
 *   1. `locationMode = off`  → `location_visibility = no_location`  (skip tag or minimal row)
 *   2. `sharingPaused = true` → same as off
 *   3. Near private stay + hotelBlurEnabled → cap visibility to `neighborhood`
 *
 * PRIVACY: exact coordinates are NEVER stored in pulse_geo_tags.
 * Only public-safe text labels (city, district, country, venue_name) are written.
 *
 * Called fire-and-forget from POST /posts so it never blocks the post response.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPreferences,
  effectivePulseVisibility,
  isSharingActive,
  type PulseVisibility,
} from "./LocationPermissionService";
import { isNearPrivateStay } from "./GeoZoneService";

export interface PulseGeoTagInput {
  postId: string;
  userId: string;
  /** User's actual GPS coordinates — used only for hotel-blur check; never stored. */
  userGpsLat?: number | null;
  userGpsLng?: number | null;
  /** Public city-level labels to store. */
  locationCity?: string | null;
  locationCountry?: string | null;
  locationDistrict?: string | null;
  locationCountryCode?: string | null;
  venueName?: string | null;
  /**
   * Per-post visibility override from the user at posting time.
   * This can only REDUCE precision below the user's preference default;
   * it can never increase it above what the preferences allow.
   */
  locationVisibilityOverride?: PulseVisibility | null;
}

// Ordered from least-precise to most-precise.
// Hotel blur caps the stored visibility to `neighborhood` or below.
const VISIBILITY_RANK: Record<PulseVisibility, number> = {
  no_location:  0,
  city_only:    1,
  neighborhood: 2,
  venue_tagged: 3,
  exact_hidden: 4,
};

function capToNeighborhood(v: PulseVisibility): PulseVisibility {
  return VISIBILITY_RANK[v] > VISIBILITY_RANK["neighborhood"] ? "neighborhood" : v;
}

/**
 * Write a pulse_geo_tags row for `postId`.
 * Best-effort — throws are swallowed; a failure must not corrupt the post.
 */
export async function writePulseGeoTag(
  db: SupabaseClient,
  input: PulseGeoTagInput,
): Promise<void> {
  const {
    postId, userId,
    userGpsLat, userGpsLng,
    locationCity, locationCountry, locationDistrict, locationCountryCode, venueName,
  } = input;

  try {
    // 1. Load user's location preferences
    const prefs = await loadPreferences(db, userId);

    // 2. If sharing is off (mode=off or paused), write a no_location stub and return.
    //    This means the post exists but carries no discoverable location context.
    if (!isSharingActive(prefs)) {
      await db.from("pulse_geo_tags").insert({
        post_id:             postId,
        user_id:             userId,
        location_visibility: "no_location",
        hotel_blur_applied:  false,
      });
      return;
    }

    // 3. Compute the effective visibility from mode + explicit preference
    let visibility: PulseVisibility = effectivePulseVisibility(prefs);

    // Per-post override: pick the LESS precise of (pref default, per-post override).
    // Users can reduce precision at posting time; they cannot exceed their mode default.
    if (input.locationVisibilityOverride != null) {
      const overrideRank  = VISIBILITY_RANK[input.locationVisibilityOverride] ?? 99;
      const preferenceRank = VISIBILITY_RANK[visibility] ?? 99;
      visibility = overrideRank <= preferenceRank
        ? input.locationVisibilityOverride
        : visibility;
    }
    let hotelBlurApplied = false;

    // 4. Hotel / private-stay blur:
    //    If the user is within ~200m of an active private stay and hotel blur is
    //    enabled, cap the stored visibility to neighborhood (city block granularity).
    if (prefs.hotelBlurEnabled && userGpsLat != null && userGpsLng != null) {
      const nearStay = await isNearPrivateStay(db, userId, userGpsLat, userGpsLng);
      if (nearStay) {
        visibility = capToNeighborhood(visibility);
        hotelBlurApplied = true;
      }
    }

    // 5. Write the tag — only public text labels, never coordinates.
    await db.from("pulse_geo_tags").insert({
      post_id:             postId,
      user_id:             userId,
      location_visibility: visibility,
      city:                locationCity     ?? null,
      district:            locationDistrict ?? null,
      country:             locationCountry  ?? null,
      country_code:        locationCountryCode ?? null,
      venue_name:          venueName        ?? null,
      hotel_blur_applied:  hotelBlurApplied,
    });
  } catch {
    // Non-fatal — pulse_geo_tag failure must never corrupt the post
  }
}
