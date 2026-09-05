/**
 * GeoZoneService
 *
 * Polygon/radius lookups for geo_zones and place_profiles.
 * Used by Discovery and Pulse to scope by neighborhood.
 * Falls back gracefully if the table doesn't exist yet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface GeoZone {
  id: string;
  zoneType: string;
  name: string;
  city: string | null;
  countryCode: string | null;
  centerLat: number | null;
  centerLng: number | null;
  radiusMeters: number | null;
  safetyRating: string | null;
  featured: boolean;
}

export interface PlaceProfile {
  id: string;
  osmId: string | null;
  name: string;
  placeType: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  safetyNote: string | null;
}

// ── Haversine ─────────────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

/** Find neighborhood zones containing a given coordinate. */
export async function findZonesAt(
  db: SupabaseClient,
  lat: number,
  lng: number,
  maxResults = 5,
): Promise<GeoZone[]> {
  try {
    const { data, error } = await db
      .from("geo_zones")
      .select("id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, safety_rating, featured")
      // `geo_zones.zone_type` is TEXT with a CHECK permitting
      // city | neighborhood | venue | airport | hotel | custom. "district" is
      // not among them, so it could never match a row — this is the silent
      // half of the class (a CHECK, not an enum, so PostgREST does not raise).
      // `neighborhood` is the label this function's own name refers to.
      .in("zone_type", ["neighborhood"])
      .limit(100);

    if (error || !data) return [];

    // Client-side radius check — no PostGIS required
    return (data as any[])
      .filter((z) => {
        if (!z.center_lat || !z.center_lng || !z.radius_meters) return false;
        const km = haversineKm(lat, lng, z.center_lat, z.center_lng);
        return km * 1000 <= z.radius_meters;
      })
      .slice(0, maxResults)
      .map(mapZone);
  } catch {
    return [];
  }
}

/** Find zones by city name. */
export async function findZonesByCity(
  db: SupabaseClient,
  city: string,
): Promise<GeoZone[]> {
  try {
    const { data, error } = await db
      .from("geo_zones")
      .select("id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, safety_rating, featured")
      .ilike("city", city.trim())
      .order("featured", { ascending: false });

    if (error || !data) return [];
    return (data as any[]).map(mapZone);
  } catch {
    return [];
  }
}

/** Get verified/featured place profiles for a city. */
export async function getVerifiedPlaces(
  db: SupabaseClient,
  city: string,
  limit = 20,
): Promise<PlaceProfile[]> {
  try {
    const { data, error } = await db
      .from("place_profiles")
      .select("id, osm_id, name, place_type, city, lat, lng, status, safety_note")
      .ilike("city", city.trim())
      .in("status", ["verified", "featured"])
      .limit(limit);

    if (error || !data) return [];
    return (data as any[]).map(mapProfile);
  } catch {
    return [];
  }
}

/** Is this coordinate within ~200 m of a known private stay? */
export async function isNearPrivateStay(
  db: SupabaseClient,
  userId: string,
  lat: number,
  lng: number,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("location_sessions")
      .select("lat, lng")
      .eq("user_id", userId)
      .eq("session_type", "private_stay")
      .is("ended_at", null)
      .limit(10);

    if (error || !data) return false;

    return (data as any[]).some((row) => {
      if (!row.lat || !row.lng) return false;
      return haversineKm(lat, lng, row.lat, row.lng) * 1000 < 200;
    });
  } catch {
    return false;
  }
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function mapZone(r: any): GeoZone {
  return {
    id:           r.id,
    zoneType:     r.zone_type,
    name:         r.name,
    city:         r.city ?? null,
    countryCode:  r.country_code ?? null,
    centerLat:    r.center_lat != null ? Number(r.center_lat) : null,
    centerLng:    r.center_lng != null ? Number(r.center_lng) : null,
    radiusMeters: r.radius_meters != null ? Number(r.radius_meters) : null,
    safetyRating: r.safety_rating ?? null,
    featured:     Boolean(r.featured),
  };
}

function mapProfile(r: any): PlaceProfile {
  return {
    id:          r.id,
    osmId:       r.osm_id ?? null,
    name:        r.name,
    placeType:   r.place_type ?? "other",
    city:        r.city ?? null,
    lat:         r.lat != null ? Number(r.lat) : null,
    lng:         r.lng != null ? Number(r.lng) : null,
    status:      r.status ?? "none",
    safetyNote:  r.safety_note ?? null,
  };
}
