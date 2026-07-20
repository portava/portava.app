/**
 * TrustGamingDetectionService
 *
 * Scheduled / on-demand scan for gaming patterns.
 * Never auto-penalises — only creates trust_reviews of type 'gaming_suspected'.
 *
 * Detects:
 *  1. Same-location check-in cluster farming (daily limit exceeded)
 *  2. Mutual upvote rings (pair/group mutual engagement above threshold)
 *  3. Rapid score jumps inconsistent with event history
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TrustGamingDetectionService" });

interface GamingSettings {
  gaming_checkin_cluster_limit: number;
  gaming_mutual_rate_threshold: number;
  gaming_rapid_jump_points: number;
}

async function loadGamingSettings(db: SupabaseClient): Promise<GamingSettings> {
  const { data, error } = await db.from("trust_settings").select("*").eq("id", 1).maybeSingle();
  if (error) {
    logger.warn({ err: error }, "loadGamingSettings failed — using defaults");
    return { gaming_checkin_cluster_limit: 5, gaming_mutual_rate_threshold: 0.80, gaming_rapid_jump_points: 20 };
  }
  return {
    gaming_checkin_cluster_limit:  Number((data as any)?.gaming_checkin_cluster_limit)  || 5,
    gaming_mutual_rate_threshold:  Number((data as any)?.gaming_mutual_rate_threshold)  || 0.80,
    gaming_rapid_jump_points:      Number((data as any)?.gaming_rapid_jump_points)      || 20,
  };
}

async function isGamingDetectionEnabled(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from("feature_flags")
    .select("enabled")
    .eq("key", "trust_gaming_detection_enabled")
    .maybeSingle();
  if (error) {
    logger.warn({ err: error }, "isGamingDetectionEnabled flag read failed — treating as disabled");
    return false;
  }
  return Boolean((data as any)?.enabled);
}

async function createGamingReview(
  db: SupabaseClient,
  userId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Only create if no open gaming review already exists for this user (non-fatal)
  const { data: existing, error: readError } = await db
    .from("trust_reviews")
    .select("id")
    .eq("user_id", userId)
    .eq("review_type", "gaming_suspected")
    .in("status", ["open", "in_progress"])
    .maybeSingle();
  if (readError) {
    logger.warn({ err: readError, userId }, "createGamingReview existing-check failed (non-fatal)");
    return;
  }
  if (existing) return;

  const { error: insError } = await db.from("trust_reviews").insert({
    user_id:     userId,
    review_type: "gaming_suspected",
    status:      "open",
    metadata,
  });
  if (insError) logger.warn({ err: insError, userId }, "createGamingReview insert failed (non-fatal)");
}

/**
 * Scan for same-location check-in clusters.
 * Flags users with more than gaming_checkin_cluster_limit check-ins
 * at the same geofence within 24 hours.
 */
async function detectCheckinClusters(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<number> {
  let flagged = 0;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("plan_attendance_events")
      .select("user_id, geofence_id")
      .gt("created_at", since)
      .eq("event_type", "checked_in");

    if (error) {
      logger.warn({ err: error }, "detectCheckinClusters query failed");
      return 0;
    }
    if (!data) return 0;
    const rows = data as any[];

    // Group by user+geofence
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.geofence_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of counts) {
      if (count > settings.gaming_checkin_cluster_limit) {
        const [userId] = key.split(":");
        await createGamingReview(db, userId, {
          pattern: "checkin_cluster",
          checkinCount: count,
          limit: settings.gaming_checkin_cluster_limit,
        });
        flagged++;
      }
    }
  } catch {
    // non-fatal
  }
  return flagged;
}

/**
 * Detect mutual upvote rings.
 * Looks for pairs of users where > threshold% of each other's positive events
 * come from the same counterpart.
 */
async function detectMutualRings(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<number> {
  let flagged = 0;
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trust_events")
      .select("user_id, source_type, source_id")
      .gt("created_at", since)
      .gt("delta", 0)
      .eq("source_type", "user_action");

    if (error) {
      logger.warn({ err: error }, "detectMutualRings query failed");
      return 0;
    }
    if (!data) return 0;
    const rows = data as any[];

    // Count total positive events per user
    const totalPerUser = new Map<string, number>();
    // Count events sourced from a specific other user
    const pairCounts = new Map<string, number>();

    for (const row of rows) {
      totalPerUser.set(row.user_id, (totalPerUser.get(row.user_id) ?? 0) + 1);
      if (row.source_id) {
        const key = `${row.user_id}:${row.source_id}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }

    for (const [key, count] of pairCounts) {
      const [userId, sourceId] = key.split(":");
      const total = totalPerUser.get(userId) ?? 0;
      if (total === 0) continue;
      const rate = count / total;
      // Check mutual: sourceId also heavily depends on userId
      const reverseKey = `${sourceId}:${userId}`;
      const reverseCount = pairCounts.get(reverseKey) ?? 0;
      const reverseTotal = totalPerUser.get(sourceId) ?? 0;
      const reverseRate = reverseTotal > 0 ? reverseCount / reverseTotal : 0;

      if (rate > settings.gaming_mutual_rate_threshold && reverseRate > settings.gaming_mutual_rate_threshold) {
        await createGamingReview(db, userId, {
          pattern: "mutual_ring",
          withUserId: sourceId,
          rate,
          reverseRate,
        });
        flagged++;
      }
    }
  } catch {
    // non-fatal
  }
  return flagged;
}

/**
 * Detect rapid score jumps.
 * Flags users whose score increased by > gaming_rapid_jump_points
 * within a 24-hour window, inconsistent with normal event history.
 */
async function detectRapidJumps(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<number> {
  let flagged = 0;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trust_events")
      .select("user_id, delta, created_at")
      .gt("created_at", since)
      .in("status", ["applied", "confirmed"]);

    if (error) {
      logger.warn({ err: error }, "detectRapidJumps query failed");
      return 0;
    }
    if (!data) return 0;
    const rows = data as any[];

    const deltaPerUser = new Map<string, number>();
    for (const row of rows) {
      deltaPerUser.set(row.user_id, (deltaPerUser.get(row.user_id) ?? 0) + (row.delta ?? 0));
    }

    for (const [userId, total] of deltaPerUser) {
      if (total > settings.gaming_rapid_jump_points) {
        await createGamingReview(db, userId, {
          pattern: "rapid_jump",
          deltaIn24h: total,
          threshold: settings.gaming_rapid_jump_points,
        });
        flagged++;
      }
    }
  } catch {
    // non-fatal
  }
  return flagged;
}

/** Run all gaming detection scans */
export async function runGamingDetectionScan(db: SupabaseClient): Promise<{
  ok: boolean;
  flaggedUsers: number;
  skipped?: boolean;
}> {
  if (!await isGamingDetectionEnabled(db)) {
    return { ok: true, flaggedUsers: 0, skipped: true };
  }

  const settings = await loadGamingSettings(db);
  const [clusters, rings, jumps] = await Promise.all([
    detectCheckinClusters(db, settings),
    detectMutualRings(db, settings),
    detectRapidJumps(db, settings),
  ]);

  return { ok: true, flaggedUsers: clusters + rings + jumps };
}
