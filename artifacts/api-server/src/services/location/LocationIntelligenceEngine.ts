/**
 * LocationIntelligenceEngine
 *
 * Converts raw coordinates into a public-safe context object.
 * Exact lat/lng NEVER leaves this module in any public-facing form.
 *
 * Public context contains only:
 *   - city, district, country (text labels)
 *   - approximate distance bucket (< 1 km / nearby / same city / etc.)
 *   - freshness label
 */
import { reverseGeocode, type PlaceResult } from "../geocodingService";

export type DistanceBucket =
  | "same_venue"        // < 100 m
  | "same_neighborhood" // < 500 m
  | "nearby"            // < 2 km
  | "same_city"         // same city text match
  | "within_x_km"       // 2–50 km — includes rounded km value
  | "distant"           // > 50 km
  | "unknown";

export interface PublicLocationContext {
  city: string | null;
  district: string | null;
  country: string | null;
  countryCode: string | null;
  distanceBucket: DistanceBucket;
  distanceKm: number | null;    // rounded to nearest km; null if unknown
  proximityLabel: string;       // human label: "Nearby", "In your area", etc.
  freshness: "live" | "recent" | "stale" | "unavailable";
  // coords intentionally absent
}

// ── Haversine (internal only) ─────────────────────────────────────────────────

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

function toBucket(km: number): DistanceBucket {
  if (km < 0.1)  return "same_venue";
  if (km < 0.5)  return "same_neighborhood";
  if (km < 2)    return "nearby";
  if (km < 50)   return "within_x_km";
  return "distant";
}

function toProximityLabel(bucket: DistanceBucket, km: number | null): string {
  switch (bucket) {
    case "same_venue":        return "Same venue";
    case "same_neighborhood": return "Same neighborhood";
    case "nearby":            return "Nearby";
    case "same_city":         return "In this city";
    case "within_x_km":      return km != null ? `~${Math.round(km)} km away` : "In the area";
    case "distant":           return "Far away";
    default:                  return "In the area";
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a public-safe context from a user's exact coords + optional viewer coords.
 * Viewer coords are used only to compute an approximate distance bucket — they
 * are never included in the returned object.
 */
export async function buildPublicContext(opts: {
  userLat: number;
  userLng: number;
  viewerLat?: number | null;
  viewerLng?: number | null;
  cachedPlace?: PlaceResult | null;
  lastUpdatedAt?: string | null;
}): Promise<PublicLocationContext> {
  const place = opts.cachedPlace ?? await reverseGeocode(opts.userLat, opts.userLng);

  let distanceKm: number | null = null;
  let bucket: DistanceBucket = "unknown";

  if (opts.viewerLat != null && opts.viewerLng != null) {
    distanceKm = Math.round(haversineKm(opts.viewerLat, opts.viewerLng, opts.userLat, opts.userLng) * 10) / 10;
    bucket = toBucket(distanceKm);
  }

  const freshness = computeFreshness(opts.lastUpdatedAt ?? null);

  return {
    city: place.city,
    district: place.district,
    country: place.country,
    countryCode: place.countryCode,
    distanceBucket: bucket,
    distanceKm,
    proximityLabel: toProximityLabel(bucket, distanceKm),
    freshness,
  };
}

/** City-level context only (no coords needed). */
export function buildCityContext(place: PlaceResult, lastUpdatedAt?: string | null): PublicLocationContext {
  return {
    city: place.city,
    district: place.district,
    country: place.country,
    countryCode: place.countryCode,
    distanceBucket: "unknown",
    distanceKm: null,
    proximityLabel: place.city ? `In ${place.city}` : "In this city",
    freshness: computeFreshness(lastUpdatedAt ?? null),
  };
}

function computeFreshness(lastUpdatedAt: string | null): "live" | "recent" | "stale" | "unavailable" {
  if (!lastUpdatedAt) return "unavailable";
  const age = Date.now() - new Date(lastUpdatedAt).getTime();
  const RECENT = 15 * 60 * 1000;
  const STALE  = 60 * 60 * 1000;
  if (age < RECENT) return "live";
  if (age < STALE)  return "recent";
  return "stale";
}
