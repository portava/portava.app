/**
 * Backfill real country data on stamps and merge XX-keyed catalog entries.
 *
 * Production stamps were created with only a city (country null), so the
 * reconciliation script produced catalog entries with country_code "XX" and
 * canonical keys like "trip:xx:london". Once country data exists, the same
 * city resolves to a different key (e.g. "trip:gb:london") — creating
 * duplicates. This script:
 *
 *   1. Backfills user_stamps / passport_stamps rows that have a city but no
 *      country, using the well-known-city lookup plus geocoding for cities
 *      missing from the static table (cached, rate-limited).
 *   2. Re-keys / merges every catalog entry whose country_code is "XX" where
 *      a real code is now derivable — shared logic in lib/stamps/xxCatalogRepair.
 *
 * Idempotent — safe to re-run. Cities that can't be resolved are left as-is
 * and reported (never guessed from spelling).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx src/scripts/backfillStampCountries.ts
 */

import { createClient } from "@supabase/supabase-js";
import { repairXXCatalogEntries, makeGeocodingResolver, type CountryResolver } from "../lib/stamps/xxCatalogRepair.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const sc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Manual runs may cover many cities — allow a bigger geocode budget than the
// periodic sweep (still rate-limited to ~1 req/sec inside the geocoder).
const resolver: CountryResolver = makeGeocodingResolver({ maxGeocodes: 200 });

const stats = {
  userStampsBackfilled:     0,
  passportStampsBackfilled: 0,
  unresolvedCities:         [] as string[],
};

/** Step 1: backfill country on ownership rows that have a city but no country. */
async function backfillOwnershipTable(table: "user_stamps" | "passport_stamps") {
  const { data: rows, error } = await sc
    .from(table)
    .select("id, city")
    .is("country", null)
    .not("city", "is", null);

  if (error) {
    // passport_stamps may not exist in some environments
    console.warn(`[backfill] ${table} read failed:`, error.message);
    return;
  }

  // Group rows by resolved country so we update in batches
  const byCountry = new Map<string, string[]>(); // country name → row ids
  const cityCountry = new Map<string, string | null>(); // city → country (memoised per run)

  for (const row of (rows ?? []) as any[]) {
    const cityKey = String(row.city).toLowerCase().trim();
    let country = cityCountry.get(cityKey);
    if (country === undefined) {
      const resolved = await resolver({ country: null, city: row.city });
      country = resolved.countryCode === "XX" ? null : resolved.country;
      cityCountry.set(cityKey, country);
    }
    if (!country) {
      if (row.city && !stats.unresolvedCities.includes(row.city)) {
        stats.unresolvedCities.push(row.city);
      }
      continue;
    }
    const ids = byCountry.get(country) ?? [];
    ids.push(row.id);
    byCountry.set(country, ids);
  }

  for (const [country, ids] of byCountry) {
    const { error: updErr } = await sc
      .from(table)
      .update({ country })
      .in("id", ids);
    if (updErr) {
      console.warn(`[backfill] ${table} update failed for ${country}:`, updErr.message);
    } else if (table === "user_stamps") {
      stats.userStampsBackfilled += ids.length;
    } else {
      stats.passportStampsBackfilled += ids.length;
    }
  }
}

async function main() {
  console.log("[backfill] Starting country backfill + XX catalog merge…");
  await backfillOwnershipTable("user_stamps");
  await backfillOwnershipTable("passport_stamps");
  const repair = await repairXXCatalogEntries(sc, resolver);

  console.log("[backfill] Complete:");
  console.log(`  user_stamps backfilled:     ${stats.userStampsBackfilled}`);
  console.log(`  passport_stamps backfilled: ${stats.passportStampsBackfilled}`);
  console.log(`  catalog entries re-keyed:   ${repair.catalogRekeyed}`);
  console.log(`  catalog entries merged:     ${repair.catalogMerged}`);
  console.log(`  resolved via geocoding:     ${repair.geocodeResolved}`);
  const unresolved = [...new Set([...stats.unresolvedCities, ...repair.unresolvedCities])];
  if (unresolved.length > 0) {
    console.log(`  unresolved cities (left as-is): ${unresolved.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("[backfill] Fatal error:", e);
  process.exit(1);
});
