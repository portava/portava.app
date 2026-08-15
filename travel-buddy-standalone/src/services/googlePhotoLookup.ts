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
import { reportPhotoLookupResult } from './photoProviderOutage.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry { url: string | null; ts: number }
const photoCache = new Map<string, CacheEntry>();

/**
 * In-flight dedup: if two callers request the same venue concurrently both
 * miss the empty cache before either one populates it. Instead of firing two
 * Google Places requests, the second caller joins the first caller's Promise.
 * The entry is deleted once the request settles so the resolved value is
 * picked up from photoCache on any subsequent call.
 */
const inFlightPhotos = new Map<string, Promise<string | null>>();

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
  placeKey?: string | null,
): Promise<string | null> {
  if (!name.trim()) return null;

  const resolvedLat = lat ?? null;
  const resolvedLng = lng ?? null;
  const cKey = cacheKey(name, resolvedLat, resolvedLng);

  const cached = photoCache.get(cKey);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.url;

  // Return the existing in-flight promise so concurrent callers for the same
  // venue share one fetch instead of double-billing the API quota.
  const existing = inFlightPhotos.get(cKey);
  if (existing) return existing;

  const request = (async (): Promise<string | null> => {
    try {
      const params = new URLSearchParams({ name: name.trim() });
      if (resolvedLat != null && resolvedLng != null) {
        params.set('lat', String(resolvedLat));
        params.set('lng', String(resolvedLng));
      }
      // Identifies the place so the server can store the resolved photo. What
      // gets stored for Google is the photo REFERENCE, never the media URL —
      // that URL carries the API key. Optional: without it, nothing persists
      // and the route behaves exactly as before.
      if (placeKey) params.set('placeKey', placeKey);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${apiBase()}/api/places/photo?${params}`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        // The proxy itself is unreachable or erroring. That is an outage, not
        // evidence this place has no photo.
        reportPhotoLookupResult('google', 'proxy_http_error');
        photoCache.set(cKey, { url: null, ts: Date.now() });
        return null;
      }

      const body = (await res.json()) as { photoUrl?: string | null; reason?: string | null };
      const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;
      // SERVICE_DISABLED arrives here as `google_places_api_new_service_disabled`.
      // Discarding it is what let a project-wide disabled API look like a run
      // of places that happen to have no pictures.
      if (!photoUrl) reportPhotoLookupResult('google', body.reason);
      photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
      return photoUrl;
    } catch {
      reportPhotoLookupResult('google', 'proxy_unreachable');
      photoCache.set(cKey, { url: null, ts: Date.now() });
      return null;
    } finally {
      inFlightPhotos.delete(cKey);
    }
  })();

  inFlightPhotos.set(cKey, request);
  return request;
}
