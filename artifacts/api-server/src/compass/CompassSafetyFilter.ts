/**
 * CompassSafetyFilter — Phase 2 hard-block gate.
 *
 * Runs BEFORE eligibility, privacy, and scoring. If this filter blocks an item
 * it is removed from the pipeline entirely and never scored.
 *
 * Hard-block conditions (any match → blocked):
 *   1.  Author is in viewer's blockedUserIds (viewer blocked them)
 *   2.  Author is in viewer's blockerUserIds (they blocked viewer)
 *   3.  Viewer has reported this specific item (isReportedByViewer flag)
 *   4.  Item/author is suspended
 *   5.  Item has adult-service flag
 *   6.  Item has off-app-payment signal
 *   7.  Item has unsafe-intent signal
 *   8.  Item is a delayed post not yet eligible for publication
 *   9.  Item is hidden
 *  10.  Item is expired (events/stamps)
 *  11.  Item is cancelled
 *  12.  Buddy item: requires verification but author is unverified
 *  13.  Age conflict: minAgeRequired > viewer's resolved age
 *  14.  Item's country outside an active launch region (launch-control gate)
 *  15.  Item's content type disabled by COMPASS_<TYPE>_SAFETY_BLOCK flag
 *  16.  Item author has been reported above the report-count threshold
 *
 * Exception behaviour: FAIL-CLOSED — any unhandled exception blocks the item.
 * Safety is non-negotiable; a bug must never silently allow unsafe content.
 *
 * Blocked items are logged to compass_safety_filter_logs (fire-and-forget).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";

export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

/** Maximum report count before an item is hard-blocked. */
const REPORT_COUNT_THRESHOLD = 5;

/** Default viewer age assumed when none is known (conservative). */
const DEFAULT_VIEWER_AGE = 18;

/**
 * @internal Core synchronous check logic.
 * All launch-control flags must be pre-resolved and passed in as `preloadedFlags`.
 */
function checkItem(
  item: CompassItem,
  profile: CompassProfile,
  preloadedFlags: Record<string, boolean>,
): FilterResult {
  const denied = (reason: string): FilterResult => ({ allowed: false, reason });

  // 1. Author blocked by viewer
  const authorId = item.authorId ?? item.targetUserId;
  if (authorId && profile.blockedUserIds.includes(authorId)) {
    return denied("author_blocked_by_viewer");
  }

  // 2. Viewer blocked by author
  if (authorId && profile.blockerUserIds.includes(authorId)) {
    return denied("viewer_blocked_by_author");
  }

  // 3. Viewer has already reported this item
  if (item.isReportedByViewer) {
    return denied("viewer_reported_item");
  }

  // 4. Suspended
  if (item.isSuspended) {
    return denied("author_or_item_suspended");
  }

  // 5. Adult service flag
  if (item.hasAdultServiceFlag) {
    return denied("adult_service_flag");
  }

  // 6. Off-app payment signal
  if (item.hasOffAppPaymentSignal) {
    return denied("off_app_payment_signal");
  }

  // 7. Unsafe intent signal
  if (item.hasUnsafeIntentSignal) {
    return denied("unsafe_intent_signal");
  }

  // 8. Delayed post not yet eligible
  if (item.type === "post" && item.isDelayedPost) {
    const eligible = item.publishEligibleAt
      ? new Date(item.publishEligibleAt).getTime()
      : null;
    if (eligible === null || eligible > Date.now()) {
      return denied("delayed_post_not_yet_eligible");
    }
  }

  // 9. Hidden content
  if (item.isHidden) {
    return denied("content_hidden");
  }

  // 10. Expired
  if (item.isExpired) {
    return denied("item_expired");
  }

  // 11. Cancelled
  if (item.isCancelled) {
    return denied("item_cancelled");
  }

  // 12. Unverified buddy (when verification required)
  if (item.type === "buddy" && item.requiresVerification && !item.isVerified) {
    return denied("buddy_not_verified");
  }

  // 13. Age conflict
  if (item.minAgeRequired !== undefined && item.minAgeRequired > 0) {
    const viewerAge = profile.viewerAge ?? DEFAULT_VIEWER_AGE;
    if (viewerAge < item.minAgeRequired) {
      return denied("age_conflict");
    }
  }

  // 14. Launch-control: item country not in enabled launch region.
  // Only enforced when COMPASS_LAUNCH_CONTROL_ENABLED flag is true.
  if (preloadedFlags["COMPASS_LAUNCH_CONTROL_ENABLED"] && item.country) {
    const countryKey = `COMPASS_COUNTRY_${item.country.toUpperCase().replace(/\s+/g, "_")}_ENABLED`;
    if (!preloadedFlags[countryKey]) {
      return denied("country_not_in_launch_region");
    }
  }

  // 15. Type-level safety block flag (e.g. COMPASS_BUDDY_SAFETY_BLOCK disables buddy items)
  const typeBlockFlag = `COMPASS_${item.type.toUpperCase()}_SAFETY_BLOCK`;
  if (preloadedFlags[typeBlockFlag]) {
    return denied(`type_safety_block:${item.type}`);
  }

  // 16. High report count
  if ((item.reportCount ?? 0) >= REPORT_COUNT_THRESHOLD) {
    return denied("report_count_threshold_exceeded");
  }

  return { allowed: true };
}

/** Fire-and-forget log to DB. Never throws. */
function logBlock(
  db: SupabaseClient | null,
  viewerId: string,
  item: CompassItem,
  reason: string,
): void {
  if (!db) return;
  db.from("compass_safety_filter_logs")
    .insert({
      viewer_id:    viewerId,
      item_id:      item.id,
      item_type:    item.type,
      block_reason: reason,
      author_id:    item.authorId ?? null,
    })
    .then(() => {}, () => {});
}

/**
 * Run the safety filter on a single item.
 *
 * Exception policy: FAIL-CLOSED — if an exception occurs, the item is blocked.
 * This is intentional: safety must never silently permit content.
 *
 * @param item            The content item to check
 * @param profile         The calling user's Compass profile
 * @param db              Optional Supabase client for logging (null in tests)
 * @param preloadedFlags  Pre-resolved feature flags (from pipeline's single DB load)
 */
export function runSafetyFilter(
  item: CompassItem,
  profile: CompassProfile,
  db: SupabaseClient | null = null,
  preloadedFlags: Record<string, boolean> = {},
): FilterResult {
  try {
    const result = checkItem(item, profile, preloadedFlags);
    if (!result.allowed && result.reason) {
      logBlock(db, profile.userId, item, result.reason);
    }
    return result;
  } catch {
    // FAIL-CLOSED: on any exception, block the item and log.
    const reason = "safety_check_exception";
    logBlock(db, profile.userId, item, reason);
    return { allowed: false, reason };
  }
}

/**
 * Filter a batch of items through the safety filter.
 * Returns only items that passed, along with a summary of blocked items.
 */
export function runSafetyFilterBatch(
  items: CompassItem[],
  profile: CompassProfile,
  db: SupabaseClient | null = null,
  preloadedFlags: Record<string, boolean> = {},
): { passed: CompassItem[]; blocked: Array<{ item: CompassItem; reason: string }> } {
  const passed: CompassItem[] = [];
  const blocked: Array<{ item: CompassItem; reason: string }> = [];
  for (const item of items) {
    const result = runSafetyFilter(item, profile, db, preloadedFlags);
    if (result.allowed) {
      passed.push(item);
    } else {
      blocked.push({ item, reason: result.reason ?? "unknown" });
    }
  }
  return { passed, blocked };
}
