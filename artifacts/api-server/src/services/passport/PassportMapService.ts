/**
 * PassportMapService
 *
 * Builds the privacy-safe passport map payload.
 * INVARIANT: Never returns exact lat/lng coordinates.
 * Returns only city-level and neighborhood-zone markers aggregated from passport_stamps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerContext } from "./PassportPrivacyGuard.js";
import { filterStamps } from "./PassportPrivacyGuard.js";
import type { StampRow } from "./PassportPrivacyGuard.js";

export interface MapMarker {
  country: string;
  city: string;
  neighborhood: string | null;
  stampCount: number;
  verificationLevel: string;
  /** Coarse label for UI display — never raw coordinates */
  displayLabel: string;
}

export interface PassportMapPayload {
  markers: MapMarker[];
  countries: string[];
  cities: string[];
}

/**
 * Build the privacy-safe map payload for a user.
 * callerCtx controls which stamps are included based on visibility.
 */
export async function buildMapPayload(
  db: SupabaseClient,
  userId: string,
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): Promise<PassportMapPayload> {
  const { data, error } = await db
    .from("passport_stamps")
    .select("id, stamp_type, country, city, neighborhood, place_id, plan_id, trip_id, source_type, verification_level, visibility, earned_at, created_at")
    .eq("user_id", userId)
    .not("city", "is", null)
    .order("earned_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    return { markers: [], countries: [], cities: [] };
  }

  const stamps = data as StampRow[];
  const visible = filterStamps(stamps, callerCtx, opts);

  // Aggregate by city
  const cityMap = new Map<string, MapMarker>();
  for (const stamp of visible) {
    if (!stamp.city) continue;
    const key = `${stamp.country ?? ""}|${stamp.city}`;
    if (cityMap.has(key)) {
      const existing = cityMap.get(key)!;
      existing.stampCount += 1;
      // Upgrade verification level (gps > checkin > unverified)
      if (verificationRank(stamp.verification_level) > verificationRank(existing.verificationLevel)) {
        existing.verificationLevel = stamp.verification_level;
      }
    } else {
      cityMap.set(key, {
        country: stamp.country ?? "",
        city: stamp.city,
        neighborhood: stamp.neighborhood ?? null,
        stampCount: 1,
        verificationLevel: stamp.verification_level,
        displayLabel: stamp.city + (stamp.country ? `, ${stamp.country}` : ""),
      });
    }
  }

  const markers = Array.from(cityMap.values());
  const countries = [...new Set(markers.map((m) => m.country).filter(Boolean))].sort();
  const cities = [...new Set(markers.map((m) => m.city).filter(Boolean))].sort();

  return { markers, countries, cities };
}

function verificationRank(level: string): number {
  switch (level) {
    case "admin":       return 5;
    case "crew":        return 4;
    case "safe_return": return 3;
    case "checkin":     return 2;
    case "gps":         return 1;
    default:            return 0;
  }
}

/**
 * Compute passport stats for a user.
 */
export async function buildStats(
  db: SupabaseClient,
  userId: string,
): Promise<{
  countries: number;
  cities: number;
  neighborhoods: number;
  planStamps: number;
  hostStamps: number;
  hiddenGemStamps: number;
  safeReturnStamps: number;
  totalStamps: number;
}> {
  const { data, error } = await db
    .from("passport_stamps")
    .select("stamp_type, country, city, neighborhood, visibility")
    .eq("user_id", userId);

  if (error || !data) {
    return {
      countries: 0, cities: 0, neighborhoods: 0,
      planStamps: 0, hostStamps: 0, hiddenGemStamps: 0,
      safeReturnStamps: 0, totalStamps: 0,
    };
  }

  const rows = data as any[];
  const countries = new Set<string>();
  const cities = new Set<string>();
  const neighborhoods = new Set<string>();
  let planStamps = 0, hostStamps = 0, hiddenGemStamps = 0, safeReturnStamps = 0;

  for (const r of rows) {
    if (r.country) countries.add(r.country);
    if (r.city) cities.add(r.city);
    if (r.neighborhood) neighborhoods.add(r.neighborhood);
    if (r.stamp_type === "plan") planStamps++;
    if (r.stamp_type === "host") hostStamps++;
    if (r.stamp_type === "hidden_gem") hiddenGemStamps++;
    if (r.stamp_type === "safe_return") safeReturnStamps++;
  }

  return {
    countries: countries.size,
    cities: cities.size,
    neighborhoods: neighborhoods.size,
    planStamps,
    hostStamps,
    hiddenGemStamps,
    safeReturnStamps,
    totalStamps: rows.length,
  };
}
