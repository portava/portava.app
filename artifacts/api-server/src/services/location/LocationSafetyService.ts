/**
 * LocationSafetyService
 *
 * Anti-fake GPS detection.
 * Detects: impossible speed, coordinate jumps, IP–city mismatch.
 * Writes to location_trust_events (legacy table, no auto-ban, review only).
 * Also feeds signals into the Trust Engine via TrustEventService when
 * trust_engine_enabled flag is on.
 * Falls back gracefully if table doesn't exist yet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";
import { recordLocationTrustEvent } from "../trust/TrustEventService.js";

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

export type JourneyObservationTrustClass =
  | "accepted"
  | "low_accuracy"
  | "suspicious"
  | "manual";

/**
 * Pure classification for the restricted Journey boundary.
 *
 * This intentionally does not log coordinates or copy them to trust-event
 * details. Persisted raw evidence stays in journey_observations and expires
 * with that row.
 */
export function classifyJourneyObservationTrust(
  accuracyM: number | null,
  speedMps: number | null,
): JourneyObservationTrustClass {
  if (accuracyM === null) return "manual";
  if (speedMps !== null && speedMps > MAX_REALISTIC_SPEED_KMH / 3.6) {
    return "suspicious";
  }
  if (accuracyM > 100) return "low_accuracy";
  return "accepted";
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
  const nowMs = Date.now();
  // Fetch latest snapshot for this user
  const { data: prev } = await db
    .from("location_snapshots")
    .select("lat, lng, captured_at")
    .eq("user_id", userId)
    .gt("expires_at", new Date(nowMs).toISOString())
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prev && prev.lat != null && prev.lng != null) {
    const km = haversineKm(prev.lat, prev.lng, lat, lng);
    const elapsedMs = nowMs - new Date(prev.captured_at).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    // Coordinate jump: instant teleport > 500 km
    if (km > JUMP_THRESHOLD_KM && elapsedHours < 0.5) {
      await writeTrustEvent(db, userId, "coordinate_jump", "medium", {
        distanceKm: Math.round(km),
        elapsedMinutes: Math.round(elapsedMs / 60000),
        prevLat: prev.lat,
        prevLng: prev.lng,
      });
      // Also feed into the Trust Engine (fire-and-forget; flag-gated internally)
      void recordLocationTrustEvent(db, userId, "coordinate_jump", "medium");
      return { trusted: false, suspicionReason: "coordinate_jump" };
    }

    // Impossible speed: faster than a plane
    if (elapsedHours > 0 && km / elapsedHours > MAX_REALISTIC_SPEED_KMH) {
      await writeTrustEvent(db, userId, "impossible_speed", "high", {
        distanceKm: Math.round(km),
        speedKmh: Math.round(km / elapsedHours),
        elapsedMinutes: Math.round(elapsedMs / 60000),
      });
      // Also feed into the Trust Engine (fire-and-forget; flag-gated internally)
      void recordLocationTrustEvent(db, userId, "impossible_speed", "high");
      return { trusted: false, suspicionReason: "impossible_speed" };
    }
  }

  // Store fresh snapshot (short TTL enforced by DB default)
  {
    const { error: snapError } = await db.from("location_snapshots").insert({
      user_id:     userId,
      lat,
      lng,
      source:      "gps",
      captured_at: new Date(nowMs).toISOString(),
    });
    if (snapError) logger.warn({ err: snapError }, "snapshot insert failed — non-fatal");
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

/**
 * IP–city mismatch detection.
 *
 * Queries ip-api.com (free, no auth) to resolve the request IP to a city.
 * If the city doesn't match the user-reported city, writes a medium-confidence
 * ip_city_mismatch trust event. Falls back gracefully on network error or when
 * the IP is private/unresolvable (loopback, RFC 1918, IPv6 localhost).
 *
 * Call fire-and-forget from the location-state write path.
 */
export async function checkIpCityMismatch(
  db: SupabaseClient,
  userId: string,
  reportedCity: string,
  requestIp: string | undefined,
): Promise<void> {
  if (!requestIp) return;

  // Skip private / loopback addresses — can't geolocate them
  const skip = ["127.", "10.", "172.16.", "172.17.", "172.18.", "172.19.",
                "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
                "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
                "192.168.", "::1", "localhost"];
  if (skip.some((prefix) => requestIp.startsWith(prefix))) return;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3_000);
    let ipCity: string | null = null;

    try {
      const response = await fetch(
        `https://ip-api.com/json/${encodeURIComponent(requestIp)}?fields=status,city`,
        { signal: ctrl.signal },
      );
      if (response.ok) {
        const data = (await response.json()) as { status: string; city?: string };
        if (data.status === "success" && data.city) ipCity = data.city;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!ipCity) return;

    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalise(ipCity) === normalise(reportedCity)) return;

    await writeTrustEvent(db, userId, "ip_city_mismatch", "medium", {
      reportedCity,
      ipCity,
      requestIp: requestIp.slice(0, 8) + "...", // partial IP only — no full IP in DB
    });
  } catch {
    // Non-fatal — IP lookup failures are common (network, rate limits)
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
