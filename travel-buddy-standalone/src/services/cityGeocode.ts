/**
 * cityGeocode — forward-geocode a city name to lat/lng coordinates.
 *
 * Uses Nominatim (OpenStreetMap) — the same source the API server uses for
 * country resolution.  Results are cached in two layers:
 *
 *   L1 — in-memory Map (session cache, cleared on app restart)
 *   L2 — AsyncStorage (cross-session, 30-day TTL)
 *
 * Callers that want cross-session persistence should:
 *   1. Call `preloadGeocodeCache(storage)` once on mount to warm L1 from L2.
 *   2. Pass the same `storage` handle to `geocodeCityToCoords` /
 *      `batchGeocodeCities` so new Nominatim results are persisted to L2.
 *
 * Returns null when the city cannot be resolved or on network error.
 */

// ── AsyncStorage interface ─────────────────────────────────────────────────────

/** Minimal subset of AsyncStorage needed by these helpers (injectable for tests). */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

// ── Storage key & TTL ─────────────────────────────────────────────────────────

export const GEOCODE_STORAGE_KEY = 'geocode_city_coords_v1';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

// ── Storage entry shape ────────────────────────────────────────────────────────

interface StorageEntry {
  coords: [number, number] | null;
  cachedAt: number; // Date.now() timestamp
}

type StorageBlob = Record<string, StorageEntry>;

// ── L1 in-memory cache ─────────────────────────────────────────────────────────

const _cache = new Map<string, [number, number] | null>();

function makeCacheKey(city: string, country: string | null | undefined): string {
  return `${city.toLowerCase()}|${(country ?? '').toLowerCase()}`;
}

// ── L2 AsyncStorage helpers ────────────────────────────────────────────────────

async function readBlob(storage: StorageLike): Promise<StorageBlob> {
  try {
    const raw = await storage.getItem(GEOCODE_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StorageBlob;
  } catch {
    return {};
  }
}

async function writeEntry(
  storage: StorageLike,
  key: string,
  entry: StorageEntry,
): Promise<void> {
  try {
    const blob = await readBlob(storage);
    blob[key] = entry;
    await storage.setItem(GEOCODE_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Fire-and-forget — storage failures must never break geocoding.
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Warm the in-memory cache from AsyncStorage, skipping expired entries.
 *
 * Call once on map open (before `batchGeocodeCities`) to ensure cached
 * coordinates are available synchronously in subsequent lookups.
 *
 * Already-populated L1 entries are not overwritten.
 */
export async function preloadGeocodeCache(storage: StorageLike): Promise<void> {
  const blob = await readBlob(storage);
  const now = Date.now();
  for (const [key, entry] of Object.entries(blob)) {
    if (_cache.has(key)) continue; // L1 already has this key
    if (now - entry.cachedAt > CACHE_TTL_MS) continue; // expired — skip
    _cache.set(key, entry.coords);
  }
}

/**
 * Resolve a city name to [latitude, longitude].
 *
 * Checks L1 (in-memory) first, then hits Nominatim.  When `storage` is
 * provided, new Nominatim results (including null/unresolvable) are persisted
 * to L2 so they survive app restarts.
 *
 * Returns null if the lookup fails or the city is not found.
 */
export async function geocodeCityToCoords(
  city: string,
  country?: string | null,
  storage?: StorageLike,
): Promise<[number, number] | null> {
  const key = makeCacheKey(city, country);
  if (_cache.has(key)) return _cache.get(key)!;

  try {
    const query = country ? `${city}, ${country}` : city;
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}&format=json&limit=1`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'TravelBuddyApp/1.0' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      // Transient HTTP failure — cache in-memory only so the next session retries.
      _cache.set(key, null);
      return null;
    }
    const json = await res.json() as Array<{ lat: string; lon: string }>;
    if (!json.length) {
      // Nominatim definitively has no result — safe to persist across sessions.
      _cache.set(key, null);
      if (storage) {
        void writeEntry(storage, key, { coords: null, cachedAt: Date.now() });
      }
      return null;
    }
    const coords: [number, number] = [parseFloat(json[0].lat), parseFloat(json[0].lon)];
    _cache.set(key, coords);
    if (storage) {
      void writeEntry(storage, key, { coords, cachedAt: Date.now() });
    }
    return coords;
  } catch {
    // Network/timeout error — transient, do not persist to storage.
    _cache.set(key, null);
    return null;
  }
}

/**
 * Batch-geocode a list of cities sequentially with a small delay between
 * requests to respect Nominatim's 1 req/sec fair-use policy.
 *
 * When `storage` is provided, each Nominatim result is persisted to
 * AsyncStorage so subsequent app launches skip the network round-trip.
 *
 * Returns a Map from cache key → coords (null for unresolved entries).
 */
export async function batchGeocodeCities(
  entries: Array<{ city: string; country?: string | null }>,
  onProgress?: (resolved: number, total: number) => void,
  storage?: StorageLike,
): Promise<Map<string, [number, number] | null>> {
  const result = new Map<string, [number, number] | null>();
  let resolved = 0;

  for (const entry of entries) {
    const key = makeCacheKey(entry.city, entry.country);
    // Use cached value without a delay
    if (_cache.has(key)) {
      result.set(key, _cache.get(key)!);
      resolved++;
      onProgress?.(resolved, entries.length);
      continue;
    }
    const coords = await geocodeCityToCoords(entry.city, entry.country, storage);
    result.set(key, coords);
    resolved++;
    onProgress?.(resolved, entries.length);
    // 1.1 s gap to respect Nominatim fair-use (only when actually fetching)
    if (resolved < entries.length) {
      await new Promise<void>((r) => setTimeout(r, 1_100));
    }
  }

  return result;
}
