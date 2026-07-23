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
  /** Hidden gems for Compass — only public/approximate/community-verified; protected excluded */
  hiddenGems: Array<{
    name: string;
    category: string;
    city: string;
    neighborhood: string | null;
    verificationLevel: string;
    priceRange: string | null;
    vibeTags: string[];
  }>;
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
    hiddenGems: [],
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

    // Hidden gems for Compass — STRICT inclusion:
    //   • sensitivity_level = 'public' ONLY (never reveal-after-save / protected / etc.)
    //   • verification_level in community/guide/gps_verified/admin
    //   • gated by hidden_gems_compass_enabled feature flag
    //   • neighborhood included only for public gems; never coordinates
    let hiddenGems: CompassSafeContext["hiddenGems"] = [];
    try {
      const { data: compassFlag } = await db
        .from("feature_flags")
        .select("enabled")
        .eq("flag", "hidden_gems_compass_enabled")
        .maybeSingle();

      if ((compassFlag as any)?.enabled && city) {
        const { data: gemRows } = await db
          .from("hidden_gems")
          .select("name, category, city, neighborhood, verification_level, price_range, vibe_tags")
          .eq("status", "active")
          .eq("sensitivity_level", "public")          // strict: public only
          .ilike("city", city)
          .in("verification_level", ["community", "guide", "gps_verified", "admin"])
          .limit(5);
        hiddenGems = (gemRows ?? []).map((g: any) => ({
          name:              g.name,
          category:          g.category,
          city:              g.city,
          neighborhood:      g.neighborhood ?? null,  // neighbourhood is safe for public gems
          verificationLevel: g.verification_level,
          priceRange:        g.price_range ?? null,
          vibeTags:          g.vibe_tags ?? [],
        }));
      }
    } catch { /* non-fatal */ }

    return {
      currentCity: city,
      currentDistrict: district,
      currentCountry: country,
      approximateArea,
      nearbyVerifiedPlaces: verifiedPlaces,
      upcomingTripCity: (trip as any)?.destination_city ?? null,
      upcomingTripCountry: (trip as any)?.destination_country ?? null,
      hiddenGems,
    };
  } catch {
    return { ...empty, hiddenGems: [] };
  }
}
