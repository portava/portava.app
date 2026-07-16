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
 *      country — shared logic in lib/stamps/xxCatalogRepair (also run by the
 *      periodic in-process sweep, bounded). Manual runs are unbounded with a
 *      bigger geocode budget for large one-off backfills.
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
import {
  repairXXCatalogEntries,
  backfillOwnershipCountries,
  makeGeocodingResolver,
  type CountryResolver,
} from "../lib/stamps/xxCatalogRepair.js";

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

async function main() {
  console.log("[backfill] Starting country backfill + XX catalog merge…");
  const ownership = await backfillOwnershipCountries(sc, resolver); // unbounded
  const repair = await repairXXCatalogEntries(sc, resolver);

  console.log("[backfill] Complete:");
  console.log(`  user_stamps backfilled:     ${ownership.userStampsBackfilled}`);
  console.log(`  passport_stamps backfilled: ${ownership.passportStampsBackfilled}`);
  console.log(`  catalog entries re-keyed:   ${repair.catalogRekeyed}`);
  console.log(`  catalog entries merged:     ${repair.catalogMerged}`);
  console.log(`  resolved via geocoding:     ${repair.geocodeResolved}`);
  const unresolved = [...new Set([...ownership.unresolvedCities, ...repair.unresolvedCities])];
  if (unresolved.length > 0) {
    console.log(`  unresolved cities (left as-is): ${unresolved.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("[backfill] Fatal error:", e);
  process.exit(1);
});
