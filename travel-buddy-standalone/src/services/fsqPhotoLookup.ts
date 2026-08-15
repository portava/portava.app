/**
 * fsqPhotoLookup — server-proxied Foursquare photo lookup for place cards.
 *
 * Calls the api-server's GET /api/places/fsq-photo route, which holds the
 * FOURSQUARE_API_KEY server-side and proxies the Foursquare Places API
 * call. Routing through the server avoids the CORS failure that occurs when
 * the browser calls Foursquare directly (Foursquare does not emit
 * Access-Control-Allow-Origin headers, so the preflight OPTIONS check is
 * blocked on the web build).
 *
 * Results are selectively cached in memory (24 h TTL):
 *   - A verified photo URL (server HEAD-checked, no `reason` in response) → cached.
 *   - Confirmed absence (`reason: "no_photo_found"`) → cached; FSQ has no record.
 *   - Everything else (dead CDN link, HEAD unverified, outage, transport error) →
 *     NOT cached, so the next mount retries through the server proxy.
 *
 * ATTRIBUTION: any surface showing FSQ photos must display "Powered by
 * Foursquare" (FSQ API license requirement).
 */

import { reportPhotoLookupResult } from './photoProviderOutage.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry { url: string | null; ts: number }
const photoCache = new Map<string, CacheEntry>();

/**
 * In-flight dedup: if two callers request the same venue concurrently both
 * miss the empty cache before either one populates it. Instead of firing two
 * proxy requests, the second caller joins the first caller's Promise.
 * The entry is deleted once the request settles so the resolved value is
 * picked up from photoCache on any subsequent call.
 */
const inFlightPhotos = new Map<string, Promise<string | null>>();

function cacheKey(name: string, lat: number | null, lng: number | null): string {
  const n = name.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${n}|${lat != null ? lat.toFixed(3) : '_'}|${lng != null ? lng.toFixed(3) : '_'}`;
}

/**
 * The only null-result reason the server considers a durable fact about a
 * place (FSQ has no record — this won't change in the next 24 h). All other
 * null outcomes are transient and must not be client-cached so the next mount
 * retries.
 */
const CACHED_ABSENT_REASONS: ReadonlySet<string> = new Set(['no_photo_found']);
/**
 * Returns true when `url` is served from a Foursquare photo CDN.
 * Use this to decide whether to render "Powered by Foursquare" attribution
 * next to a displayed image (required by FSQ API terms).
 */
export function isFoursquarePhotoUrl(url: string): boolean {
  return url.includes('4sqi.net') || url.includes('foursquare.com/img');
}

/**
 * Look up the primary Foursquare photo for a place by name + coordinates,
 * via the api-server proxy. Returns a photo URL string, or null when
 * unavailable. Never throws.
 */
export async function lookupFsqPhoto(
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

  // Return the existing in-flight promise so concurrent callers for the same
  // venue share one proxy request instead of double-billing the API quota.
  const existing = inFlightPhotos.get(cKey);
  if (existing) return existing;

  const request = (async (): Promise<string | null> => {
    try {
      const params = new URLSearchParams({ name: name.trim() });
      if (resolvedLat != null && resolvedLng != null) {
        params.set('lat', String(resolvedLat));
        params.set('lng', String(resolvedLng));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${apiBase()}/api/places/fsq-photo?${params}`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        // The proxy itself is unreachable or erroring — a transport failure,
        // not evidence about this place. Do NOT cache so the next mount retries.
        reportPhotoLookupResult('foursquare', 'proxy_http_error');
        return null;
      }

      const body = (await res.json()) as { photoUrl?: string | null; reason?: string | null };
      const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;
      // The server computes `reason` on every failure path precisely so this
      // distinction survives. Reading only `photoUrl` is what made a dead
      // provider indistinguishable from a photoless place.
      if (!photoUrl) reportPhotoLookupResult('foursquare', body.reason);

      // Only cache results the server considers durable:
      //   • Verified positive URL — proxy returned photoUrl and no reason (the
      //     server's HEAD liveness check passed; cacheable: true server-side).
      //   • Confirmed absence — `no_photo_found` means FSQ has no record for
      //     this place, which won't change in the next 24 h.
      // Everything else is transient (dead CDN link via `dead_photo_link`,
      // HEAD unverified via `head_check_failed`, outages, transport failures)
      // and must NOT be cached so the next mount retries through the proxy.
      const shouldCache =
        photoUrl !== null
          ? !body.reason                              // verified positive
          : CACHED_ABSENT_REASONS.has(body.reason ?? ''); // confirmed absence only

      if (shouldCache) {
        photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
      }
      return photoUrl;
    } catch {
      // Network-level failure (timeout, abort, DNS) — transient; do NOT cache.
      reportPhotoLookupResult('foursquare', 'proxy_unreachable');
      return null;
    } finally {
      inFlightPhotos.delete(cKey);
    }
  })();

  inFlightPhotos.set(cKey, request);
  return request;
}
