/**
 * CompassEligibilityEngine — Phase 2 eligibility gate.
 *
 * Runs AFTER the Safety Filter and BEFORE Privacy Guard + Scoring.
 * Items that fail eligibility are removed from the pipeline entirely.
 *
 * Eligibility checks (any fail → ineligible):
 *   1.  Per-type feature flag: COMPASS_<TYPE>_ENABLED must be true
 *   2.  Minimum Trust Score floor (DEFAULT_TRUST_FLOOR = 20)
 *   3.  Age eligibility: viewer's confirmed age must meet item's minAgeRequired
 *   4.  Country launch gate: if COMPASS_COUNTRY_LAUNCH_REQUIRED is true,
 *       the item's country must match COMPASS_COUNTRY_<COUNTRY>_ENABLED flag
 *   5.  City launch gate: if COMPASS_CITY_LAUNCH_REQUIRED is true,
 *       the item's city must match COMPASS_CITY_<CITY>_ENABLED flag
 *   6.  Verification: item requires verification but is unverified
 *   7.  Event capacity: event is full → not eligible
 *   8.  Circle-only content: viewer must be in the item's circle
 *   9.  Trip-only content: viewer must be a trip member
 *  10.  Buddy booking eligibility: buddy must have active status
 *  11.  Private items not owned by viewer
 *
 * Ineligible items are logged to compass_eligibility_logs (fire-and-forget).
 * Exception policy: FAIL-OPEN — bugs here should not hide content from users.
 *
 * All flag lookups use pre-loaded flags (passed by pipeline to avoid N DB calls).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

/** Minimum trust score an item author must have to appear in Compass. */
const DEFAULT_TRUST_FLOOR = 20;

function checkEligibility(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
  preloadedFlags: Record<string, boolean>,
): EligibilityResult {
  const ineligible = (reason: string): EligibilityResult => ({ eligible: false, reason });

  // 1. Per-type feature flag gate: COMPASS_<TYPE>_ENABLED
  // If the flag key exists and is false → not eligible.
  // If the flag is absent → allowed (default: enabled until explicitly disabled).
  const typeFlag = `COMPASS_${item.type.toUpperCase()}_ENABLED`;
  if (typeFlag in preloadedFlags && !preloadedFlags[typeFlag]) {
    return ineligible(`feature_flag_disabled:${item.type}`);
  }

  // 2. Trust Score floor
  const authorTrust = item.authorTrustScore ?? null;
  if (authorTrust !== null && authorTrust < DEFAULT_TRUST_FLOOR) {
    return ineligible("author_trust_score_below_floor");
  }

  // 3. Age eligibility gate.
  // When the viewer's age is explicitly known (profile.viewerAge is set), it must
  // meet the item's minAgeRequired. This is defense-in-depth alongside the Safety
  // Filter's hard-block (which uses a conservative default when age is unknown).
  if (item.minAgeRequired && item.minAgeRequired > 0 && profile.viewerAge !== undefined) {
    if (profile.viewerAge < item.minAgeRequired) {
      return ineligible("viewer_age_below_minimum");
    }
  }

  // 4. Country launch gate.
  // When COMPASS_COUNTRY_LAUNCH_REQUIRED is true, item's country must have an
  // explicit COMPASS_COUNTRY_<COUNTRY>_ENABLED flag set to true.
  // Unlike the Safety Filter's launch control, this check is ELIGIBILITY-level
  // (fail-open) and driven by a separate flag key.
  if (preloadedFlags["COMPASS_COUNTRY_LAUNCH_REQUIRED"] && item.country) {
    const countryKey = `COMPASS_COUNTRY_${item.country.toUpperCase().replace(/\s+/g, "_")}_ENABLED`;
    if (countryKey in preloadedFlags && !preloadedFlags[countryKey]) {
      return ineligible("country_not_in_launch");
    }
  }

  // 5. City-level launch gate.
  // When COMPASS_CITY_LAUNCH_REQUIRED is true, item city must have its own flag enabled.
  if (preloadedFlags["COMPASS_CITY_LAUNCH_REQUIRED"] && item.city) {
    const cityKey = `COMPASS_CITY_${item.city.toUpperCase().replace(/\s+/g, "_")}_ENABLED`;
    if (cityKey in preloadedFlags && !preloadedFlags[cityKey]) {
      return ineligible("city_not_in_launch");
    }
  }

  // 6. Verification required (item-level, e.g. verified-only buddy events)
  if (item.requiresVerification && !item.isVerified) {
    return ineligible("item_requires_verification");
  }

  // 7. Event capacity: full events are ineligible for new attendees
  if (item.type === "event") {
    const capacity = item.capacity ?? null;
    const attendees = item.currentAttendees ?? 0;
    if (capacity !== null && attendees >= capacity) {
      return ineligible("event_at_capacity");
    }
  }

  // 8. Circle-only: viewer must be in the circle
  if (item.visibilityScope === "circle_only" && !item.viewerIsInCircle) {
    return ineligible("viewer_not_in_circle");
  }

  // 9. Trip-only: viewer must be a member of the trip
  if (item.visibilityScope === "trip_only" && !item.viewerIsInTrip) {
    return ineligible("viewer_not_in_trip");
  }

  // 10. Buddy booking eligibility
  if (item.type === "buddy" && item.buddyStatus !== "active") {
    return ineligible("buddy_not_accepting_bookings");
  }

  // 11. Private items are never eligible for feed (use direct access instead)
  if (item.visibilityScope === "private" && item.authorId !== profile.userId) {
    return ineligible("item_is_private");
  }

  return { eligible: true };
}

/** Fire-and-forget log to DB. Never throws. */
function logRejection(
  db: SupabaseClient | null,
  viewerId: string,
  item: CompassItem,
  reason: string,
): void {
  if (!db) return;
  db.from("compass_eligibility_logs")
    .insert({
      viewer_id:        viewerId,
      item_id:          item.id,
      item_type:        item.type,
      rejection_reason: reason,
      author_id:        item.authorId ?? null,
    })
    .then(() => {}, () => {});
}

/**
 * Run the eligibility engine on a single item.
 *
 * Exception policy: FAIL-OPEN — if an exception occurs, the item is allowed.
 * A bug here should not hide content from users.
 *
 * @param item            The content item to check
 * @param profile         The calling user's Compass profile
 * @param context         Current Compass context
 * @param db              Optional Supabase client for logging (null in tests)
 * @param preloadedFlags  Pre-resolved feature flags (from pipeline's single DB load)
 */
export function runEligibilityCheck(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
  preloadedFlags: Record<string, boolean> = {},
): EligibilityResult {
  try {
    const result = checkEligibility(item, profile, context, preloadedFlags);
    if (!result.eligible && result.reason) {
      logRejection(db, profile.userId, item, result.reason);
    }
    return result;
  } catch {
    // FAIL-OPEN: on any exception, allow the item so bugs don't hide content
    return { eligible: true };
  }
}

/**
 * Run eligibility checks on a batch of items.
 * Returns only the items that passed, along with rejected items and reasons.
 */
export function runEligibilityBatch(
  items: CompassItem[],
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
  preloadedFlags: Record<string, boolean> = {},
): { passed: CompassItem[]; rejected: Array<{ item: CompassItem; reason: string }> } {
  const passed: CompassItem[] = [];
  const rejected: Array<{ item: CompassItem; reason: string }> = [];
  for (const item of items) {
    const result = runEligibilityCheck(item, profile, context, db, preloadedFlags);
    if (result.eligible) {
      passed.push(item);
    } else {
      rejected.push({ item, reason: result.reason ?? "unknown" });
    }
  }
  return { passed, rejected };
}
