/**
 * fsqPhotoLookup — SERVER-PROXIED Foursquare photo lookup for place cards.
 *
 * Calls the api-server's GET /api/places/fsq-photo route, which holds
 * FOURSQUARE_API_KEY server-side. Results are cached in memory (24 h TTL) so
 * the same place is only fetched once per app session. Failures are silent —
 * callers fall back to category artwork, then to googlePhotoLookup.
 *
 * WHY IT IS PROXIED NOW, WHEN IT USED TO CALL FOURSQUARE DIRECTLY
 * ==============================================================
 * It called https://places-api.foursquare.com/places/search from the browser,
 * with a key compiled into the bundle. Two problems, and the second is the one
 * that outlives the first:
 *
 *   1. CORS. That host serves no browser CORS headers, so on web the request
 *      could not succeed at all. A live probe of the discovery surface found
 *      exactly these blocked calls, on every place card. The photos were never
 *      arriving.
 *   2. CREDENTIAL EXPOSURE. EXPO_PUBLIC_* is compiled into the client bundle,
 *      so the key was handed to every browser that loaded the app. This file's
 *      previous header described it as "already public" — which states the
 *      leak rather than justifying it. A key that has shipped in a bundle is
 *      compromised regardless of what the code does afterwards, so ROTATING IT
 *      is a separate and necessary operator action; removing this call site
 *      only stops the bleeding.
 *
 * Both are fixed by the same move: the request becomes same-origin and the
 * credential stays on the server.
 *
 * What deliberately did NOT change: the 24 h memory cache, the in-flight
 * dedup, and the silent-failure contract. None of those was the bug, and the
 * dedup still matters — the quota it protects is now the server's.
 *
 * ATTRIBUTION: any surface showing FSQ photos must display "Powered by
 * Foursquare". That obligation attaches to DISPLAY, not to fetching, so moving
 * the fetch to the server does not discharge it.
 */
// Shared lazy Sentry accessor — defers require('@sentry/react-native') to
// call-time so node:test runners can import this file without triggering the
// esbuild "Unexpected typeof" TransformError from react-native source.
import { getSentry as _getSentryBase } from '../lib/sentry.ts';

// Test-only injection point. When set (including null = "Sentry unavailable"),
// getSentry() returns this value instead of calling _getSentryBase(). Set via
// _setSentryForTest(); clear by passing undefined to restore normal behaviour.
let _sentryOverride:
  | { captureMessage: (m: string, opts?: any) => void; addBreadcrumb: (d: any) => void }
  | null
  | undefined = undefined;
/** @internal Only for node:test suites — inject a Sentry stub so auth-error tests
 *  can assert on captureMessage/addBreadcrumb without loading @sentry/react-native.
 *  Also resets the module-level authFailedReported flag so each test begins clean. */
export function _setSentryForTest(
  s:
    | { captureMessage: (m: string, opts?: any) => void; addBreadcrumb: (d: any) => void }
    | null
    | undefined,
): void {
  _sentryOverride = s;
  // Reset per-session dedup flag whenever a test injects a fresh stub so that
  // successive auth-error tests each see a clean slate.
  if (s !== undefined) authFailedReported = false;
}

/** @internal Only for node:test suites — reset the once-per-session auth-failure
 *  guard so each test that exercises a 401/403 path sees a fresh state. */
export function _resetAuthStateForTest(): void {
  authFailedReported = false;
}
function getSentry(): typeof import('@sentry/react-native') | null {
  if (_sentryOverride !== undefined) return (_sentryOverride ?? null) as any;
  return _getSentryBase();
}

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const FSQ_PHOTO_PROXY = '/api/places/fsq-photo';

/** Ensures the Sentry auth-failure event fires at most once per app session. */
let authFailedReported = false;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry { url: string | null; ts: number }
const photoCache = new Map<string, CacheEntry>();

/**
 * In-flight dedup: if two callers request the same venue concurrently both
 * miss the empty cache before either one populates it. Instead of firing two
 * Foursquare requests, the second caller joins the first caller's Promise.
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
 * Look up the primary Foursquare photo for a place by name + coordinates.
 * Returns a photo URL string, or null when unavailable. Never throws.
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

      const res = await fetch(`${apiBase()}${FSQ_PHOTO_PROXY}?${params}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        const isAuthError = res.status === 401 || res.status === 403;
        const sentry = getSentry();
        sentry?.addBreadcrumb({
          category: 'foursquare',
          message: `FSQ photo lookup failed — HTTP ${res.status}`,
          level: isAuthError ? 'error' : 'warning',
          data: { status: res.status, place: name },
        });
        if (isAuthError && !authFailedReported) {
          authFailedReported = true;
          sentry?.captureMessage('Foursquare photo proxy failed — check the api-server FOURSQUARE_API_KEY', {
            level: 'error',
            extra: { status: res.status, place: name },
          });
        }
        photoCache.set(cKey, { url: null, ts: Date.now() });
        return null;
      }

      // The server has already resolved prefix+suffix into a URL, so this side
      // no longer models Foursquare's response shape at all — one fewer place
      // for a provider change to break.
      const body = (await res.json()) as { photoUrl?: string | null };
      const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl : null;

      photoCache.set(cKey, { url: photoUrl, ts: Date.now() });
      return photoUrl;
    } catch {
      photoCache.set(cKey, { url: null, ts: Date.now() });
      return null;
    } finally {
      inFlightPhotos.delete(cKey);
    }
  })();

  inFlightPhotos.set(cKey, request);
  return request;
}
