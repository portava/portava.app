/**
 * placeSearchCache — module-level in-memory cache for place search results.
 *
 * Shared between usePlaceSearch (React hook) and useUniversalLocation
 * (imperative searchPlaces method) so the same cache entry is used regardless
 * of which path issues the search.
 *
 * Cache key: `${query}:${JSON.stringify(opts)}`
 * TTL: 5 minutes
 * In-flight dedup: second identical concurrent query returns the same Promise.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<import('../location/placeTypes').Place[]>>();
const inFlight = new Map<string, Promise<import('../location/placeTypes').Place[]>>();

export function getCached(key: string): import('../location/placeTypes').Place[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached(key: string, value: import('../location/placeTypes').Place[]): void {
  cache.set(key, { value, ts: Date.now() });
}

export function getInFlight(key: string): Promise<import('../location/placeTypes').Place[]> | null {
  return inFlight.get(key) ?? null;
}

export function setInFlight(key: string, promise: Promise<import('../location/placeTypes').Place[]>): void {
  inFlight.set(key, promise);
}

export function deleteInFlight(key: string): void {
  inFlight.delete(key);
}

export function makeCacheKey(
  query: string,
  opts?: { countryCode?: string; type?: string; lat?: number; lng?: number },
): string {
  return `${query}:${JSON.stringify(opts ?? {})}`;
}
