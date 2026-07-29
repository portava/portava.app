/**
 * Stamp upsert helpers.
 *
 * Pure logic (buildCityStampLabels) is side-effect-free and unit-testable.
 * upsertCityStamp is best-effort: it logs errors but never throws, so a stamp
 * failure cannot corrupt the parent post or postcard.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { resolveCountry } from "./stamps/countryLookup.js";

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
  const rawLabel = city.trim().toUpperCase();
  const label = rawLabel.length > 0 ? rawLabel : "UNKNOWN";
  const year = new Date().getFullYear();
  const trimmed = country?.trim() ?? null;
  // Sentinel values that indicate an unresolved or missing country.  Slicing
  // any of these would produce a meaningless ISO-looking code (e.g. "N/" from
  // "N/A", "NO" from "None"), so treat them all the same as null.
  const SENTINELS = new Set(["unknown", "n/a", "none", "null", "undefined", ""]);
  const isSentinel =
    trimmed === null || SENTINELS.has(trimmed.toLowerCase());
  // Require at least 2 letters so punctuation-only ("---", "???") and
  // digit-only ("00", "123") strings fall back to year-only instead of
  // producing a meaningless code.
  const isAlpha = !isSentinel && /^[A-Za-z]{2,}/.test(trimmed!);
  const countryCode = isAlpha ? trimmed!.slice(0, 2).toUpperCase() : null;
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
