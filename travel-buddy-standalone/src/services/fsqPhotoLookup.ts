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

const FSQ_SEARCH = 'https://places-api.foursquare.com/places/search';

/** Ensures the Sentry auth-failure event fires at most once per app session. */
let authFailedReported = false;

/** @internal Only for node:test suites — reset the once-per-process auth guard
 *  between tests so each test can assert a fresh captureMessage call. */
export function _resetAuthFailedForTest(): void {
  authFailedReported = false;
}
const FSQ_API_VERSION = '2025-06-17';
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
  const apiKey = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;
  if (!apiKey || !name.trim()) return null;

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
      const params = new URLSearchParams({
        query:  name.trim(),
        limit:  '1',
        fields: 'photos',
      });
      if (resolvedLat != null && resolvedLng != null) {
        params.set('ll', `${resolvedLat},${resolvedLng}`);
      }

      const res = await fetch(`${FSQ_SEARCH}?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'X-Places-Api-Version': FSQ_API_VERSION },
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
          sentry?.captureMessage('Foursquare photo lookup auth failure — check EXPO_PUBLIC_FOURSQUARE_API_KEY', {
            level: 'error',
            extra: { status: res.status, place: name },
          });
        }
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
    } finally {
      inFlightPhotos.delete(cKey);
    }
  })();

  inFlightPhotos.set(cKey, request);
  return request;
}
