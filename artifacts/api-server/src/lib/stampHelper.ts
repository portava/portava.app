/**
 * Stamp upsert helpers.
 *
 * Pure logic (buildCityStampLabels) is side-effect-free and unit-testable.
 * upsertCityStamp is best-effort: it logs errors but never throws, so a stamp
 * failure cannot corrupt the parent post or postcard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { resolveCountry, countryFromCity } from "./stamps/countryLookup.js";
import { toCountryCode } from "./countryCodes.js";

export interface CityStampInput {
  userId: string;
  locationCity: string;
  locationCountry: string | null;
  postcardId: string | null;
}

/**
 * Resolve a *real* ISO-3166-1 alpha-2 code for a city stamp, or null.
 *
 * STAMP·H3: this used to be `country.slice(0, 2).toUpperCase()`, which
 * fabricated codes from the spelling of the name — "Vietnam" → "VI"
 * (actually the U.S. Virgin Islands), "Japan" → "JA", "United States" → "UN",
 * "Germany" → "GE". Truncation is never a valid derivation, not even from
 * alpha-3 ("Denmark"/DNK → "DN", "Portugal"/PRT → "PR").
 *
 * Resolution order, all map-backed and none of them guessing:
 *   1. `toCountryCode` — full ISO-3166-1 name/alias/code table (lib/countryCodes)
 *   2. `countryFromCity` — well-known city → country (lib/stamps/countryLookup)
 *   3. null — an honest unknown
 *
 * Unknown is deliberately `null`, not "XX": the sublabel is rendered verbatim
 * to the user, and a wrong-but-plausible code is worse than no code at all.
 * A null code degrades the sublabel to year-only, which is the same fallback
 * the function has always used for a missing country.
 */
function cityStampCountryCode(
  city: string,
  country: string | null,
): string | null {
  return toCountryCode(country) ?? countryFromCity(city)?.countryCode ?? null;
}

/**
 * Build the display labels for a city stamp.
 * label    → "CEBU"
 * sublabel → "PH · 2026"  (real ISO-3166-1 alpha-2 code + year), or just
 *            "2026" when no real code can be resolved.
 */
export function buildCityStampLabels(
  city: string,
  country: string | null,
): { label: string; sublabel: string } {
  const rawLabel = city.trim().toUpperCase();
  const label = rawLabel.length > 0 ? rawLabel : "UNKNOWN";
  const year = new Date().getFullYear();
  const countryCode = cityStampCountryCode(city, country);
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
  // If the caller did not supply a country, try to derive it from the city
  // name using the same static lookup that StampAwardEngine uses.  This
  // prevents passport_stamps rows from being inserted with country=null when
  // the client omits the field, which would cause buildStats to never count
  // those rows toward the Countries total.
  const resolvedCountry = resolveCountry({
    country: input.locationCountry,
    city: input.locationCity,
  });
  const effectiveCountry: string | null =
    input.locationCountry ?? resolvedCountry.country ?? null;

  const { label, sublabel } = buildCityStampLabels(
    input.locationCity,
    effectiveCountry,
  );

  const { error } = await sc.rpc("upsert_city_stamp", {
    p_user_id: input.userId,
    p_location_city: input.locationCity.toLowerCase().trim(),
    p_location_country: effectiveCountry,
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
