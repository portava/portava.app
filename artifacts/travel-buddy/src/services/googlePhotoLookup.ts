/**
 * googlePhotoLookup — server-proxied Google Places (New) photo lookup.
 *
 * Second link in the Discovery place-photo fallback chain, after Foursquare
 * (fsqPhotoLookup.ts) comes up empty. Calls the api-server's
 * GET /api/places/photo route, which holds the GOOGLE_MAPS_API_KEY
 * server-side. Results are cached in memory (24h TTL) so the same place is
 * only looked up once per app session.
 *
 * Failures are silent — callers fall back to category artwork. Never throws.
 */
const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry { url: string | null; ts: number }
const photoCache = new Map<string, CacheEntry>();

function cacheKey(name: string, lat: number | null, lng: number | null): string {
  const n = name.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${n}|${lat != null ? lat.toFixed(3) : '_'}|${lng != null ? lng.toFixed(3) : '_'}`;
}

/**
 * Look up a real photo for a place via Google Places (New), proxied through
 * the api-server. Returns a photo URL, or null when unavailable (missing
 * key, API not enabled on the Google Cloud project, no photo found, or a
 * network failure) — the caller then shows category-appropriate artwork.
 */
export async function lookupGooglePhoto(
  name: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<string | null> {
  if (!name.trim()) return null;

  const resolvedLat = lat ?? null;
  const resolvedLng = lng ?? null;
  const cKey = cacheKey(name, resolvedLat, resolvedLng);

  const cached = photoCache.get(cKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.url;

  try {
    const params = new URLSearchParams({ name: name.trim() });
    if (resolvedLat != null && resolvedLng != null) {
      params.set('lat', String(resolvedLat));
      params.set('lng', String(resolvedLng));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${apiBase()}/api/places/photo?${params}`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      photoCache.set(cKey, { url: null, ts: Date.now() });
      return null;
    }

    const body = (await res.json()) as { photoUrl?: string | null };
    const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;
    photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
    return photoUrl;
  } catch {
    photoCache.set(cKey, { url: null, ts: Date.now() });
    return null;
  }
}
