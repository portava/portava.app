/**
 * DiscoveryLocationContext
 *
 * Builds a safe Discovery query context from user location preferences
 * and the current location state. Feeds into GET /api/discovery context modes.
 *
 * Context modes:
 *   near_me       — ranked by distance from current location (city-level only)
 *   in_city        — ranked by destination city match
 *   going_soon     — ranked by upcoming trip destination
 *   around_crew    — peers who are in the same city (no exact coords)
 *   safe_nearby    — verified places + safety confidence weighted
 *
 * PRIVACY: exact coords are NEVER included in Discovery responses.
 * Only city/district text labels and distance buckets are returned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserLocationPreferences } from "./LocationPermissionService";
import { getVerifiedPlaces } from "./GeoZoneService";

export type DiscoveryContextMode =
  | "near_me"
  | "in_city"
  | "going_soon"
  | "around_crew"
  | "safe_nearby";

export interface DiscoveryContext {
  mode: DiscoveryContextMode;
  /** Best city to search in (from GPS, manual, or trip destination). */
  targetCity: string | null;
  targetCountry: string | null;
  /** Approximate radius for Overpass — computed from mode. */
  radiusKm: number;
  /** Ranking weights (0–1). */
  weights: {
    distance:       number;
    cityMatch:      number;
    tripMatch:      number;
    trustScore:     number;
    safetyScore:    number;
    vibeMatch:      number;
    trending:       number;
    verifiedPlaces: number;
  };
  /** Verified places to boost in results. */
  verifiedPlaceIds: string[];
  /** Human label for the UI. */
  label: string;
  /** Whether user can see "nearby" content. */
  nearbyEnabled: boolean;
}

const DEFAULT_WEIGHTS = {
  distance:       0,
  cityMatch:      1,
  tripMatch:      0,
  trustScore:     0.2,
  safetyScore:    0.1,
  vibeMatch:      0.5,
  trending:       0.3,
  verifiedPlaces: 0.2,
};

export async function buildDiscoveryContext(opts: {
  db: SupabaseClient;
  userId: string;
  prefs: UserLocationPreferences;
  mode: DiscoveryContextMode;
  currentCity: string | null;
  currentCountry: string | null;
  currentLat?: number | null;
  currentLng?: number | null;
}): Promise<DiscoveryContext> {
  const { db, prefs, mode, currentCity, currentCountry } = opts;
  const sharingOff = !currentCity || prefs.locationMode === "off" || prefs.sharingPaused;

  switch (mode) {
    case "near_me": {
      if (sharingOff || prefs.locationMode === "city_only") {
        // Degrade to in_city when location is city-only or off
        return buildCityContext(currentCity, currentCountry, "near_me", db);
      }
      const verified = currentCity
        ? (await getVerifiedPlaces(db, currentCity)).map((p) => p.id)
        : [];
      return {
        mode,
        targetCity: currentCity,
        targetCountry: currentCountry,
        radiusKm: prefs.locationMode === "nearby" ? 5 : 10,
        weights: { ...DEFAULT_WEIGHTS, distance: 0.8, cityMatch: 0.6, verifiedPlaces: 0.3 },
        verifiedPlaceIds: verified,
        label: "Near me",
        nearbyEnabled: true,
      };
    }

    case "in_city": {
      return buildCityContext(currentCity, currentCountry, mode, db);
    }

    case "going_soon": {
      // Use next trip destination if available — fall back to current city
      const tripCity = await getNextTripCity(db, opts.userId);
      const city = tripCity ?? currentCity;
      const verified = city ? (await getVerifiedPlaces(db, city)).map((p) => p.id) : [];
      return {
        mode,
        targetCity: city,
        targetCountry: currentCountry,
        radiusKm: 15,
        weights: { ...DEFAULT_WEIGHTS, tripMatch: 0.9, vibeMatch: 0.4, verifiedPlaces: 0.3 },
        verifiedPlaceIds: verified,
        label: city ? `Going to ${city}` : "Going soon",
        nearbyEnabled: false,
      };
    }

    case "around_crew": {
      return buildCityContext(currentCity, currentCountry, mode, db, {
        weights: { ...DEFAULT_WEIGHTS, cityMatch: 0.7, trustScore: 0.6, vibeMatch: 0.5 },
        label: "Around my crew",
      });
    }

    case "safe_nearby": {
      const verified = currentCity
        ? (await getVerifiedPlaces(db, currentCity)).map((p) => p.id)
        : [];
      return {
        mode,
        targetCity: currentCity,
        targetCountry: currentCountry,
        radiusKm: 3,
        weights: { ...DEFAULT_WEIGHTS, safetyScore: 0.9, trustScore: 0.7, verifiedPlaces: 0.8, distance: 0.5 },
        verifiedPlaceIds: verified,
        label: "Safe nearby",
        nearbyEnabled: !sharingOff,
      };
    }
  }
}

async function buildCityContext(
  city: string | null,
  country: string | null,
  mode: DiscoveryContextMode,
  db: SupabaseClient,
  overrides?: Partial<DiscoveryContext>,
): Promise<DiscoveryContext> {
  const verified = city ? (await getVerifiedPlaces(db, city)).map((p) => p.id) : [];
  return {
    mode,
    targetCity: city,
    targetCountry: country,
    radiusKm: 10,
    weights: { ...DEFAULT_WEIGHTS, cityMatch: 0.9, vibeMatch: 0.4 },
    verifiedPlaceIds: verified,
    label: city ? `In ${city}` : "In this city",
    nearbyEnabled: false,
    ...overrides,
  };
}

async function getNextTripCity(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("trips")
      .select("destination_city")
      .eq("owner_id", userId)
      .in("status", ["planning", "active"])
      .order("start_date", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data as any)?.destination_city ?? null;
  } catch {
    return null;
  }
}
