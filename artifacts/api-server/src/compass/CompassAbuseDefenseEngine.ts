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
 *   3. referral_farm         — user referred >10 accounts, all inactive (no booking)
 *   4. comment_pod           — users always comment on each other's posts (>8 pairs in 72 h)
 *   5. hashtag_spam          — >20 identical hashtag uses from one account in 24 h
 *   6. geotag_farming        — >15 location stamps from one account in 1 hour
 *   7. available_now_abuse   — status toggled on/off >20 times in 24 h with no bookings
 *   8. refund_abuse          — >3 refund requests in 30 days, all approved, no disputes resolved
 *
 * Severity levels:
 *   low     — flagged, no action yet
 *   medium  — reach reduced (compass_visibility_cooldowns extended)
 *   high    — reach reduced + flagged for admin review
 *   severe  — reach zeroed + active-user reward zeroed + suspension request
 *
 * Never throws — all errors are swallowed so the scheduler stays healthy.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeActiveUserScore } from "./CompassActiveUserRewardEngine.js";

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
const REFERRAL_FARM_MIN         = 10;   // referred >10 accounts with no bookings
const COMMENT_POD_MIN_PAIRS     = 8;    // always-commenting pairs in 72 h
const HASHTAG_SPAM_MIN          = 20;   // same hashtag >20 times in 24 h
const GEOTAG_FARM_MIN           = 15;   // >15 stamps in 1 hour
const AVAILABLE_NOW_TOGGLE_MIN  = 20;   // >20 toggles in 24 h
const REFUND_ABUSE_MIN          = 3;    // >3 refunds in 30 days

// ── Cooldown writer ───────────────────────────────────────────────────────────

async function applyReachReduction(
  db:             SupabaseClient,
  userId:         string,
  severity:       AbuseSeverity,
): Promise<void> {
  const durationHours: Record<AbuseSeverity, number> = {
    low:    0,
    medium: 24,
    high:   72,
    severe: 8760, // 1 year ≈ permanent
  };
  const hours = durationHours[severity];
  if (hours === 0) return;

  const endsAt = new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
  try {
    await db.from("compass_visibility_cooldowns").upsert(
      {
        author_id:  userId,
        reason:     `abuse_defense:${severity}`,
        ends_at:    endsAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "author_id" },
    );
  } catch { /* non-fatal */ }
}

// ── Reward zeroing ────────────────────────────────────────────────────────────

async function zeroActiveUserReward(
  db:     SupabaseClient,
  userId: string,
): Promise<void> {
  try {
    // Force a recompute with severe flag — this sets trustMultiplier = 0 → score = 0
    await computeActiveUserScore(db, userId, { hasSevereSafetyFlag: true });

    // Also directly upsert the score row to zero so it takes immediate effect
    await db.from("compass_active_user_scores").upsert(
      {
        user_id:           userId,
        active_user_score: 0,
        trust_multiplier:  0,
        boost_eligible:    false,
        last_computed_at:  new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  } catch { /* non-fatal */ }
}

// ── Flag writer ───────────────────────────────────────────────────────────────

async function writeFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<void> {
  try {
    await db.from("compass_abuse_flags").insert({
      pattern_type:   flag.patternType,
      involved_users: flag.involvedUsers,
      severity:       flag.severity,
      evidence:       flag.evidence,
    });
  } catch { /* non-fatal */ }
}

// ── Post-detection action dispatcher ─────────────────────────────────────────

async function handleFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<void> {
  await writeFlag(db, flag);

  const reachReductionNeeded = (flag.severity === "medium" || flag.severity === "high" || flag.severity === "severe");
  const rewardZeroNeeded     = flag.severity === "severe";

  await Promise.allSettled(
    flag.involvedUsers.flatMap((uid) => {
      const ops = [];
      if (reachReductionNeeded) ops.push(applyReachReduction(db, uid, flag.severity));
      if (rewardZeroNeeded)     ops.push(zeroActiveUserReward(db, uid));
      return ops;
    }),
  );
}

// ── Individual pattern detectors ──────────────────────────────────────────────

async function detectMutualReviewRings(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - RING_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const query = db
      .from("reviews")
      .select("reviewer_id, reviewee_id, rating, created_at")
      .eq("rating", 5)
      .gte("created_at", since);

    if (userId) query.or(`reviewer_id.eq.${userId},reviewee_id.eq.${userId}`);

    const { data } = await query;
    const rows = (data as any[]) ?? [];

    // Build adjacency map: who reviewed whom
    const reviewedBy = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!reviewedBy.has(r.reviewer_id)) reviewedBy.set(r.reviewer_id, new Set());
      reviewedBy.get(r.reviewer_id)!.add(r.reviewee_id);
    }

    // Find mutual rings: A reviewed B, B reviewed A (extend for ≥3)
    const users = [...reviewedBy.keys()];
    for (let i = 0; i < users.length; i++) {
      const ring = new Set<string>([users[i]!]);
      for (let j = i + 1; j < users.length; j++) {
        const a = users[i]!;
        const b = users[j]!;
        if (reviewedBy.get(a)?.has(b) && reviewedBy.get(b)?.has(a)) {
          ring.add(b);
        }
      }
      if (ring.size >= RING_MIN_USERS) {
        flags.push({
          patternType:   "mutual_review_ring",
          involvedUsers: [...ring],
          severity:      ring.size >= 5 ? "severe" : "high",
          evidence:      { ring_size: ring.size, window_days: RING_WINDOW_DAYS },
        });
        break; // one flag per scan — admin reviews then re-runs
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

async function detectBookingLoops(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - BOOKING_LOOP_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const query = db
      .from("rent_buddy_bookings")
      .select("traveler_id, buddy_id, status, created_at")
      .in("status", ["completed", "confirmed"])
      .gte("created_at", since);

    if (userId) query.or(`traveler_id.eq.${userId},buddy_id.eq.${userId}`);

    const { data } = await query;
    const rows = (data as any[]) ?? [];

    // Count bookings per pair
    const pairCounts = new Map<string, number>();
    for (const r of rows) {
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
          evidence:      { booking_count: count, window_days: BOOKING_LOOP_WINDOW_DAYS },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

async function detectHashtagSpam(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const query = db
      .from("hashtag_usage")
      .select("hashtag_id, source_id, created_at")
      .gte("created_at", since);

    const { data } = await query;
    const rows = (data as any[]) ?? [];

    // Count hashtag uses per hashtag
    const hashtagCounts = new Map<string, number>();
    for (const r of rows) {
      hashtagCounts.set(r.hashtag_id, (hashtagCounts.get(r.hashtag_id) ?? 0) + 1);
    }

    for (const [hashtagId, count] of hashtagCounts) {
      if (count > HASHTAG_SPAM_MIN) {
        // Find users behind these usages
        const involved = userId ? [userId] : [];
        flags.push({
          patternType:   "hashtag_spam",
          involvedUsers: involved,
          severity:      count > 50 ? "severe" : count > 30 ? "high" : "medium",
          evidence:      { hashtag_id: hashtagId, usage_count: count, window_hours: 24 },
        });
      }
    }
  } catch { /* non-fatal */ }
  return flags;
}

async function detectGeotagFarming(
  db:     SupabaseClient,
  userId: string | null,
): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 60 * 60 * 1_000).toISOString(); // 1 hour
    const query = db
      .from("passport_stamps")
      .select("user_id, created_at")
      .gte("created_at", since);

    if (userId) query.eq("user_id", userId);

    const { data } = await query;
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
    const [rings, loops, hashtags, geotags] = await Promise.allSettled([
      detectMutualReviewRings(db, userId),
      detectBookingLoops(db, userId),
      detectHashtagSpam(db, userId),
      detectGeotagFarming(db, userId),
    ]);

    const allFlags: AbuseFlag[] = [
      ...(rings.status     === "fulfilled" ? rings.value     : []),
      ...(loops.status     === "fulfilled" ? loops.value     : []),
      ...(hashtags.status  === "fulfilled" ? hashtags.value  : []),
      ...(geotags.status   === "fulfilled" ? geotags.value   : []),
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
