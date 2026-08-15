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
 * Results are cached in memory (24 h TTL) so the same place is only fetched
 * once per app session. Failures are silent — callers fall back to
 * category artwork.
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
        // The proxy itself is unreachable or erroring. That is an outage, not
        // evidence this place has no photo. Do NOT cache — the condition may
        // clear (server restarts, network recovers) and we must retry.
        reportPhotoLookupResult('foursquare', 'proxy_http_error');
        return null;
      }

      const body = (await res.json()) as { photoUrl?: string | null; reason?: string | null };
      const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;
      const reason = body.reason ?? null;
      // The server computes `reason` on every failure path precisely so this
      // distinction survives. Reading only `photoUrl` is what made a dead
      // provider indistinguishable from a photoless place.
      if (!photoUrl) reportPhotoLookupResult('foursquare', reason);
      // Cache only stable results:
      //   • A confirmed photo URL (reason absent or any non-outage value).
      //   • Confirmed absence (no_photo_found = FSQ has no record for this place).
      // Do NOT cache:
      //   • Outage reasons (quota_exhausted, auth_error, proxy errors) — billing/
      //     config state that can clear without a code deploy.
      //   • "unverified_url" — the server's CDN HEAD check timed out, so the URL
      //     is served optimistically but may be dead. Caching it would pin this
      //     client to a broken image for 24 h; skipping the cache lets the next
      //     request retry via the proxy (which will run a fresh HEAD check).
      const shouldCache = photoUrl !== null
        ? reason !== 'unverified_url'      // verified URL → cache; unverified → don't
        : reason === 'no_photo_found';     // null → cache only on genuine absence
      if (shouldCache) photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
      return photoUrl;
    } catch {
      // Network / timeout error — transient, do NOT cache.
      reportPhotoLookupResult('foursquare', 'proxy_unreachable');
      return null;
    } finally {
      inFlightPhotos.delete(cKey);
    }
  })();

  inFlightPhotos.set(cKey, request);
  return request;
}
