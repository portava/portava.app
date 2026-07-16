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
 *      country, using the well-known-city → country lookup.
 *   2. Re-keys every catalog entry whose country_code is "XX" where a real
 *      code is now derivable:
 *        - If an entry with the real key already exists → merge: repoint
 *          ownership rows (user_stamps, passport_stamps) and artwork versions
 *          to the surviving entry, transfer earn_count, drop the XX entry's
 *          queue jobs, and delete the XX entry.
 *        - Otherwise → update the XX entry in place with the real key,
 *          country, and country_code.
 *
 * Idempotent — safe to re-run. Cities that can't be resolved are left as-is
 * and reported (never guessed from spelling).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx src/scripts/backfillStampCountries.ts
 */

import { createClient } from "@supabase/supabase-js";
import { canonicalLocationKeyFromStrings } from "../lib/stamps/locationKey.js";
import { resolveCountry } from "../lib/stamps/countryLookup.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const sc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

interface Stats {
  userStampsBackfilled:     number;
  passportStampsBackfilled: number;
  catalogRekeyed:           number;
  catalogMerged:            number;
  unresolvedCities:         string[];
}

const stats: Stats = {
  userStampsBackfilled:     0,
  passportStampsBackfilled: 0,
  catalogRekeyed:           0,
  catalogMerged:            0,
  unresolvedCities:         [],
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
  for (const row of (rows ?? []) as any[]) {
    const resolved = resolveCountry({ city: row.city });
    if (resolved.countryCode === "XX" || !resolved.country) {
      if (row.city && !stats.unresolvedCities.includes(row.city)) {
        stats.unresolvedCities.push(row.city);
      }
      continue;
    }
    const ids = byCountry.get(resolved.country) ?? [];
    ids.push(row.id);
    byCountry.set(resolved.country, ids);
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

/** Repoint every reference from the XX catalog entry to the surviving entry. */
async function mergeCatalogEntry(xxId: string, survivorId: string) {
  for (const table of ["user_stamps", "passport_stamps"] as const) {
    const { error } = await sc.from(table).update({ catalog_id: survivorId }).eq("catalog_id", xxId);
    if (error && !/does not exist/i.test(error.message)) {
      console.warn(`[backfill] repoint ${table} failed:`, error.message);
    }
  }

  // Move artwork versions across (keeps any generated art)
  const { error: artErr } = await sc
    .from("stamp_artwork_versions")
    .update({ catalog_id: survivorId })
    .eq("catalog_id", xxId);
  if (artErr) console.warn("[backfill] artwork repoint failed:", artErr.message);

  // Transfer earn_count to the survivor
  const { data: pair } = await sc
    .from("universal_stamp_catalog")
    .select("id, earn_count")
    .in("id", [xxId, survivorId]);
  const xxCount       = (pair ?? []).find((r: any) => r.id === xxId)?.earn_count ?? 0;
  const survivorCount = (pair ?? []).find((r: any) => r.id === survivorId)?.earn_count ?? 0;
  if (xxCount > 0) {
    await sc
      .from("universal_stamp_catalog")
      .update({ earn_count: survivorCount + xxCount })
      .eq("id", survivorId);
  }

  // Drop the XX entry's queue jobs, then the entry itself (audit/reconcile
  // logs reference it with ON DELETE SET NULL — safe).
  await sc.from("stamp_generation_queue").delete().eq("catalog_id", xxId);
  const { error: delErr } = await sc.from("universal_stamp_catalog").delete().eq("id", xxId);
  if (delErr) {
    console.warn("[backfill] XX entry delete failed:", delErr.message);
    return false;
  }
  return true;
}

/** Step 2: re-key or merge XX catalog entries. */
async function fixCatalogEntries() {
  const { data: entries, error } = await sc
    .from("universal_stamp_catalog")
    .select("id, canonical_location_key, stamp_type, country, country_code, city, neighborhood, display_name")
    .eq("country_code", "XX");

  if (error) {
    console.error("[backfill] catalog read failed:", error.message);
    return;
  }

  for (const entry of (entries ?? []) as any[]) {
    const rawCountry = entry.country === "Unknown" ? null : entry.country;
    const resolved = resolveCountry({ country: rawCountry, city: entry.city });
    if (resolved.countryCode === "XX") {
      if (entry.city && !stats.unresolvedCities.includes(entry.city)) {
        stats.unresolvedCities.push(entry.city);
      }
      continue; // genuinely unknown — leave as XX
    }

    const newKey = canonicalLocationKeyFromStrings({
      stampType:   entry.stamp_type,
      country:     resolved.country,
      city:        entry.city,
      neighborhood: entry.neighborhood,
      displayName: entry.display_name,
    });

    if (newKey === entry.canonical_location_key) continue;

    // Does a real-code entry already exist under the new key?
    const { data: survivor } = await sc
      .from("universal_stamp_catalog")
      .select("id")
      .eq("canonical_location_key", newKey)
      .eq("stamp_type", entry.stamp_type)
      .neq("id", entry.id)
      .maybeSingle();

    if (survivor) {
      console.log(`[backfill] Merging ${entry.canonical_location_key} → ${newKey}`);
      if (await mergeCatalogEntry(entry.id, (survivor as any).id)) stats.catalogMerged++;
    } else {
      const { error: updErr } = await sc
        .from("universal_stamp_catalog")
        .update({
          canonical_location_key: newKey,
          country:                resolved.country ?? entry.country,
          country_code:           resolved.countryCode,
          updated_at:             new Date().toISOString(),
        })
        .eq("id", entry.id);
      if (updErr) {
        console.warn(`[backfill] re-key failed for ${entry.canonical_location_key}:`, updErr.message);
      } else {
        console.log(`[backfill] Re-keyed ${entry.canonical_location_key} → ${newKey} (${resolved.countryCode})`);
        stats.catalogRekeyed++;
      }
    }
  }
}

async function main() {
  console.log("[backfill] Starting country backfill + XX catalog merge…");
  await backfillOwnershipTable("user_stamps");
  await backfillOwnershipTable("passport_stamps");
  await fixCatalogEntries();

  console.log("[backfill] Complete:");
  console.log(`  user_stamps backfilled:     ${stats.userStampsBackfilled}`);
  console.log(`  passport_stamps backfilled: ${stats.passportStampsBackfilled}`);
  console.log(`  catalog entries re-keyed:   ${stats.catalogRekeyed}`);
  console.log(`  catalog entries merged:     ${stats.catalogMerged}`);
  if (stats.unresolvedCities.length > 0) {
    console.log(`  unresolved cities (left as-is): ${stats.unresolvedCities.join(", ")}`);
  }
}

main().catch((e) => {
  console.error("[backfill] Fatal error:", e);
  process.exit(1);
});
