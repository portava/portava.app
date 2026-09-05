/**
 * CompassAbuseDefenseEngine — Phase 5 abuse pattern detection.
 *
 * Runs on a cron schedule (hourly) and on-demand when a report is confirmed.
 * Detected patterns are written to `compass_abuse_flags`, reach reduction is
 * applied via `compass_visibility_cooldowns`, and severe confirmed patterns
 * call CompassActiveUserRewardEngine to zero out rewards.
 *
 * Scans performed by runScan():
 *   1. mutual_review_ring    — ≥3 users all gave each other 5★ within 7 days
 *   2. booking_loop          — same user pair with >5 bookings in 30 days, all 5★
 *   3. referral_farm         — user referred >10 accounts with no subsequent bookings
 *   4. comment_pod           — groups of users always commenting on each other's posts
 *   5. hashtag_spam          — >20 identical hashtag uses from one account in 24 h
 *   6. geotag_farming        — >15 location stamps from one account in 1 hour
 *   7. available_now_abuse   — status toggled on/off >20 times in 24 h with no bookings
 *   8. refund_abuse          — >3 booking cancellations/refunds in 30 days
 *
 * Severity levels:
 *   low     — flagged only; no immediate action
 *   medium  — reach reduced (compass_visibility_cooldowns extended)
 *   high    — reach reduced + flagged for admin review
 *   severe  — reach zeroed + active-user reward zeroed + suspension request
 *             (auto-confirmed because threshold evidence is strong)
 *
 * Never throws — all errors are swallowed so the scheduler stays healthy.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../lib/logger.js";
import { computeActiveUserScore } from "./CompassActiveUserRewardEngine.js";

const logger = rootLogger.child({ service: "CompassAbuseDefenseEngine" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type AbusePatternType =
  | "mutual_review_ring"
  | "booking_loop"
  | "referral_farm"
  | "comment_pod"
  | "hashtag_spam"
  | "geotag_farming"
  | "available_now_abuse"
  | "refund_abuse";

export type AbuseSeverity = "low" | "medium" | "high" | "severe";

export interface AbuseFlag {
  patternType:   AbusePatternType;
  involvedUsers: string[];
  severity:      AbuseSeverity;
  evidence:      Record<string, unknown>;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const RING_MIN_USERS            = 3;    // mutual review ring minimum size
const RING_WINDOW_DAYS          = 7;
const BOOKING_LOOP_MIN          = 5;    // >5 bookings between same pair in 30 days
const BOOKING_LOOP_WINDOW_DAYS  = 30;
const REFERRAL_FARM_MIN         = 10;   // referred >10 accounts that made no bookings
const COMMENT_POD_MIN_MUTUAL    = 6;    // ≥6 genuinely mutual pairs in 72 h signals a pod
const COMMENT_POD_MIN_DIRECTED  = 2;    // each side must comment on the other ≥2× (bidirectional check)
const HASHTAG_SPAM_MIN          = 20;   // same hashtag >20 times in 24 h
const GEOTAG_FARM_MIN           = 15;   // >15 stamps in 1 hour
const AVAILABLE_TOGGLE_MIN      = 20;   // >20 toggles in 24 h
const REFUND_ABUSE_MIN          = 3;    // >3 cancellations/refunds in 30 days

// ── Cooldown writer ───────────────────────────────────────────────────────────

async function applyReachReduction(
  db:       SupabaseClient,
  userId:   string,
  severity: AbuseSeverity,
): Promise<void> {
  const durationHours: Record<AbuseSeverity, number> = {
    low:    0,
    medium: 24,
    high:   72,
    severe: 8760, // 1 year ≈ effectively permanent until admin lifts
  };
  const hours = durationHours[severity];
  if (hours === 0) return;

  const nowMs = Date.now();
  const endsAt = new Date(nowMs + hours * 60 * 60 * 1_000).toISOString();
  // non-fatal
  const { error } = await db.from("compass_visibility_cooldowns").upsert(
    {
      author_id:    userId,
      cooldown_type: "reach_reduction",
      reason:       `abuse_defense:${severity}`,
      ends_at:      endsAt,
      updated_at:   new Date(nowMs).toISOString(),
    },
    { onConflict: "author_id,cooldown_type" },
  );
  if (error) logger.warn({ err: error, userId }, "visibility cooldown upsert failed (non-fatal)");
}

// ── Suspension-request trigger for severe patterns ────────────────────────────

/**
 * Emit a suspension request for a user confirmed to have committed a severe
 * abuse pattern. Inserts a pending-review row into compass_suspension_requests
 * so that the moderation team can act on it — the system never auto-suspends;
 * it only queues the request. Fire-and-forget: errors are swallowed.
 */
async function requestSuspension(
  db:     SupabaseClient,
  userId: string,
  reason: string,
): Promise<void> {
  // non-fatal
  const { error } = await db.from("compass_suspension_requests").insert({
    user_id:    userId,
    reason:     `severe_abuse:${reason}`,
    status:     "pending_review",
    created_at: new Date().toISOString(),
  });
  if (error) logger.warn({ err: error, userId }, "suspension request insert failed (non-fatal)");
}

// ── Reward zeroing for severe patterns ────────────────────────────────────────

/**
 * Zero out the active-user reward for a confirmed severe abuse flag.
 * Uses hasSevereSafetyFlag=true override so the score is recomputed as 0.
 * Also directly upserts the score row for immediate effect.
 */
async function zeroActiveUserReward(
  db:     SupabaseClient,
  userId: string,
): Promise<void> {
  try {
    // Recompute with severe flag override (may throw — not a bare supabase call)
    await computeActiveUserScore(db, userId, { hasSevereSafetyFlag: true });
  } catch (err) {
    logger.warn({ err, userId }, "active user score recompute failed (non-fatal)");
  }

  // Direct upsert for immediate effect (in case recompute is slow) — non-fatal
  const { error } = await db.from("compass_active_user_scores").upsert(
    {
      user_id:           userId,
      active_user_score: 0,
      trust_multiplier:  0,
      boost_eligible:    false,
      last_computed_at:  new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) logger.warn({ err: error, userId }, "active user score zeroing upsert failed (non-fatal)");
}

// ── Flag writer ───────────────────────────────────────────────────────────────

async function writeFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<void> {
  // non-fatal
  const { error } = await db.from("compass_abuse_flags").insert({
    pattern_type:   flag.patternType,
    involved_users: flag.involvedUsers,
    severity:       flag.severity,
    evidence:       flag.evidence,
    // severe patterns are auto-confirmed; others are pending admin review
    status:         flag.severity === "severe" ? "confirmed" : "pending",
  });
  if (error) logger.warn({ err: error, patternType: flag.patternType }, "abuse flag insert failed (non-fatal)");
}

// ── Post-detection action dispatcher ─────────────────────────────────────────

async function handleFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<void> {
  await writeFlag(db, flag);

  const applyReach       = flag.severity !== "low";
  const applyReward      = flag.severity === "severe";
  const applySuspension  = flag.severity === "severe";

  await Promise.allSettled(
    flag.involvedUsers.flatMap((uid) => {
      const ops: Promise<void>[] = [];
      if (applyReach)      ops.push(applyReachReduction(db, uid, flag.severity));
      if (applyReward)     ops.push(zeroActiveUserReward(db, uid));
      if (applySuspension) ops.push(requestSuspension(db, uid, flag.patternType));
      return ops;
    }),
  );
}

// ── Individual pattern detectors ──────────────────────────────────────────────

/** 1. Mutual 5★ review ring — ≥3 users who all reviewed each other within 7 days */
async function detectMutualReviewRings(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - RING_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const q = db
      .from("rent_buddy_reviews")
      .select("reviewer_id, reviewee_id, rating, created_at")
      .eq("rating", 5)
      .gte("created_at", since);

    if (userId) q.or(`reviewer_id.eq.${userId},reviewee_id.eq.${userId}`);

    const { data } = await q;
    const rows = (data as any[]) ?? [];

    // Build adjacency map: reviewer → set of reviewees (with 5★)
    const reviewedBy = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!reviewedBy.has(r.reviewer_id)) reviewedBy.set(r.reviewer_id, new Set());
      reviewedBy.get(r.reviewer_id)!.add(r.reviewee_id);
    }

    // Find the largest fully-connected clique (all members have reviewed each other
    // with 5★). A pair-based shortcut (checking only against the pivot user) is
    // insufficient — every pair in the ring must be mutually verified.
    function areMutual(a: string, b: string): boolean {
      return Boolean(reviewedBy.get(a)?.has(b) && reviewedBy.get(b)?.has(a));
    }

    const users = [...reviewedBy.keys()];
    for (let i = 0; i < users.length; i++) {
      // Start with just the pivot user and try to grow a clique
      const clique: string[] = [users[i]!];

      for (let j = i + 1; j < users.length; j++) {
        const candidate = users[j]!;
        // The candidate can join only if it mutually reviewed ALL existing members
        if (clique.every((member) => areMutual(candidate, member))) {
          clique.push(candidate);
        }
      }

      if (clique.length >= RING_MIN_USERS) {
        flags.push({
          patternType:   "mutual_review_ring",
          involvedUsers: clique,
          severity:      clique.length >= 5 ? "severe" : "high",
          evidence:      { ring_size: clique.length, window_days: RING_WINDOW_DAYS },
        });
        break; // one flag per scan — admin reviews then re-runs
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 2. Booking loop — same user pair with >5 completed/confirmed 5★ bookings in 30 days */
async function detectBookingLoops(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - BOOKING_LOOP_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    // rent_buddy_bookings has no rating column — ratings live on
    // rent_buddy_reviews (keyed by booking_id). Fetch bookings and 5★
    // reviews separately, then count only bookings with a 5★ review.
    const q = db
      .from("rent_buddy_bookings")
      .select("id, traveler_id, buddy_id, status, created_at")
      .in("status", ["completed", "confirmed"])
      .gte("created_at", since);

    if (userId) q.or(`traveler_id.eq.${userId},buddy_id.eq.${userId}`);

    const { data } = await q;
    const rows = (data as any[]) ?? [];

    const { data: reviewRows } = await db
      .from("rent_buddy_reviews")
      .select("booking_id, rating")
      .eq("rating", 5)
      .gte("created_at", since);
    const fiveStarBookingIds = new Set(
      ((reviewRows as any[]) ?? []).map((r) => r.booking_id as string),
    );

    // Count 5★ bookings per pair
    const pairCounts = new Map<string, number>();
    for (const r of rows) {
      if (!fiveStarBookingIds.has(r.id as string)) continue; // ensure 5★
      const key = [r.traveler_id, r.buddy_id].sort().join("|");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    for (const [pair, count] of pairCounts) {
      if (count > BOOKING_LOOP_MIN) {
        const [a, b] = pair.split("|");
        flags.push({
          patternType:   "booking_loop",
          involvedUsers: [a!, b!],
          severity:      count > 10 ? "severe" : "high",
          evidence:      { booking_count: count, window_days: BOOKING_LOOP_WINDOW_DAYS, all_five_star: true },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 3. Referral farm — user whose referrals (>10) made no bookings */
async function detectReferralFarms(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    // STUB: profiles has no referred_by column in the live schema, so referral
    // farms cannot be detected until a referral source is tracked. Return no
    // flags rather than silently failing the whole scan.
    const rows: any[] = [];

    // Count referrals per referrer
    const referralCounts = new Map<string, string[]>(); // referrerId → referred user IDs
    for (const r of rows) {
      if (!r.referred_by) continue;
      if (userId && r.referred_by !== userId) continue;
      if (!referralCounts.has(r.referred_by)) referralCounts.set(r.referred_by, []);
      referralCounts.get(r.referred_by)!.push(r.id);
    }

    for (const [referrerId, referredIds] of referralCounts) {
      if (referredIds.length <= REFERRAL_FARM_MIN) continue;

      // Check how many of ALL referred users have made any bookings.
      // Paginate in batches of 50 (PostgREST .in() limit) to avoid
      // under-counting active users in large referral networks, which would
      // artificially inflate inactiveCount and trigger punitive flags.
      const BATCH_SIZE   = 50;
      const activeIds    = new Set<string>();
      for (let batchStart = 0; batchStart < referredIds.length; batchStart += BATCH_SIZE) {
        const batch = referredIds.slice(batchStart, batchStart + BATCH_SIZE);
        const { data: batchBookings } = await db
          .from("rent_buddy_bookings")
          .select("traveler_id")
          .in("traveler_id", batch);
        for (const b of (batchBookings as any[] ?? [])) {
          activeIds.add(b.traveler_id as string);
        }
      }
      const inactiveCount = referredIds.length - activeIds.size;

      if (inactiveCount >= REFERRAL_FARM_MIN) {
        flags.push({
          patternType:   "referral_farm",
          involvedUsers: [referrerId],
          severity:      inactiveCount > 20 ? "severe" : "high",
          evidence:      {
            referral_count: referredIds.length,
            inactive_count: inactiveCount,
          },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 4. Comment pod — group of users who always comment on each other's posts */
async function detectCommentPods(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since72h = new Date(Date.now() - 72 * 60 * 60 * 1_000).toISOString();

    // Get recent comments with the post author joined
    const q = db
      .from("posts_comments")
      .select("user_id, post_id, created_at")
      .gte("created_at", since72h)
      .is("deleted_at", null);

    if (userId) q.eq("user_id", userId);

    const { data: comments } = await q;
    const commentRows = (comments as any[]) ?? [];
    if (commentRows.length === 0) return flags;

    // Get post authors for these post_ids
    const postIds = [...new Set(commentRows.map((c: any) => c.post_id as string))].slice(0, 100);
    const { data: posts } = await db
      .from("posts")
      .select("id, author_id")
      .in("id", postIds);

    const postAuthorMap = new Map<string, string>();
    for (const p of (posts as any[] ?? [])) {
      postAuthorMap.set(p.id as string, p.author_id as string);
    }

    // Build DIRECTED commenter → post_author pairs.
    // Using directed keys (not sorted) lets us verify true bidirectionality:
    // A one-way heavy commenter does not constitute a mutual pod.
    const directedCounts = new Map<string, number>();
    for (const c of commentRows) {
      const postAuthor = postAuthorMap.get(c.post_id);
      if (!postAuthor || postAuthor === c.user_id) continue; // skip self-comment
      const directedKey = `${c.user_id as string}→${postAuthor}`;
      directedCounts.set(directedKey, (directedCounts.get(directedKey) ?? 0) + 1);
    }

    // A pair (A,B) is mutual only when BOTH A→B ≥ MIN_DIRECTED AND B→A ≥ MIN_DIRECTED.
    // This prevents one-way heavy engagement from triggering punitive reach reduction.
    const mutualPairs = new Set<string>();
    for (const [key, aToB] of directedCounts) {
      if (aToB < COMMENT_POD_MIN_DIRECTED) continue;
      const [commenter, author] = key.split("→") as [string, string];
      const bToA = directedCounts.get(`${author}→${commenter}`) ?? 0;
      if (bToA >= COMMENT_POD_MIN_DIRECTED) {
        // Canonical sorted key so each pair is only counted once
        mutualPairs.add([commenter, author].sort().join("|"));
      }
    }

    if (mutualPairs.size >= COMMENT_POD_MIN_MUTUAL) {
      const involved = [
        ...new Set(
          [...mutualPairs].flatMap((p) => p.split("|")),
        ),
      ].slice(0, 20);

      flags.push({
        patternType:   "comment_pod",
        involvedUsers: involved,
        severity:      mutualPairs.size > 12 ? "high" : "medium",
        evidence:      { mutual_pairs: mutualPairs.size, window_hours: 72 },
      });
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 5. Hashtag spam — >20 uses of the same hashtag from one account in 24 h */
async function detectHashtagSpam(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

    // Get recent hashtag_usage rows; if userId scoped, filter by source posts
    const { data: usageRows } = await db
      .from("hashtag_usage")
      .select("hashtag_id, source_id, source_type, created_at")
      .gte("created_at", since);

    const rows = (usageRows as any[]) ?? [];
    if (rows.length === 0) return flags;

    // Resolve source_id → user_id via the posts table (most usage is post-sourced)
    const postSourceIds = [
      ...new Set(
        rows
          .filter((r: any) => !r.source_type || r.source_type === "post")
          .map((r: any) => r.source_id as string),
      ),
    ].slice(0, 200);

    const postAuthorMap = new Map<string, string>(); // source_id → user_id
    if (postSourceIds.length > 0) {
      const { data: posts } = await db
        .from("posts")
        .select("id, author_id")
        .in("id", postSourceIds);

      for (const p of (posts as any[] ?? [])) {
        postAuthorMap.set(p.id as string, p.author_id as string);
      }
    }

    // Count (user_id, hashtag_id) pairs.
    // Always resolve the actual post author from postAuthorMap — never assume
    // that all rows belong to the scoped userId.  For scoped on-demand scans
    // we filter to rows whose resolved author matches userId; unattributable
    // rows are skipped in both modes.
    const userHashtagCount = new Map<string, number>(); // `${uid}:${hashtagId}` → count
    const userHashtagId    = new Map<string, string>();  // key → hashtagId

    for (const r of rows) {
      const resolvedUid = postAuthorMap.get(r.source_id as string) ?? null;
      // Scoped scan: skip rows that don't belong to the target user
      if (userId !== null && resolvedUid !== userId) continue;
      if (!resolvedUid) continue; // can't attribute — skip in global scan too
      const key = `${resolvedUid}:${r.hashtag_id}`;
      userHashtagCount.set(key, (userHashtagCount.get(key) ?? 0) + 1);
      userHashtagId.set(key, r.hashtag_id as string);
    }

    for (const [key, count] of userHashtagCount) {
      if (count > HASHTAG_SPAM_MIN) {
        const uid = key.split(":")[0]!;
        const hashtagId = userHashtagId.get(key)!;
        flags.push({
          patternType:   "hashtag_spam",
          involvedUsers: [uid],
          severity:      count > 50 ? "severe" : count > 30 ? "high" : "medium",
          evidence:      { hashtag_id: hashtagId, usage_count: count, window_hours: 24 },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 6. Geotag farming — >15 location stamps from one account in 1 hour */
async function detectGeotagFarming(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const q = db
      .from("passport_stamps")
      .select("user_id, created_at")
      .gte("created_at", since);

    if (userId) q.eq("user_id", userId);

    const { data } = await q;
    const rows = (data as any[]) ?? [];

    const countByUser = new Map<string, number>();
    for (const r of rows) {
      countByUser.set(r.user_id, (countByUser.get(r.user_id) ?? 0) + 1);
    }

    for (const [uid, count] of countByUser) {
      if (count > GEOTAG_FARM_MIN) {
        flags.push({
          patternType:   "geotag_farming",
          involvedUsers: [uid],
          severity:      count > 30 ? "severe" : "high",
          evidence:      { stamp_count: count, window_hours: 1 },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 7. Available-now abuse — status toggled >20 times in 24 h with no completed bookings */
async function detectAvailableNowAbuse(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const q = db
      .from("compass_active_user_events")
      .select("user_id, event_type, created_at")
      .eq("event_type", "availability_toggle")
      .gte("created_at", since);

    if (userId) q.eq("user_id", userId);

    const { data } = await q;
    const rows = (data as any[]) ?? [];

    const countByUser = new Map<string, number>();
    for (const r of rows) {
      countByUser.set(r.user_id, (countByUser.get(r.user_id) ?? 0) + 1);
    }

    for (const [uid, toggleCount] of countByUser) {
      if (toggleCount <= AVAILABLE_TOGGLE_MIN) continue;

      // Check if this user has any completed bookings in the same window
      const { data: bookings } = await db
        .from("rent_buddy_bookings")
        .select("id")
        .eq("buddy_id", uid)
        .eq("status", "completed")
        .gte("created_at", since);

      const hasBookings = ((bookings as any[]) ?? []).length > 0;
      if (!hasBookings) {
        flags.push({
          patternType:   "available_now_abuse",
          involvedUsers: [uid],
          severity:      toggleCount > 40 ? "high" : "medium",
          evidence:      { toggle_count: toggleCount, window_hours: 24, bookings_completed: 0 },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

/** 8. Refund abuse — >3 booking cancellations/refunds in 30 days */
async function detectRefundAbuse(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const q = db
      .from("rent_buddy_bookings")
      .select("traveler_id, status, created_at")
      // `refunded` is not a label of the `rent_buddy_booking_status` enum, and
      // Postgres rejects an unknown enum literal outright (22P02) rather than
      // matching nothing — so this read failed WHOLE, `{ data }` was undefined,
      // and detector 8 of 8 has never flagged anyone. There is no refund status
      // in the enum at all; the expressible half of the intent is the
      // traveller's own cancellations, and `cancelled_by_traveler` is the label
      // rentABuddy.ts:1636 writes for exactly that. Buddy-initiated
      // cancellations are deliberately NOT counted here: the rows are grouped
      // by traveler_id, so including them would flag travellers for something
      // they did not do.
      .in("status", ["cancelled", "cancelled_by_traveler"])
      .gte("created_at", since);

    if (userId) q.eq("traveler_id", userId);

    const { data } = await q;
    const rows = (data as any[]) ?? [];

    const countByUser = new Map<string, number>();
    for (const r of rows) {
      countByUser.set(r.traveler_id, (countByUser.get(r.traveler_id) ?? 0) + 1);
    }

    for (const [uid, count] of countByUser) {
      if (count > REFUND_ABUSE_MIN) {
        flags.push({
          patternType:   "refund_abuse",
          involvedUsers: [uid],
          severity:      count > 6 ? "high" : "medium",
          evidence:      { cancellation_count: count, window_days: 30 },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all abuse pattern scans.
 *
 * @param db      Supabase service-role client.
 * @param userId  If provided, scope scans to this user only (on-demand mode).
 *                If null, run globally (scheduled mode).
 * @returns       The number of new flags written.
 */
export async function runScan(
  db:     SupabaseClient | null,
  userId: string | null = null,
): Promise<{ flagsWritten: number }> {
  if (!db) return { flagsWritten: 0 };

  let flagsWritten = 0;

  try {
    const [rings, loops, referrals, pods, hashtags, geotags, available, refunds] =
      await Promise.allSettled([
        detectMutualReviewRings(db, userId),
        detectBookingLoops(db, userId),
        detectReferralFarms(db, userId),
        detectCommentPods(db, userId),
        detectHashtagSpam(db, userId),
        detectGeotagFarming(db, userId),
        detectAvailableNowAbuse(db, userId),
        detectRefundAbuse(db, userId),
      ]);

    const allFlags: AbuseFlag[] = [
      ...(rings.status     === "fulfilled" ? rings.value     : []),
      ...(loops.status     === "fulfilled" ? loops.value     : []),
      ...(referrals.status === "fulfilled" ? referrals.value : []),
      ...(pods.status      === "fulfilled" ? pods.value      : []),
      ...(hashtags.status  === "fulfilled" ? hashtags.value  : []),
      ...(geotags.status   === "fulfilled" ? geotags.value   : []),
      ...(available.status === "fulfilled" ? available.value : []),
      ...(refunds.status   === "fulfilled" ? refunds.value   : []),
    ];

    await Promise.allSettled(
      allFlags.map(async (flag) => {
        await handleFlag(db, flag);
        flagsWritten++;
      }),
    );
  } catch { /* non-fatal — scheduler must not crash */ }

  return { flagsWritten };
}
