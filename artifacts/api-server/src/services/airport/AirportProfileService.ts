/**
 * AirportProfileService
 *
 * Resolves airport records by IATA code, GPS proximity, or city name.
 * Falls back to hardcoded defaults when the record is missing from the DB.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AirportProfile {
  id: string | null;
  iataCode: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  timezone: string;
  lat: number;
  lng: number;
  domesticBufferMin: number;
  domesticBufferMax: number;
  internationalBufferMin: number;
  internationalBufferMax: number;
  immigrationExtraMin: number;
  checkedBagsExtraMin: number;
  trafficExtraMin: number;
  verified: boolean;
}

const FALLBACK_PROFILE: Omit<AirportProfile, "id" | "iataCode" | "name" | "city" | "country" | "countryCode" | "lat" | "lng"> = {
  timezone: "UTC",
  domesticBufferMin: 60,
  domesticBufferMax: 90,
  internationalBufferMin: 120,
  internationalBufferMax: 180,
  immigrationExtraMin: 30,
  checkedBagsExtraMin: 15,
  trafficExtraMin: 20,
  verified: false,
};

function rowToProfile(row: any): AirportProfile {
  return {
    id:                     row.id,
    iataCode:               row.iata_code,
    name:                   row.name,
    city:                   row.city,
    country:                row.country,
    countryCode:            row.country_code,
    timezone:               row.timezone ?? "UTC",
    lat:                    Number(row.lat),
    lng:                    Number(row.lng),
    domesticBufferMin:      row.domestic_buffer_min     ?? 60,
    domesticBufferMax:      row.domestic_buffer_max     ?? 90,
    internationalBufferMin: row.international_buffer_min ?? 120,
    internationalBufferMax: row.international_buffer_max ?? 180,
    immigrationExtraMin:    row.immigration_extra_min    ?? 30,
    checkedBagsExtraMin:    row.checked_bags_extra_min   ?? 15,
    trafficExtraMin:        row.traffic_extra_min         ?? 20,
    verified:               Boolean(row.verified),
  };
}

/** Resolve by IATA code (e.g. "TPE", "NRT"). Case-insensitive. */
export async function resolveByIata(
  db: SupabaseClient,
  iataCode: string,
): Promise<AirportProfile | null> {
  try {
    const { data } = await db
      .from("airport_profiles")
      .select("*")
      .ilike("iata_code", iataCode.trim())
      .maybeSingle();
    return data ? rowToProfile(data) : null;
  } catch {
    return null;
  }
}

/** Resolve by nearest GPS coordinate within maxDistanceKm. */
export async function resolveByGps(
  db: SupabaseClient,
  lat: number,
  lng: number,
  maxDistanceKm = 50,
): Promise<AirportProfile | null> {
  try {
    const delta = maxDistanceKm / 111; // rough degree equivalent
    const { data } = await db
      .from("airport_profiles")
      .select("*")
      .gte("lat", lat - delta)
      .lte("lat", lat + delta)
      .gte("lng", lng - delta)
      .lte("lng", lng + delta)
      .limit(20);

    if (!data || data.length === 0) return null;

    // Find closest
    let closest: any = null;
    let closestDist = Infinity;
    for (const row of data) {
      const dLat = Number(row.lat) - lat;
      const dLng = Number(row.lng) - lng;
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist < closestDist) {
        closestDist = dist;
        closest = row;
      }
    }
    return closest ? rowToProfile(closest) : null;
  } catch {
    return null;
  }
}

/** Resolve by city name search. Returns the first match. */
export async function resolveByCity(
  db: SupabaseClient,
  city: string,
): Promise<AirportProfile | null> {
  try {
    const { data } = await db
      .from("airport_profiles")
      .select("*")
      .ilike("city", `%${city.trim()}%`)
      .limit(1)
      .maybeSingle();
    return data ? rowToProfile(data) : null;
  } catch {
    return null;
  }
}

/** Search airports by query (IATA, city, name). Returns up to 10 results. */
export async function searchAirports(
  db: SupabaseClient,
  query: string,
): Promise<AirportProfile[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const { data } = await db
      .from("airport_profiles")
      .select("*")
      .or(`iata_code.ilike.${q}%,city.ilike.%${q}%,name.ilike.%${q}%`)
      .order("verified", { ascending: false })
      .limit(10);
    return (data ?? []).map(rowToProfile);
  } catch {
    return [];
  }
}

/** Build a minimal fallback profile when the airport is not in the DB. */
export function buildFallbackProfile(opts: {
  iataCode: string;
  name?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
}): AirportProfile {
  return {
    id: null,
    iataCode:    opts.iataCode.toUpperCase(),
    name:        opts.name        ?? `${opts.iataCode.toUpperCase()} Airport`,
    city:        opts.city        ?? "Unknown",
    country:     opts.country     ?? "Unknown",
    countryCode: opts.countryCode ?? "XX",
    lat:         opts.lat         ?? 0,
    lng:         opts.lng         ?? 0,
    ...FALLBACK_PROFILE,
  };
}

/** Admin: upsert airport profile. */
export async function upsertAirportProfile(
  db: SupabaseClient,
  adminId: string,
  data: Partial<AirportProfile> & { iataCode: string; name: string; city: string; country: string; countryCode: string; lat: number; lng: number },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const record = {
      iata_code:               data.iataCode.toUpperCase(),
      name:                    data.name,
      city:                    data.city,
      country:                 data.country,
      country_code:            data.countryCode,
      timezone:                data.timezone                  ?? "UTC",
      lat:                     data.lat,
      lng:                     data.lng,
      domestic_buffer_min:     data.domesticBufferMin         ?? 60,
      domestic_buffer_max:     data.domesticBufferMax         ?? 90,
      international_buffer_min: data.internationalBufferMin   ?? 120,
      international_buffer_max: data.internationalBufferMax   ?? 180,
      immigration_extra_min:   data.immigrationExtraMin       ?? 30,
      checked_bags_extra_min:  data.checkedBagsExtraMin       ?? 15,
      traffic_extra_min:       data.trafficExtraMin           ?? 20,
      verified:                data.verified                  ?? false,
      created_by:              adminId,
      updated_at:              new Date().toISOString(),
    };
    const { data: row, error } = await db
      .from("airport_profiles")
      .upsert(record, { onConflict: "iata_code" })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: (row as any)?.id };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "unknown error" };
  }
}
