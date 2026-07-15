/**
 * Nearby venues helper — OpenStreetMap Nominatim + Overpass API.
 *
 * Free, no API key required. Uses:
 *   - Nominatim for geocoding a location name → lat/lng
 *   - Overpass API for nearby restaurant/cafe/food POIs
 *
 * Results are cached in-memory with a 30-minute TTL (restaurant data
 * changes slowly; caching avoids hammering OSM on repeated commands).
 *
 * Privacy: only the location name is sent to Nominatim; only lat/lng
 * is sent to Overpass. No user identifiers leave this server.
 *
 * Graceful degradation: any error, timeout, or empty result returns [].
 * Callers must treat the result as optional and fall back to templates.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 30 * 60 * 1_000; // 30 minutes
const DEFAULT_RADIUS_M = 600;
const MAX_RESULTS = 5;

export interface NearbyVenue {
  name: string;
  cuisine: string | null;
  distanceM: number;
  priceLevel: string;
}

interface CacheEntry {
  venues: NearbyVenue[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(location: string): string {
  return location.toLowerCase().trim();
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocode(location: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy app)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  const r = data?.[0];
  if (!r) return null;
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
}

/**
 * Convert a cuisine tag from OSM ("italian;pizza" → "Italian")
 * or return a friendly fallback.
 */
function formatCuisine(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(/[;,]/)[0]?.trim() ?? "";
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).replace(/_/g, " ");
}

/**
 * Estimate distance in metres between two lat/lng points (Haversine).
 */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Map distance to a rough price level (OSM rarely carries price data;
 * we use amenity type as a proxy instead).
 */
function guessPriceLevel(amenity: string): string {
  if (amenity === "fast_food") return "$";
  if (amenity === "cafe") return "$";
  if (amenity === "food_court") return "$";
  return "$$";
}

async function queryOverpass(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<NearbyVenue[]> {
  // Query restaurants, cafes, fast food, and bars within the radius
  const query = `
[out:json][timeout:5];
(
  node["amenity"~"^(restaurant|cafe|fast_food|bistro|bar|pub)$"](around:${radiusM},${lat},${lng});
  way["amenity"~"^(restaurant|cafe|fast_food|bistro|bar|pub)$"](around:${radiusM},${lat},${lng});
);
out body center qt ${MAX_RESULTS * 3};`.trim();

  const res = await fetchWithTimeout(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) return [];

  const data = (await res.json()) as {
    elements: Array<{
      id: number;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: Record<string, string>;
    }>;
  };

  if (!data?.elements?.length) return [];

  const venues: NearbyVenue[] = data.elements
    .filter((el) => el.tags?.name)
    .map((el) => {
      const elLat = el.lat ?? el.center?.lat ?? lat;
      const elLng = el.lon ?? el.center?.lon ?? lng;
      return {
        name: el.tags!.name!,
        cuisine: formatCuisine(el.tags?.cuisine),
        distanceM: Math.round(haversineM(lat, lng, elLat, elLng)),
        priceLevel: guessPriceLevel(el.tags?.amenity ?? "restaurant"),
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_RESULTS);

  return venues;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Returns up to 5 real nearby food venues for the given location string.
 * Returns [] on any error or when no named venues are found.
 */
export async function getNearbyVenues(
  location: string,
  radiusM = DEFAULT_RADIUS_M,
): Promise<NearbyVenue[]> {
  const key = cacheKey(location);
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached.venues;

  try {
    const coords = await geocode(location);
    if (!coords) return [];

    const venues = await queryOverpass(coords.lat, coords.lng, radiusM);

    cache.set(key, { venues, cachedAt: Date.now() });
    return venues;
  } catch {
    return [];
  }
}

/**
 * Format a distance in metres to a human-readable string.
 */
export function formatDistance(distanceM: number): string {
  if (distanceM < 100) return "< 100m away";
  if (distanceM < 1000) return `${Math.round(distanceM / 50) * 50}m away`;
  return `${(distanceM / 1000).toFixed(1)}km away`;
}
