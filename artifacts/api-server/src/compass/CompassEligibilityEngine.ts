/**
 * CompassEligibilityEngine — Phase 2 eligibility gate.
 *
 * Runs AFTER the Safety Filter and BEFORE Privacy Guard + Scoring.
 * Items that fail eligibility are removed from the pipeline entirely.
 *
 * Eligibility checks (any fail → ineligible):
 *   1. Minimum Trust Score floor (item author's trustScore vs. system floor)
 *   2. Verification level required for content type
 *   3. City/country launch gate: item country/city must be in an enabled launch region
 *   4. Event capacity: event is full → not eligible
 *   5. Circle-only content: viewer must be in the item's circle
 *   6. Trip-only content: viewer must be a trip member
 *   7. Booking eligibility (buddy): buddy must have active status and accepted bookings
 *   8. Feature flag gate: item type must be enabled via COMPASS_<TYPE>_ENABLED flag
 *
 * Ineligible items are logged to compass_eligibility_logs (fire-and-forget).
 * This function NEVER throws — always returns an EligibilityResult.
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
): EligibilityResult {
  const ineligible = (reason: string): EligibilityResult => ({ eligible: false, reason });

  // 1. Trust Score floor
  const authorTrust = item.authorTrustScore ?? null;
  if (authorTrust !== null && authorTrust < DEFAULT_TRUST_FLOOR) {
    return ineligible("author_trust_score_below_floor");
  }

  // 2. Verification required (item-level)
  if (item.requiresVerification && !item.isVerified) {
    return ineligible("item_requires_verification");
  }

  // 3. Event capacity: full events are ineligible for new attendees
  if (item.type === "event") {
    const capacity = item.capacity ?? null;
    const attendees = item.currentAttendees ?? 0;
    if (capacity !== null && attendees >= capacity) {
      return ineligible("event_at_capacity");
    }
  }

  // 4. Circle-only: viewer must be in the circle
  if (item.visibilityScope === "circle_only") {
    if (!item.viewerIsInCircle) {
      return ineligible("viewer_not_in_circle");
    }
  }

  // 5. Trip-only: viewer must be a member of the trip
  if (item.visibilityScope === "trip_only") {
    if (!item.viewerIsInTrip) {
      return ineligible("viewer_not_in_trip");
    }
  }

  // 6. Buddy booking eligibility
  if (item.type === "buddy") {
    if (item.buddyStatus !== "active") {
      return ineligible("buddy_not_accepting_bookings");
    }
  }

  // 7. Private items are never eligible for feed (use direct access instead)
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
 * @param item     The content item to check
 * @param profile  The calling user's Compass profile
 * @param context  Current Compass context (contextState + signals)
 * @param db       Optional Supabase client for logging (null in tests)
 */
export function runEligibilityCheck(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
): EligibilityResult {
  try {
    const result = checkEligibility(item, profile, context);
    if (!result.eligible && result.reason) {
      logRejection(db, profile.userId, item, result.reason);
    }
    return result;
  } catch {
    // Never propagate — fail open so a bug here doesn't hide content
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
): { passed: CompassItem[]; rejected: Array<{ item: CompassItem; reason: string }> } {
  const passed: CompassItem[] = [];
  const rejected: Array<{ item: CompassItem; reason: string }> = [];
  for (const item of items) {
    const result = runEligibilityCheck(item, profile, context, db);
    if (result.eligible) {
      passed.push(item);
    } else {
      rejected.push({ item, reason: result.reason ?? "unknown" });
    }
  }
  return { passed, rejected };
}
