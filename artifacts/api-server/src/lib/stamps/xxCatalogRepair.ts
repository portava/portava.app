/**
 * xxCatalogRepair — re-key / merge "XX" catalog entries once a real country
 * becomes derivable.
 *
 * Shared by:
 *   - src/scripts/backfillStampCountries.ts (one-off manual run)
 *   - the periodic in-process sweeper started from index.ts, which also uses
 *     geocoding so cities missing from the static lookup are resolved
 *     automatically.
 *
 * For each catalog entry with country_code "XX" whose country is now
 * resolvable (static lookup or geocoding):
 *   - If an entry with the real key already exists → merge: repoint ownership
 *     rows (user_stamps, passport_stamps) and artwork versions to the
 *     surviving entry, transfer earn_count, drop the XX entry's queue jobs,
 *     and delete the XX entry.
 *   - Otherwise → update the XX entry in place with the real key, country,
 *     and country_code.
 *
 * Definition-scoped entries ("definition:{slug}", intentionally XX/Global)
 * are always skipped. Unresolvable cities are left as XX — never guessed —
 * and reported in the returned stats / logs.
 *
 * Idempotent — safe to re-run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalLocationKeyFromStrings } from "./locationKey.js";
import { resolveCountry, type ResolvedCountry } from "./countryLookup.js";
import { geocodeCityCountry } from "./countryGeocoder.js";

export interface RepairStats {
  scanned: number;
  catalogRekeyed: number;
  catalogMerged: number;
  geocodeResolved: number;
  unresolvedCities: string[];
}

export interface OwnershipBackfillStats {
  userStampsBackfilled: number;
  passportStampsBackfilled: number;
  unresolvedCities: string[];
}

export type CountryResolver = (entry: {
  country: string | null;
  city: string | null;
}) => Promise<ResolvedCountry>;

/**
 * Default resolver: static lookup first, then forward geocoding of the city
 * (cached + rate-limited inside countryGeocoder). Never guesses.
 */
export function makeGeocodingResolver(opts?: { maxGeocodes?: number }): CountryResolver {
  let remaining = opts?.maxGeocodes ?? 25;
  return async ({ country, city }) => {
    const staticResult = resolveCountry({ country, city });
    if (staticResult.countryCode !== "XX") return staticResult;
    if (!city || remaining <= 0) return staticResult;
    remaining -= 1;
    const geo = await geocodeCityCountry(city);
    if (geo) return { country: country ?? geo.country, countryCode: geo.countryCode };
    return staticResult;
  };
}

/** Static-only resolver (no network) — used where geocoding is not wanted. */
export const staticResolver: CountryResolver = async ({ country, city }) =>
  resolveCountry({ country, city });

type WarnLog = (msg: string, ...args: unknown[]) => void;

/** Repoint every reference from the XX catalog entry to the surviving entry. */
export async function mergeCatalogEntry(
  sc: SupabaseClient,
  xxId: string,
  survivorId: string,
  warn: WarnLog = console.warn,
): Promise<boolean> {
  for (const table of ["user_stamps", "passport_stamps"] as const) {
    const { error } = await sc.from(table).update({ catalog_id: survivorId }).eq("catalog_id", xxId);
    if (error && !/does not exist/i.test(error.message)) {
      warn(`[xx-repair] repoint ${table} failed:`, error.message);
    }
  }

  // Move artwork versions across (keeps any generated art)
  const { error: artErr } = await sc
    .from("stamp_artwork_versions")
    .update({ catalog_id: survivorId })
    .eq("catalog_id", xxId);
  if (artErr) warn("[xx-repair] artwork repoint failed:", artErr.message);

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
    warn("[xx-repair] XX entry delete failed:", delErr.message);
    return false;
  }
  return true;
}

/**
 * Scan XX catalog entries and re-key / merge every one whose country is now
 * resolvable via `resolver`. Never throws; individual failures are logged.
 */
export async function repairXXCatalogEntries(
  sc: SupabaseClient,
  resolver: CountryResolver = makeGeocodingResolver(),
  log: { info: WarnLog; warn: WarnLog } = { info: console.log, warn: console.warn },
): Promise<RepairStats> {
  const stats: RepairStats = {
    scanned: 0,
    catalogRekeyed: 0,
    catalogMerged: 0,
    geocodeResolved: 0,
    unresolvedCities: [],
  };

  const { data: entries, error } = await sc
    .from("universal_stamp_catalog")
    .select("id, canonical_location_key, stamp_type, country, country_code, city, neighborhood, display_name")
    .eq("country_code", "XX");

  if (error) {
    log.warn("[xx-repair] catalog read failed:", error.message);
    return stats;
  }

  for (const entry of (entries ?? []) as any[]) {
    // Definition-scoped (badge) entries are intentionally XX/Global — skip.
    if (typeof entry.canonical_location_key === "string" &&
        entry.canonical_location_key.startsWith("definition:")) {
      continue;
    }
    stats.scanned += 1;

    const rawCountry = entry.country === "Unknown" || entry.country === "Global"
      ? null
      : entry.country;

    let resolved: ResolvedCountry;
    try {
      resolved = await resolver({ country: rawCountry, city: entry.city ?? null });
    } catch (e: any) {
      log.warn(`[xx-repair] resolver failed for "${entry.city}":`, e?.message ?? String(e));
      continue;
    }

    if (resolved.countryCode === "XX") {
      if (entry.city && !stats.unresolvedCities.includes(entry.city)) {
        stats.unresolvedCities.push(entry.city);
      }
      continue; // genuinely unknown — leave as XX, never guess
    }

    // Was this only resolvable via geocoding (i.e. static lookup says XX)?
    if (resolveCountry({ country: rawCountry, city: entry.city ?? null }).countryCode === "XX") {
      stats.geocodeResolved += 1;
    }

    const newKey = canonicalLocationKeyFromStrings({
      stampType:    entry.stamp_type,
      country:      resolved.country,
      countryCode:  resolved.countryCode,
      city:         entry.city,
      neighborhood: entry.neighborhood,
      displayName:  entry.display_name,
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
      log.info(`[xx-repair] Merging ${entry.canonical_location_key} → ${newKey}`);
      if (await mergeCatalogEntry(sc, entry.id, (survivor as any).id, log.warn)) {
        stats.catalogMerged += 1;
      }
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
        log.warn(`[xx-repair] re-key failed for ${entry.canonical_location_key}:`, updErr.message);
      } else {
        log.info(`[xx-repair] Re-keyed ${entry.canonical_location_key} → ${newKey} (${resolved.countryCode})`);
        stats.catalogRekeyed += 1;
      }
    }
  }

  return stats;
}

const OWNERSHIP_PAGE_SIZE = 1_000;

/**
 * Backfill country on ownership rows (user_stamps / passport_stamps) that
 * have a city but no country. Shared by the manual backfill script and the
 * periodic sweep.
 *
 * Scans ALL candidate rows via keyset pagination (ordered by id) so rows with
 * unresolvable cities can never starve later resolvable rows out of a run.
 * `maxBackfillsPerTable` bounds only the number of rows *updated* per table
 * per run — scanning unresolved rows is cheap because each distinct city is
 * resolved at most once per run (memoised), and network cost is capped by the
 * resolver's own geocode budget.
 *
 * Unresolvable cities are left untouched and reported in the returned stats.
 * Idempotent — safe to re-run.
 */
export async function backfillOwnershipCountries(
  sc: SupabaseClient,
  resolver: CountryResolver = makeGeocodingResolver(),
  opts: { maxBackfillsPerTable?: number; pageSize?: number } = {},
  log: { info: WarnLog; warn: WarnLog } = { info: console.log, warn: console.warn },
): Promise<OwnershipBackfillStats> {
  const stats: OwnershipBackfillStats = {
    userStampsBackfilled: 0,
    passportStampsBackfilled: 0,
    unresolvedCities: [],
  };

  const maxBackfills = opts.maxBackfillsPerTable && opts.maxBackfillsPerTable > 0
    ? opts.maxBackfillsPerTable
    : Infinity;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : OWNERSHIP_PAGE_SIZE;

  // city → country name (or null if unresolvable), memoised across both tables
  const cityCountry = new Map<string, string | null>();

  for (const table of ["user_stamps", "passport_stamps"] as const) {
    let backfilled = 0;
    let lastId: unknown = null;

    paging: while (backfilled < maxBackfills) {
      let query = sc
        .from(table)
        .select("id, city")
        .is("country", null)
        .not("city", "is", null)
        .order("id", { ascending: true })
        .limit(pageSize);
      if (lastId !== null) query = query.gt("id", lastId);
      const { data: rows, error } = await query;

      if (error) {
        // passport_stamps may not exist in some environments
        log.warn(`[xx-repair] ${table} read failed:`, error.message);
        break;
      }
      if (!rows || rows.length === 0) break;
      lastId = (rows[rows.length - 1] as any).id;

      // Group this page's rows by resolved country so we update in batches
      const byCountry = new Map<string, string[]>(); // country name → row ids
      let pending = 0;

      for (const row of rows as any[]) {
        if (backfilled + pending >= maxBackfills) break;
        const cityKey = String(row.city).toLowerCase().trim();
        let country = cityCountry.get(cityKey);
        if (country === undefined) {
          try {
            const resolved = await resolver({ country: null, city: row.city });
            country = resolved.countryCode === "XX" ? null : resolved.country;
          } catch (e: any) {
            log.warn(`[xx-repair] resolver failed for "${row.city}":`, e?.message ?? String(e));
            country = null;
          }
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
        pending += 1;
      }

      for (const [country, ids] of byCountry) {
        const { error: updErr } = await sc.from(table).update({ country }).in("id", ids);
        if (updErr) {
          log.warn(`[xx-repair] ${table} update failed for ${country}:`, updErr.message);
        } else {
          backfilled += ids.length;
          if (table === "user_stamps") {
            stats.userStampsBackfilled += ids.length;
          } else {
            stats.passportStampsBackfilled += ids.length;
          }
        }
      }

      if (rows.length < pageSize) break paging; // last page
    }
  }

  if (stats.unresolvedCities.length > 0) {
    log.info(
      `[xx-repair] ownership backfill left ${stats.unresolvedCities.length} unresolved cit(y/ies): ${stats.unresolvedCities.join(", ")}`,
    );
  }

  return stats;
}

// ── Periodic sweeper ──────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000; // every 6 hours
const SWEEP_INITIAL_DELAY_MS = 60 * 1_000;     // first pass 1 min after boot

let _sweepInterval: ReturnType<typeof setInterval> | null = null;
let _sweepTimeout: ReturnType<typeof setTimeout> | null = null;

async function runSweep(getClient: () => SupabaseClient | null): Promise<void> {
  const sc = getClient();
  if (!sc) return;
  // One geocode budget shared across the ownership backfill and catalog repair.
  const resolver = makeGeocodingResolver({ maxGeocodes: 25 });
  const ownership = await backfillOwnershipCountries(sc, resolver, { maxBackfillsPerTable: 500 });
  const stats = await repairXXCatalogEntries(sc, resolver);
  console.log(JSON.stringify({
    event: "stamp.xx_catalog_sweep.completed",
    scanned:          stats.scanned,
    rekeyed:          stats.catalogRekeyed,
    merged:           stats.catalogMerged,
    geocode_resolved: stats.geocodeResolved,
    user_stamps_backfilled:     ownership.userStampsBackfilled,
    passport_stamps_backfilled: ownership.passportStampsBackfilled,
    unresolved: [...new Set([...ownership.unresolvedCities, ...stats.unresolvedCities])],
  }));
}

/**
 * Start the periodic XX-catalog sweep: first pass shortly after startup,
 * then every 6 hours. Disable with STAMP_COUNTRY_SWEEP_ENABLED=false.
 */
export function startXXCatalogSweeper(
  getClient: () => SupabaseClient | null,
  intervalMs = SWEEP_INTERVAL_MS,
  initialDelayMs = SWEEP_INITIAL_DELAY_MS,
): void {
  if (_sweepInterval || _sweepTimeout) return; // already running
  if (process.env.STAMP_COUNTRY_SWEEP_ENABLED === "false") {
    console.log(JSON.stringify({ event: "stamp.xx_catalog_sweep.disabled" }));
    return;
  }

  console.log(JSON.stringify({
    event: "stamp.xx_catalog_sweep.started",
    interval_ms: intervalMs,
  }));

  const tick = () =>
    runSweep(getClient).catch((e) =>
      console.warn("[xx-repair] sweep failed:", e?.message ?? String(e)),
    );

  _sweepTimeout = setTimeout(tick, initialDelayMs);
  (_sweepTimeout as any).unref?.();
  _sweepInterval = setInterval(tick, intervalMs);
  (_sweepInterval as any).unref?.();
}

export function stopXXCatalogSweeper(): void {
  if (_sweepTimeout) { clearTimeout(_sweepTimeout); _sweepTimeout = null; }
  if (_sweepInterval) { clearInterval(_sweepInterval); _sweepInterval = null; }
}
