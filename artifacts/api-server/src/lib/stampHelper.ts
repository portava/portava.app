/**
 * Stamp upsert helpers.
 *
 * Pure logic (buildCityStampLabels) is side-effect-free and unit-testable.
 * upsertCityStamp is best-effort: it logs errors but never throws, so a stamp
 * failure cannot corrupt the parent post or postcard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

export interface CityStampInput {
  userId: string;
  locationCity: string;
  locationCountry: string | null;
  postcardId: string | null;
}

/**
 * Build the display labels for a city stamp.
 * label   → "CEBU"
 * sublabel → "PH · 2026"  (2-char ISO country code + year)
 */
export function buildCityStampLabels(
  city: string,
  country: string | null,
): { label: string; sublabel: string } {
  const label = city.trim().toUpperCase();
  const year = new Date().getFullYear();
  const countryCode = country?.trim().slice(0, 2).toUpperCase() ?? null;
  const sublabel = countryCode ? `${countryCode} · ${year}` : String(year);
  return { label, sublabel };
}

/**
 * Upsert a GPS-verified city stamp via the upsert_city_stamp Postgres RPC.
 *
 * If the user has already earned this city's stamp, check_in_count is
 * incremented atomically (handled by the SQL function). No duplicate rows.
 *
 * Always best-effort: errors are logged but not rethrown.
 */
export async function upsertCityStamp(
  sc: SupabaseClient,
  input: CityStampInput,
  log: Pick<Logger, "error">,
): Promise<void> {
  const { label, sublabel } = buildCityStampLabels(
    input.locationCity,
    input.locationCountry,
  );

  const { error } = await sc.rpc("upsert_city_stamp", {
    p_user_id: input.userId,
    p_location_city: input.locationCity.toLowerCase().trim(),
    p_location_country: input.locationCountry ?? null,
    p_label: label,
    p_sublabel: sublabel,
    p_postcard_id: input.postcardId ?? null,
  });

  if (error) {
    log.error(
      { err: error, userId: input.userId, city: input.locationCity },
      "upsert_city_stamp RPC failed — stamp not written (post/postcard unaffected)",
    );
  }
}
