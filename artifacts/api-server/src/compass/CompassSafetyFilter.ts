/**
 * CompassSafetyFilter — Phase 2 hard-block gate.
 *
 * Runs BEFORE eligibility, privacy, and scoring. If this filter blocks an item
 * it is removed from the pipeline entirely and never scored.
 *
 * Hard-block conditions (any match → blocked):
 *   1. Author is in viewer's blockedUserIds (viewer blocked them)
 *   2. Author is in viewer's blockerUserIds (they blocked viewer)
 *   3. Item/author is suspended
 *   4. Item has adult-service flag
 *   5. Item has off-app-payment signal
 *   6. Item has unsafe-intent signal
 *   7. Item is a delayed post not yet eligible for publication
 *   8. Item is hidden
 *   9. Item is expired (events/stamps)
 *  10. Item is cancelled
 *  11. Buddy item: requires verification but author is unverified
 *  12. Age conflict: minAgeRequired > viewer's resolved age
 *  13. Item author has been reported above the report-count threshold
 *
 * Blocked items are logged to compass_safety_filter_logs (fire-and-forget).
 * This function NEVER throws — it always returns a FilterResult.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";

export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

/** Maximum report count before an item is hard-blocked */
const REPORT_COUNT_THRESHOLD = 5;

/** Default viewer age assumed when none is known (conservative) */
const DEFAULT_VIEWER_AGE = 18;

function checkItem(item: CompassItem, profile: CompassProfile): FilterResult {
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

  // 3. Suspended
  if (item.isSuspended) {
    return denied("author_or_item_suspended");
  }

  // 4. Adult service flag
  if (item.hasAdultServiceFlag) {
    return denied("adult_service_flag");
  }

  // 5. Off-app payment signal
  if (item.hasOffAppPaymentSignal) {
    return denied("off_app_payment_signal");
  }

  // 6. Unsafe intent signal
  if (item.hasUnsafeIntentSignal) {
    return denied("unsafe_intent_signal");
  }

  // 7. Delayed post not yet eligible
  if (item.type === "post" && item.isDelayedPost) {
    const eligible = item.publishEligibleAt
      ? new Date(item.publishEligibleAt).getTime()
      : null;
    if (eligible === null || eligible > Date.now()) {
      return denied("delayed_post_not_yet_eligible");
    }
  }

  // 8. Hidden content
  if (item.isHidden) {
    return denied("content_hidden");
  }

  // 9. Expired
  if (item.isExpired) {
    return denied("item_expired");
  }

  // 10. Cancelled
  if (item.isCancelled) {
    return denied("item_cancelled");
  }

  // 11. Unverified buddy (when verification required)
  if (item.type === "buddy" && item.requiresVerification && !item.isVerified) {
    return denied("buddy_not_verified");
  }

  // 12. Age conflict
  if (item.minAgeRequired !== undefined && item.minAgeRequired > 0) {
    const viewerAge = profile.viewerAge ?? DEFAULT_VIEWER_AGE;
    if (viewerAge < item.minAgeRequired) {
      return denied("age_conflict");
    }
  }

  // 13. High report count
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
 * @param item     The content item to check
 * @param profile  The calling user's Compass profile
 * @param db       Optional Supabase client for logging (null in tests)
 */
export function runSafetyFilter(
  item: CompassItem,
  profile: CompassProfile,
  db: SupabaseClient | null = null,
): FilterResult {
  try {
    const result = checkItem(item, profile);
    if (!result.allowed && result.reason) {
      logBlock(db, profile.userId, item, result.reason);
    }
    return result;
  } catch {
    // Never propagate — fail open (allow) so a bug here doesn't black-hole content
    return { allowed: true };
  }
}

/**
 * Filter a batch of items through the safety filter.
 * Returns only the items that passed, along with a summary.
 */
export function runSafetyFilterBatch(
  items: CompassItem[],
  profile: CompassProfile,
  db: SupabaseClient | null = null,
): { passed: CompassItem[]; blocked: Array<{ item: CompassItem; reason: string }> } {
  const passed: CompassItem[] = [];
  const blocked: Array<{ item: CompassItem; reason: string }> = [];
  for (const item of items) {
    const result = runSafetyFilter(item, profile, db);
    if (result.allowed) {
      passed.push(item);
    } else {
      blocked.push({ item, reason: result.reason ?? "unknown" });
    }
  }
  return { passed, blocked };
}
