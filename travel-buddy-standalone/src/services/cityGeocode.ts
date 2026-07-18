/**
 * cityGeocode — forward-geocode a city name to lat/lng coordinates.
 *
 * Uses Nominatim (OpenStreetMap) — the same source the API server uses for
 * country resolution.  Results are cached in memory for the session so that
 * switching between list and map modes doesn't fire repeated network requests.
 *
 * Returns null when the city cannot be resolved or on network error.
 */

const _cache = new Map<string, [number, number] | null>();

function makeCacheKey(city: string, country: string | null | undefined): string {
  return `${city.toLowerCase()}|${(country ?? '').toLowerCase()}`;
}

/**
 * Resolve a city name to [latitude, longitude].
 * Returns null if the lookup fails or the city is not found.
 */
export async function geocodeCityToCoords(
  city: string,
  country?: string | null,
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
      _cache.set(key, null);
      return null;
    }
    const json = await res.json() as Array<{ lat: string; lon: string }>;
    if (!json.length) {
      _cache.set(key, null);
      return null;
    }
    const coords: [number, number] = [parseFloat(json[0].lat), parseFloat(json[0].lon)];
    _cache.set(key, coords);
    return coords;
  } catch {
    _cache.set(key, null);
    return null;
  }
}

/**
 * Batch-geocode a list of cities sequentially with a small delay between
 * requests to respect Nominatim's 1 req/sec fair-use policy.
 *
 * Returns a Map from cache key → coords (null for unresolved entries).
 */
export async function batchGeocodeCities(
  entries: Array<{ city: string; country?: string | null }>,
  onProgress?: (resolved: number, total: number) => void,
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
    const coords = await geocodeCityToCoords(entry.city, entry.country);
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
