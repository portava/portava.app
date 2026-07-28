/**
 * discoveryPersistentCache — Postgres-backed L2 cache for Discovery routes.
 *
 * The in-memory Maps (cache, _geocodeMemory) in discovery.ts are the L1 layer:
 * fast but ephemeral.  This module is the L2 layer: slightly slower (1–5 ms DB
 * round-trip) but survives restarts and is shared across autoscale instances.
 *
 * All functions are non-blocking: errors are swallowed so a DB failure never
 * breaks a live request.
 *
 * TTLs mirror the in-memory constants:
 *   places   — 2 hours  (CACHE_TTL_MS in discovery.ts)
 *   geocode  — 24 hours (GEOCODE_CACHE_TTL in discovery.ts)
 */

import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";

const PLACE_TTL_MS   = 2  * 60 * 60 * 1_000;  // 2 h
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1_000;  // 24 h

// ── Types ────────────────────────────────────────────────────────────────────

export interface DbPlaceEntry {
  places:         unknown[];
  cachedAt:       number;       // Unix ms — matches CacheEntry.cachedAt
  geocodeLat:     number | null;
  geocodeLng:     number | null;
  geocodeDisplay: string | null;
}

export interface DbGeocodeEntry {
  lat:     number;
  lng:     number;
  display: string;
}

// ── Place cache ──────────────────────────────────────────────────────────────

/**
 * Read a place result from the DB cache.
 *
 * Returns `{ entry, isStale }` when a row exists regardless of freshness —
 * callers implement stale-while-revalidate themselves.
 * Returns `null` when no row is found.
 */
export async function readPlacesFromDb(
  key: string,
): Promise<{ entry: DbPlaceEntry; isStale: boolean } | null> {
  try {
    const sc = getServiceClient();
    if (!sc) return null;

    const { data, error } = await sc
      .from("discovery_cache")
      .select("places, cached_at, expires_at, geocode_lat, geocode_lng, geocode_display")
      .eq("cache_key", key)
      .maybeSingle();

    if (error || !data) return null;

    const row       = data as any;
    const cachedAt  = new Date(row.cached_at  as string).getTime();
    const expiresAt = new Date(row.expires_at as string).getTime();

    return {
      entry: {
        places:         (row.places          as unknown[]) ?? [],
        cachedAt,
        geocodeLat:     (row.geocode_lat     as number | null) ?? null,
        geocodeLng:     (row.geocode_lng     as number | null) ?? null,
        geocodeDisplay: (row.geocode_display as string | null) ?? null,
      },
      isStale: Date.now() > expiresAt,
    };
  } catch (e) {
    logger.debug({ err: e, key }, "discoveryPersistentCache: readPlacesFromDb error");
    return null;
  }
}

/**
 * Write (upsert) a place result into the DB cache.  Fire-and-forget safe.
 */
export async function writePlacesToDb(
  key:         string,
  destination: string,
  category:    string,
  radiusKm:    number,
  places:      unknown[],
  geocode:     { lat: number; lng: number; display?: string } | null,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + PLACE_TTL_MS);

    const { error } = await sc.from("discovery_cache").upsert(
      {
        cache_key:       key,
        destination,
        category,
        radius_km:       radiusKm,
        places,
        geocode_lat:     geocode?.lat     ?? null,
        geocode_lng:     geocode?.lng     ?? null,
        geocode_display: geocode?.display ?? null,
        cached_at:       now.toISOString(),
        expires_at:      expiresAt.toISOString(),
      },
      { onConflict: "cache_key" },
    );

    if (error) {
      logger.debug({ err: error, key }, "discoveryPersistentCache: writePlacesToDb error");
    }
  } catch (e) {
    logger.debug({ err: e, key }, "discoveryPersistentCache: writePlacesToDb exception");
  }
}

// ── Geocode cache ─────────────────────────────────────────────────────────────

/**
 * Read a geocode result from the DB cache.  Returns null on miss or expiry.
 * Geocode cache is strict-TTL (no stale-while-revalidate) — Nominatim results
 * are stable; returning stale coords for a renamed place would be rare.
 */
export async function readGeocodeFromDb(
  key: string,
): Promise<DbGeocodeEntry | null> {
  try {
    const sc = getServiceClient();
    if (!sc) return null;

    const { data, error } = await sc
      .from("discovery_geocode_cache")
      .select("lat, lng, display_name, expires_at")
      .eq("location_key", key)
      .maybeSingle();

    if (error || !data) return null;

    const row       = data as any;
    const expiresAt = new Date(row.expires_at as string).getTime();
    if (Date.now() > expiresAt) return null;

    return {
      lat:     row.lat         as number,
      lng:     row.lng         as number,
      display: row.display_name as string,
    };
  } catch (e) {
    logger.debug({ err: e, key }, "discoveryPersistentCache: readGeocodeFromDb error");
    return null;
  }
}

/**
 * Invalidate all discovery_cache rows that contain a given OSM place.
 *
 * OSM places are stored inside the JSONB `places` array with id equal to the
 * OSM element string (e.g. "node/12345678", "way/987654").  When a user saves
 * or un-saves an OSM place the save count changes; any L2 cache row that
 * holds the stale enriched count must be evicted so the next request
 * re-enriches from the live discovery_places table.
 *
 * Fire-and-forget safe: errors are swallowed — a cache miss is always
 * preferable to surfacing a DB error to the caller.
 */
export async function invalidateDiscoveryCacheForOsmId(osmId: string): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    // PostgREST "cs" (contains) operator: places @> '[{"id":"node/12345678"}]'
    const { error } = await sc
      .from("discovery_cache")
      .delete()
      .filter("places", "cs", JSON.stringify([{ id: osmId }]));

    if (error) {
      logger.debug(
        { err: error, osmId },
        "discoveryPersistentCache: invalidateDiscoveryCacheForOsmId error",
      );
    }
  } catch (e) {
    logger.debug(
      { err: e, osmId },
      "discoveryPersistentCache: invalidateDiscoveryCacheForOsmId exception",
    );
  }
}

/**
 * Invalidate all discovery_cache rows that contain a given entity.
 *
 * DB-backed places are stored inside the JSONB `places` array with id
 * `"db/<entityId>"`.  When an admin approve/reject/downgrade changes the
 * accuracy_status or image_source_type of a visual, every cache row that
 * contains that place must be evicted so the next request re-hydrates it with
 * the correct resolved header image.
 *
 * Fire-and-forget safe: errors are swallowed — a cache miss is always
 * preferable to breaking a live admin action.
 */
export async function invalidateDiscoveryCacheForEntity(entityId: string): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    // PostgREST "cs" (contains) operator: places @> '[{"id":"db/<uuid>"}]'
    const { error } = await sc
      .from("discovery_cache")
      .delete()
      .filter("places", "cs", JSON.stringify([{ id: `db/${entityId}` }]));

    if (error) {
      logger.debug(
        { err: error, entityId },
        "discoveryPersistentCache: invalidateDiscoveryCacheForEntity error",
      );
    }
  } catch (e) {
    logger.debug(
      { err: e, entityId },
      "discoveryPersistentCache: invalidateDiscoveryCacheForEntity exception",
    );
  }
}

/**
 * Write (upsert) a geocode result into the DB cache.  Fire-and-forget safe.
 */
export async function writeGeocodeToDb(
  key:    string,
  result: DbGeocodeEntry,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + GEOCODE_TTL_MS);

    const { error } = await sc.from("discovery_geocode_cache").upsert(
      {
        location_key: key,
        lat:          result.lat,
        lng:          result.lng,
        display_name: result.display,
        cached_at:    now.toISOString(),
        expires_at:   expiresAt.toISOString(),
      },
      { onConflict: "location_key" },
    );

    if (error) {
      logger.debug({ err: error, key }, "discoveryPersistentCache: writeGeocodeToDb error");
    }
  } catch (e) {
    logger.debug({ err: e, key }, "discoveryPersistentCache: writeGeocodeToDb exception");
  }
}
