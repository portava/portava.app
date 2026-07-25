/**
 * fsqPhotoLookup — client-side Foursquare photo lookup for place cards.
 *
 * Uses EXPO_PUBLIC_FOURSQUARE_API_KEY (already public) to search for a venue
 * by name + coordinates and return the first photo URL. Results are cached in
 * memory (24 h TTL) so the same place is only fetched once per app session.
 * Failures are silent — callers fall back to category artwork.
 *
 * ATTRIBUTION: any surface showing FSQ photos must display "Powered by Foursquare".
 */

const FSQ_SEARCH = 'https://api.foursquare.com/v3/places/search';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry { url: string | null; ts: number }
const photoCache = new Map<string, CacheEntry>();

function cacheKey(name: string, lat: number | null, lng: number | null): string {
  const n = name.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${n}|${lat != null ? lat.toFixed(3) : '_'}|${lng != null ? lng.toFixed(3) : '_'}`;
}

/**
 * Look up the primary Foursquare photo for a place by name + coordinates.
 * Returns a photo URL string, or null when unavailable. Never throws.
 */
export async function lookupFsqPhoto(
  name: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<string | null> {
  const apiKey = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;
  if (!apiKey || !name.trim()) return null;

  const resolvedLat = lat ?? null;
  const resolvedLng = lng ?? null;
  const cKey = cacheKey(name, resolvedLat, resolvedLng);

  const cached = photoCache.get(cKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.url;

  try {
    const params = new URLSearchParams({
      query:  name.trim(),
      limit:  '1',
      fields: 'photos',
    });
    if (resolvedLat != null && resolvedLng != null) {
      params.set('ll', `${resolvedLat},${resolvedLng}`);
    }

    const res = await fetch(`${FSQ_SEARCH}?${params}`, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      photoCache.set(cKey, { url: null, ts: Date.now() });
      return null;
    }

    const body = await res.json() as { results?: Array<{ photos?: Array<{ prefix?: string; suffix?: string }> }> };
    const photos = body?.results?.[0]?.photos ?? [];
    let photoUrl: string | null = null;

    if (photos.length > 0) {
      const p = photos[0];
      if (typeof p?.prefix === 'string' && typeof p?.suffix === 'string') {
        photoUrl = `${p.prefix}original${p.suffix}`;
      }
    }

    photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
    return photoUrl;
  } catch {
    photoCache.set(cKey, { url: null, ts: Date.now() });
    return null;
  }
}
