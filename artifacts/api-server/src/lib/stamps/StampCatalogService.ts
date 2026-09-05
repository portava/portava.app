/**
 * StampCatalogService
 *
 * Single source of truth for catalog-level stamp operations:
 *   - resolveOrEnqueue: look up or create a catalog entry, enqueue generation
 *   - getActiveCatalogEntry: single-row read with active artwork URL
 *   - batchGetActive: bulk lookup for Passport page load
 *
 * An in-memory LRU cache (max 500 entries, 10-min TTL) prevents repeated DB
 * reads for approved catalog entries on high-volume post publishing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalLocationKey, definitionScopedKey, type LocationKeyInput } from "./locationKey.js";
import { STYLE_VERSION } from "./artDirection.js";
import { toCountryCode } from "../countryCodes.js";

/**
 * Normalise a caller-supplied catalog country code to a real ISO-3166-1
 * alpha-2 code, or the "XX" sentinel the xx-repair pipeline already knows how
 * to fix up.
 *
 * STAMP·H3 hardening: this used to be `country_code.toUpperCase().slice(0, 2)`.
 * For the two in-tree callers that is a no-op (both pass a resolved code), but
 * it is a silent fabrication trap: any caller that ever passed a country NAME
 * would get its first two letters written to the catalog as if they were an
 * ISO code — "Vietnam" → "VI", "Japan" → "JA" — poisoning canonical_location_key
 * and steering the wrong artwork. Truncation is never a valid derivation, so a
 * country name is now resolved through the real ISO table and anything still
 * unrecognised becomes "XX" instead of a plausible-looking lie.
 */
export function normalizeCatalogCountryCode(raw: string | null | undefined): string {
  return toCountryCode(raw) ?? "XX";
}

// ── LRU cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: CatalogEntry;
  expiresAt: number;
}

class LruCache<K, V extends object> {
  private readonly map = new Map<K, { value: V; expiresAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs   = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (LRU refresh)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.size >= this.maxSize) {
      // Evict the oldest entry
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

const catalogCache = new LruCache<string, CatalogEntry>(500, 10 * 60 * 1_000);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  canonical_location_key: string;
  stamp_type: string;
  display_name: string;
  country: string;
  country_code: string | null;
  region: string | null;
  city: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  status: "pending_artwork" | "approved" | "rejected" | "archived";
  active_version_id: string | null;
  active_artwork_url: string | null;
  earn_count: number;
  prompt_template_version: string;
  created_at: string;
  updated_at: string;
}

export interface ResolveResult {
  catalogEntry: CatalogEntry;
  wasEnqueued: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cacheKey(canonicalKey: string, stampType: string): string {
  return `${canonicalKey}::${stampType}`;
}

async function fetchEntryById(
  sc: SupabaseClient,
  id: string,
): Promise<CatalogEntry | null> {
  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "region, city, neighborhood, lat, lng, status, active_version_id, " +
      "earn_count, prompt_template_version, created_at, updated_at, " +
      "stamp_artwork_versions!fk_catalog_active_version(public_url)"
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  return shapeRow(data as any);
}

async function fetchEntryByKey(
  sc: SupabaseClient,
  canonicalKey: string,
  stampType: string,
): Promise<CatalogEntry | null> {
  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "region, city, neighborhood, lat, lng, status, active_version_id, " +
      "earn_count, prompt_template_version, created_at, updated_at, " +
      "stamp_artwork_versions!fk_catalog_active_version(public_url)"
    )
    .eq("canonical_location_key", canonicalKey)
    .eq("stamp_type", stampType)
    .maybeSingle();

  if (error || !data) return null;
  return shapeRow(data as any);
}

function shapeRow(row: any): CatalogEntry {
  const activeVersion = Array.isArray(row.stamp_artwork_versions)
    ? row.stamp_artwork_versions[0]
    : row.stamp_artwork_versions;
  return {
    id:                      row.id,
    canonical_location_key:  row.canonical_location_key,
    stamp_type:              row.stamp_type,
    display_name:            row.display_name,
    country:                 row.country,
    country_code:            row.country_code ?? null,
    region:                  row.region ?? null,
    city:                    row.city ?? null,
    neighborhood:            row.neighborhood ?? null,
    lat:                     row.lat ?? null,
    lng:                     row.lng ?? null,
    status:                  row.status,
    active_version_id:       row.active_version_id ?? null,
    active_artwork_url:      activeVersion?.public_url ?? null,
    earn_count:              row.earn_count ?? 0,
    prompt_template_version: row.prompt_template_version ?? "v1.0",
    created_at:              row.created_at,
    updated_at:              row.updated_at,
  };
}

// ── Core service ──────────────────────────────────────────────────────────────

/**
 * Resolve a catalog entry for the given location, creating one if it doesn't
 * exist, and enqueue a generation job if no job exists.
 *
 * This is the main entry point called by the award pipeline. It never throws —
 * callers catch all errors and fall through so the primary action is never blocked.
 */
export async function resolveOrEnqueue(
  sc: SupabaseClient,
  location: LocationKeyInput & {
    displayName: string;
    country: string;
    country_code: string;
    region?: string | null;
    city?: string | null;
    neighborhood?: string | null;
    lat?: number | null;
    lng?: number | null;
  },
  stampType: string,
  triggerAction?: string,
): Promise<ResolveResult> {
  const canonKey = canonicalLocationKey({ ...location, stampType });

  return resolveEntryCore(sc, canonKey, stampType, {
    canonical_location_key: canonKey,
    stamp_type:             stampType,
    display_name:           location.displayName,
    country:                location.country,
    country_code:           normalizeCatalogCountryCode(location.country_code),
    region:                 location.region ?? null,
    city:                   location.city ?? null,
    neighborhood:           location.neighborhood ?? null,
    lat:                    location.lat ?? null,
    lng:                    location.lng ?? null,
    status:                 "pending_artwork",
  }, triggerAction);
}

/**
 * Resolve a catalog entry for a location-less stamp definition (badges,
 * social/safety/trip achievements), creating a definition-scoped entry
 * ("definition:{slug}") if it doesn't exist, and enqueue a generation job.
 *
 * Mirrors the reconciliation script's behaviour so award-time resolution and
 * batch reconciliation always produce identical catalog entries.
 */
export async function resolveOrEnqueueForDefinition(
  sc: SupabaseClient,
  definition: { slug: string; name?: string | null; stamp_type?: string | null },
  triggerAction?: string,
): Promise<ResolveResult> {
  const canonKey  = definitionScopedKey(definition.slug);
  const stampType = definition.stamp_type ?? "social";

  return resolveEntryCore(sc, canonKey, stampType, {
    canonical_location_key:  canonKey,
    stamp_type:              stampType,
    display_name:            definition.name ?? definition.slug,
    country:                 "Global",
    country_code:            "XX",
    city:                    null,
    status:                  "pending_artwork",
    prompt_template_version: STYLE_VERSION,
  }, triggerAction);
}

async function resolveEntryCore(
  sc: SupabaseClient,
  canonKey: string,
  stampType: string,
  insertPayload: Record<string, unknown>,
  triggerAction?: string,
): Promise<ResolveResult> {
  // 1. Check cache first
  const cached = catalogCache.get(cacheKey(canonKey, stampType));
  if (cached) {
    console.log(JSON.stringify({ event: "stamp.catalog.hit", canonical_key: canonKey, stamp_type: stampType }));
    return { catalogEntry: cached, wasEnqueued: false };
  }

  // 2. Look up existing catalog entry
  let entry = await fetchEntryByKey(sc, canonKey, stampType);

  if (!entry) {
    console.log(JSON.stringify({ event: "stamp.catalog.miss", canonical_key: canonKey, stamp_type: stampType }));

    // 3. Create catalog entry
    const { data: newRow, error: insertErr } = await sc
      .from("universal_stamp_catalog")
      .insert(insertPayload)
      .select("id")
      .single();

    if (insertErr) {
      // Unique constraint race: another concurrent request just created it
      if ((insertErr as any).code === "23505") {
        entry = await fetchEntryByKey(sc, canonKey, stampType);
        if (!entry) throw new Error(`catalog_insert_race_unresolved: ${canonKey}`);
      } else {
        throw new Error(`catalog_insert_failed: ${insertErr.message}`);
      }
    } else {
      entry = await fetchEntryById(sc, (newRow as any).id);
      if (!entry) throw new Error("catalog_row_missing_after_insert");
    }
  } else {
    console.log(JSON.stringify({ event: "stamp.catalog.hit", canonical_key: canonKey, stamp_type: stampType }));
  }

  // Cache approved entries
  if (entry.status === "approved") {
    catalogCache.set(cacheKey(canonKey, stampType), entry);
  }

  // 4. Enqueue generation job if entry has no approved artwork and no active job
  let wasEnqueued = false;
  if (entry.status === "pending_artwork" || entry.status === "rejected") {
    // Unique constraint prevents double-insert of active jobs
    const { error: queueErr } = await sc
      .from("stamp_generation_queue")
      .insert({
        catalog_id:          entry.id,
        status:              "queued",
        priority:            5,
        triggered_by_action: triggerAction ?? null,
      });

    if (!queueErr) {
      wasEnqueued = true;
      console.log(JSON.stringify({ event: "stamp.queue.enqueued", catalog_id: entry.id, canonical_key: canonKey }));
    }
    // If unique constraint fires (queueErr.code === '23505'), a job already exists — ok
  }

  return { catalogEntry: entry, wasEnqueued };
}

/**
 * Get a single approved catalog entry by canonical key + stamp type.
 * Checks cache first; falls back to DB.
 */
export async function getActiveCatalogEntry(
  sc: SupabaseClient,
  canonicalKey: string,
  stampType: string,
): Promise<CatalogEntry | null> {
  const ck = cacheKey(canonicalKey, stampType);
  const cached = catalogCache.get(ck);
  if (cached) return cached;

  const entry = await fetchEntryByKey(sc, canonicalKey, stampType);
  if (entry?.status === "approved") {
    catalogCache.set(ck, entry);
  }
  return entry;
}

/**
 * Get a single catalog entry by ID (with active artwork URL).
 */
export async function getCatalogEntryById(
  sc: SupabaseClient,
  id: string,
): Promise<CatalogEntry | null> {
  return fetchEntryById(sc, id);
}

/**
 * Bulk fetch approved catalog entries by ID array.
 * Used for Passport page load — returns a map of id → CatalogEntry.
 */
export async function batchGetActive(
  sc: SupabaseClient,
  catalogIds: string[],
): Promise<Map<string, CatalogEntry>> {
  if (catalogIds.length === 0) return new Map();

  const result = new Map<string, CatalogEntry>();
  const missing: string[] = [];

  // Check cache first
  for (const id of catalogIds) {
    // Cache is keyed by canonical_key::stamp_type, not id — do a direct DB batch
    // For batch performance we always query DB but keep individual cache entries warm
    missing.push(id);
  }

  if (missing.length === 0) return result;

  const { data, error } = await sc
    .from("universal_stamp_catalog")
    .select(
      "id, canonical_location_key, stamp_type, display_name, country, country_code, " +
      "region, city, neighborhood, lat, lng, status, active_version_id, " +
      "earn_count, prompt_template_version, created_at, updated_at, " +
      "stamp_artwork_versions!fk_catalog_active_version(public_url)"
    )
    .in("id", missing);

  if (error || !data) return result;

  for (const row of data as any[]) {
    const entry = shapeRow(row);
    result.set(entry.id, entry);
    if (entry.status === "approved") {
      catalogCache.set(cacheKey(entry.canonical_location_key, entry.stamp_type), entry);
    }
  }

  return result;
}

/**
 * Invalidate a catalog entry from the cache (call after approve/reject).
 */
export function invalidateCatalogCache(canonicalKey: string, stampType: string): void {
  catalogCache.delete(cacheKey(canonicalKey, stampType));
}

/** Expose cache for testing. */
export function _clearCatalogCache(): void {
  catalogCache.clear();
}
