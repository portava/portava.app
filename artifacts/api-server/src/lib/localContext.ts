/**
 * Local context helper — fetches top-rated POIs near a destination using
 * Nominatim (OSM geocoding) + Overpass API (OSM POIs).
 * Both are free and require no API key.
 *
 * Results are cached per destination with a 24-hour TTL.
 *
 * Privacy: only the destination name (geocoded to lat/lng) is sent externally.
 * No user identifiers or private data leave this server.
 *
 * Graceful degradation: any error or timeout returns null — callers must
 * treat the result as optional.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

export interface LocalTip {
  name: string;
  category: string; // "museum" | "restaurant" | "park" | "attraction" | etc.
}

export interface LocalContext {
  destination: string;
  tips: LocalTip[];        // up to 15 named POIs
  categories: string[];    // unique categories present — useful for suggestion boosting
}

interface CacheEntry {
  context: LocalContext;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocodeNominatim(destination: string): Promise<{ lat: number; lng: number } | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(destination)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TravelBuddy/1.0 (travel planning app; contact: support@travelbuddy.app)" },
  });
  if (!res.ok) return null;
  const data = await res.json() as any[];
  if (!data?.[0]) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function inferCategory(tags: Record<string, string>): string {
  if (tags.tourism === "museum") return "museum";
  if (tags.tourism === "gallery") return "art";
  if (tags.tourism === "attraction" || tags.tourism === "artwork") return "attraction";
  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.tourism) return "attraction";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "bar") return "bar";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.historic) return "historic";
  if (tags.natural) return "nature";
  return "landmark";
}

export async function getLocalContext(destination: string): Promise<LocalContext | null> {
  const key = destination.toLowerCase();
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached.context;

  try {
    const coords = await geocodeNominatim(destination);
    if (!coords) return null;

    const query =
      `[out:json][timeout:5];` +
      `(` +
      `node["tourism"~"museum|attraction|gallery|viewpoint"](around:6000,${coords.lat},${coords.lng});` +
      `node["amenity"~"restaurant|cafe|bar"](around:3000,${coords.lat},${coords.lng});` +
      `node["leisure"~"park|garden"](around:6000,${coords.lat},${coords.lng});` +
      `node["historic"](around:6000,${coords.lat},${coords.lng});` +
      `);` +
      `out 20;`;

    const res = await fetchWithTimeout(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const elements: any[] = data?.elements ?? [];

    const tips: LocalTip[] = elements
      .filter((el: any) => typeof el.tags?.name === "string" && el.tags.name.length > 0)
      .slice(0, 15)
      .map((el: any) => ({
        name: el.tags.name as string,
        category: inferCategory(el.tags as Record<string, string>),
      }));

    const categories = [...new Set(tips.map((t) => t.category))];
    const context: LocalContext = { destination, tips, categories };
    cache.set(key, { context, cachedAt: Date.now() });
    return context;
  } catch {
    return null;
  }
}
