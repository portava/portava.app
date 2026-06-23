/**
 * CompassLocationContext
 *
 * Builds a safe-only location context for Compass AI.
 * NEVER includes exact coordinates, hotel location, or another user's private data.
 *
 * Returns: city + district + approximate area + nearby verified places + upcoming trip city.
 * Gated by the `compass_location_context_enabled` feature flag.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getVerifiedPlaces } from "./GeoZoneService";

export interface CompassSafeContext {
  currentCity: string | null;
  currentDistrict: string | null;
  currentCountry: string | null;
  approximateArea: string | null;      // "Cebu City, Cebu Province, PH"
  nearbyVerifiedPlaces: Array<{
    name: string;
    placeType: string;
    city: string | null;
  }>;
  upcomingTripCity: string | null;
  upcomingTripCountry: string | null;
  // coordinates intentionally absent
}

/**
 * Build a Compass-safe context for `userId`.
 * All sourced from city-level data only — no exact coords returned.
 */
export async function buildCompassContext(
  db: SupabaseClient,
  userId: string,
): Promise<CompassSafeContext> {
  const empty: CompassSafeContext = {
    currentCity: null,
    currentDistrict: null,
    currentCountry: null,
    approximateArea: null,
    nearbyVerifiedPlaces: [],
    upcomingTripCity: null,
    upcomingTripCountry: null,
  };

  try {
    // Load location state (city-level only)
    const { data: locState } = await db
      .from("user_location_state")
      .select("city, district, country, country_code, manual_city, manual_country")
      .eq("user_id", userId)
      .maybeSingle();

    const city = (locState as any)?.manual_city ?? (locState as any)?.city ?? null;
    const district = (locState as any)?.district ?? null;
    const country = (locState as any)?.manual_country ?? (locState as any)?.country ?? null;
    const countryCode = (locState as any)?.country_code ?? null;

    const approximateArea = [city, country].filter(Boolean).join(", ") || null;

    // Nearby verified places (name + type only — no coords)
    const verifiedPlaces = city
      ? (await getVerifiedPlaces(db, city, 5)).map((p) => ({
          name:      p.name,
          placeType: p.placeType,
          city:      p.city,
        }))
      : [];

    // Upcoming trip
    const { data: trip } = await db
      .from("trips")
      .select("destination_city, destination_country")
      .eq("owner_id", userId)
      .in("status", ["planning", "active"])
      .order("start_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      currentCity: city,
      currentDistrict: district,
      currentCountry: country,
      approximateArea,
      nearbyVerifiedPlaces: verifiedPlaces,
      upcomingTripCity: (trip as any)?.destination_city ?? null,
      upcomingTripCountry: (trip as any)?.destination_country ?? null,
    };
  } catch {
    return empty;
  }
}
