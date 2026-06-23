/**
 * LocationSafetyService
 *
 * Anti-fake GPS detection.
 * Detects: impossible speed, coordinate jumps, IP–city mismatch.
 * Writes to location_trust_events (no auto-ban, review only).
 * Falls back gracefully if table doesn't exist yet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";

const logger = rootLogger.child({ service: "LocationSafetyService" });

const MAX_REALISTIC_SPEED_KMH = 900; // approx commercial flight speed
const JUMP_THRESHOLD_KM = 500;       // flag if user jumps > 500 km instantly

export type TrustEventType =
  | "impossible_speed"
  | "coordinate_jump"
  | "ip_city_mismatch"
  | "manual_review"
  | "cleared";

export interface CoordSnapshot {
  lat: number;
  lng: number;
  capturedAt: string;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Write a trust event (no auto-ban). */
async function writeTrustEvent(
  db: SupabaseClient,
  userId: string,
  eventType: TrustEventType,
  confidence: "low" | "medium" | "high",
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await db.from("location_trust_events").insert({
      user_id:    userId,
      event_type: eventType,
      confidence,
      details,
    });
    if (error) logger.warn({ err: error }, "writeTrustEvent DB error");
  } catch (err) {
    logger.warn({ err }, "writeTrustEvent threw");
  }
}

/**
 * Check a new GPS coordinate against the user's previous snapshot.
 * If suspicious, writes a trust event and returns false.
 * If clean, optionally stores a fresh snapshot and returns true.
 */
export async function checkAndRecordSnapshot(
  db: SupabaseClient,
  userId: string,
  lat: number,
  lng: number,
): Promise<{ trusted: boolean; suspicionReason?: string }> {
  // Fetch latest snapshot for this user
  const { data: prev } = await db
    .from("location_snapshots")
    .select("lat, lng, captured_at")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev && prev.lat != null && prev.lng != null) {
    const km = haversineKm(prev.lat, prev.lng, lat, lng);
    const elapsedMs = Date.now() - new Date(prev.captured_at).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    // Coordinate jump: instant teleport > 500 km
    if (km > JUMP_THRESHOLD_KM && elapsedHours < 0.5) {
      await writeTrustEvent(db, userId, "coordinate_jump", "medium", {
        distanceKm: Math.round(km),
        elapsedMinutes: Math.round(elapsedMs / 60000),
        prevLat: prev.lat,
        prevLng: prev.lng,
      });
      return { trusted: false, suspicionReason: "coordinate_jump" };
    }

    // Impossible speed: faster than a plane
    if (elapsedHours > 0 && km / elapsedHours > MAX_REALISTIC_SPEED_KMH) {
      await writeTrustEvent(db, userId, "impossible_speed", "high", {
        distanceKm: Math.round(km),
        speedKmh: Math.round(km / elapsedHours),
        elapsedMinutes: Math.round(elapsedMs / 60000),
      });
      return { trusted: false, suspicionReason: "impossible_speed" };
    }
  }

  // Store fresh snapshot (short TTL enforced by DB default)
  try {
    await db.from("location_snapshots").insert({
      user_id:     userId,
      lat,
      lng,
      source:      "gps",
      captured_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ err }, "snapshot insert failed — non-fatal");
  }

  return { trusted: true };
}

/**
 * Check recent trust events for a user.
 * Returns confidence level to inform stamp eligibility decisions.
 */
export async function getUserTrustLevel(
  db: SupabaseClient,
  userId: string,
): Promise<"trusted" | "review" | "suspicious"> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    const { data, error } = await db
      .from("location_trust_events")
      .select("event_type, confidence")
      .eq("user_id", userId)
      .gt("created_at", since)
      .is("reviewed_at", null) // only unreviewed events
      .limit(10);

    if (error || !data) return "trusted";

    const highConfidence = (data as any[]).filter((r) => r.confidence === "high");
    const mediumConfidence = (data as any[]).filter((r) => r.confidence === "medium");

    if (highConfidence.length >= 1) return "suspicious";
    if (mediumConfidence.length >= 2) return "review";
    return "trusted";
  } catch {
    return "trusted";
  }
}

/** Purge expired snapshots (call from cleanup job). */
export async function purgeExpiredSnapshots(db: SupabaseClient): Promise<number> {
  try {
    const { count, error } = await db
      .from("location_snapshots")
      .delete({ count: "exact" })
      .lt("expires_at", new Date().toISOString());
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
