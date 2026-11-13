/**
 * batchSignMedia — batch-sign helper for list screens.
 *
 * Calls POST /api/media/sign with up to 50 app-storage URLs per request,
 * caches results for the server-issued TTL minus a 5-minute safety buffer
 * (55 minutes for the current 3600 s server TTL), and silently falls back to the original URL
 * on any error (including 429). Cache hits are served without a network request.
 *
 * ## Authorization is mandatory
 *
 * POST /api/media/sign runs requireUser. This helper used to send only a
 * Content-Type header, so every request 401'd, fell into the catch below, and
 * passed the ORIGINAL url straight through to <Image> — which, since both
 * buckets went private, is a bare `post-media/…` reference with no scheme.
 * That rendered as dead whitespace on every media surface in the app. The
 * bearer token is not optional here; without it this function silently does
 * nothing useful.
 *
 * ## No feature-flag gate
 *
 * The `media_private_buckets_enabled` gate that used to short-circuit this
 * function is gone. The buckets ARE private and the server signs
 * unconditionally (see api-server routes/mediaFile.ts), so a client-side gate
 * could only ever turn the one working URL path off. Signing is now the only
 * behaviour.
 *
 * The cache is LRU-bounded to MAX_CACHE_SIZE entries. On each cache hit the
 * entry is moved to the tail (most-recently-used position). When a new entry
 * would exceed the cap the oldest (head) entry is evicted first.
 *
 * Exports:
 *   batchSignUrls(urls)      — resolve signed/relay URLs for a list of sources
 *   _resetBatchSignCache()   — clear the cache (tests only)
 *   _getCacheSize()          — current cache size (tests only)
 */

import { requestDeadline } from './requestDeadline.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope, onDiscoveryScopeChange, viewerKeyForToken } from '../services/discoveryViewerScope.ts';

export const MEDIA_SIGN_TIMEOUT_MS = 10_000;
let cacheViewer: string | null = null;
onDiscoveryScopeChange(() => { _resetBatchSignCache(); });

function signEndpoint(): string {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!base || /[\s\\?#@]/.test(base)) throw new Error('Invalid media API origin');
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.pathname !== '/') throw new Error('Invalid media API origin');
  return `${base.replace(/\/$/, '')}/api/media/sign`;
}

// ── Token provider (test seam) ───────────────────────────────────────────────

let _testTokenProvider: (() => Promise<string | null>) | null = null;

/**
 * Inject a fake token provider. Tests only — pass null to reset.
 * Mirrors the seam in services/media.ts so signing can be exercised without
 * standing up a Supabase session.
 */
export function _setTestSignTokenProvider(fn: (() => Promise<string | null>) | null): void {
  _testTokenProvider = fn;
}

/**
 * apiToken is imported lazily: it reaches lib/supabase.ts, which pulls in
 * react-native, which the node:test runner cannot transform. Deferring the
 * import keeps this module importable from plain node tests — they set the
 * seam above, so the real path is never evaluated there.
 */
async function signToken(): Promise<string | null> {
  if (_testTokenProvider) return _testTokenProvider();
  try {
    const { freshToken } = await import('../services/apiToken.ts');
    return await freshToken();
  } catch {
    return null;
  }
}

const BATCH_SIZE = 50;
/**
 * Safety buffer subtracted from the server-issued signed-URL TTL before the
 * cached entry is treated as expired.  Ensures the client re-signs before the
 * actual token expires, preventing mid-session 403s.
 */
const SIGN_TTL_SAFETY_BUFFER_S = 5 * 60; // 5 minutes
/** Fallback cache lifetime when the server omits ttlSeconds. */
const FALLBACK_CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (3600 - 300)
const MAX_CACHE_SIZE = 500;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

/** Clear the signed-URL cache. For use in tests only. */
export function _resetBatchSignCache(): void {
  _cache.clear();
  _lastOutcome.clear();
  cacheViewer = null;
}

/** Return the current number of cached entries. For use in tests only. */
export function _getCacheSize(): number {
  return _cache.size;
}

/**
 * Evict a single URL from the signed-URL cache.
 * Used by hydrateMediaUrls on re-hydration after a 403/onError so the next
 * batchSignUrls call for that URL fetches a fresh signed URL from the server.
 */
export function _evictBatchSignEntry(url: string): void {
  for (const key of _cache.keys()) if (key === url || key.startsWith(`${url}\0`)) _cache.delete(key);
  _lastOutcome.delete(url);
}

/**
 * Insert or refresh an entry in the LRU cache.
 * - If the key already exists, delete it first so the re-inserted entry
 *   moves to the tail (most-recently-used position).
 * - If inserting would exceed MAX_CACHE_SIZE, evict the oldest (head) entry.
 */
function _cacheSet(key: string, entry: CacheEntry): void {
  if (_cache.has(key)) {
    // Move to tail by deleting and re-inserting.
    _cache.delete(key);
  } else if (_cache.size >= MAX_CACHE_SIZE) {
    // Evict the least-recently-used (head) entry.
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) {
      _cache.delete(oldest);
    }
  }
  _cache.set(key, entry);
}

/**
 * Look up an entry and, on a valid hit, promote it to the tail (LRU refresh).
 * Returns the entry if present and not expired, otherwise undefined.
 */
function _cacheGet(key: string, now: number): CacheEntry | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (now >= entry.expiresAt) {
    // Lazily evict expired entry.
    _cache.delete(key);
    return undefined;
  }
  // Promote to tail (most-recently-used).
  _cache.delete(key);
  _cache.set(key, entry);
  return entry;
}

/**
 * Resolve a list of URLs through the batch-sign endpoint.
 *
 * - Cache hits: returned immediately, no network call.
 * - Cache misses: batched into ≤50-URL POST requests.
 * - Error/429: falls back to the original URL silently.
 * - No session: returns all originals (the caller renders its empty state).
 *
 * @param transform  Optional image-transform options forwarded to the server.
 *   When supplied, the server calls `createSignedUrl` with a `transform` block
 *   so the resulting `/render/image/sign/` URL is resized at delivery time.
 *   This is the only supported resize path for private-bucket media — appending
 *   query params to an already-signed URL has no effect.
 *   Cache keys include the transform dimensions so callers requesting the same
 *   URL at different sizes get separate cached entries.
 *
 * @returns Map from original URL → signed/relay URL (or original on fallback).
 */
export async function batchSignUrls(
  urls: string[],
  transform?: { width?: number; quality?: number },
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (urls.length === 0) return result; if (transform && urls.some(isVideoRef)) { const [videos, stills] = await Promise.all([batchSignUrls(urls.filter(isVideoRef)), batchSignUrls(urls.filter((u) => !isVideoRef(u)), transform)]); return new Map([...videos, ...stills]); } // Supabase's image transform answers 400 for a video: sign videos plainly

  const scope = currentDiscoveryScope();
  const cancellation = new AbortController();
  const unsubscribe = onDiscoveryScopeChange(() => cancellation.abort());
  const budget = requestDeadline(MEDIA_SIGN_TIMEOUT_MS, cancellation.signal);
  const fallback = () => new Map(urls.map(url => [url, url]));
  let requestViewer: string | null = null;
  const current = () => isCurrentDiscoveryScope(scope) && !cancellation.signal.aborted
    && (requestViewer === null || cacheViewer === requestViewer);
  try {
    const endpoint = signEndpoint();
    const token = await budget.wait(signToken);
    if (!current()) return fallback();
    const viewer = token ? viewerKeyForToken(token) : null;
    if (!token || (scope.viewer && viewer !== scope.viewer)) {
      for (const url of urls) noteSignOutcome(url, 'unavailable');
      return fallback();
    }
    if (cacheViewer !== viewer) { _resetBatchSignCache(); cacheViewer = viewer; }
    requestViewer = viewer;
    const now = Date.now();
    const transformSuffix = transform && (transform.width !== undefined || transform.quality !== undefined)
      ? `\x00w${transform.width ?? ''}q${transform.quality ?? ''}` : '';
    const toFetch: string[] = [];
    for (const url of [...new Set(urls)]) {
      const entry = _cacheGet(url + transformSuffix, now);
      if (entry) { result.set(url, entry.url); noteSignOutcome(url, 'signed'); }
      else toFetch.push(url);
    }
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      let failure: SignOutcome = 'unreachable';
      try {
        const response = await budget.wait(() => fetch(endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: budget.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ urls: batch, ...(transform ? { transform } : {}) }),
        }));
        if (!current()) return fallback();
        failure = 'unavailable';
        if (response.redirected || response.url && response.url !== endpoint) throw new Error('Media signing redirected');
        if (!response.ok) {
          failure = [401, 403, 404, 410].includes(response.status) ? 'denied'
            : response.status === 429 || response.status >= 500 ? 'unreachable' : 'unavailable';
          throw new Error('Media signing refused');
        }
        // JSON/body stalls are connectivity failures; a decoded malformed body
        // is not authorization to recover a previously saved private copy.
        failure = 'unreachable';
        const body: unknown = await budget.wait(() => response.json());
        if (!current()) return fallback();
        failure = 'unavailable';
        if (!body || typeof body !== 'object' || !('signed' in body) || !body.signed || typeof body.signed !== 'object' || Array.isArray(body.signed)) throw new Error('Malformed signing response');
        const payload = body as { signed: Record<string, unknown>; ttlSeconds?: unknown };
        const ttl = payload.ttlSeconds;
        // A short or zero TTL must NEVER fall back to 55 minutes. Keep a 10%
        // margin for short grants and the existing five-minute margin otherwise.
        const cacheTtlMs = typeof ttl === 'number' && Number.isFinite(ttl)
          ? Math.max(0, ttl - (ttl > SIGN_TTL_SAFETY_BUFFER_S ? SIGN_TTL_SAFETY_BUFFER_S : Math.max(0, ttl * 0.1))) * 1000
          : ttl === undefined ? FALLBACK_CACHE_TTL_MS : 0;
        for (const url of batch) {
          const signedUrl = payload.signed[url];
          if (typeof signedUrl === 'string' && signedUrl.length > 0) {
            noteSignOutcome(url, 'signed');
            if (cacheTtlMs > 0) _cacheSet(url + transformSuffix, { url: signedUrl, expiresAt: now + cacheTtlMs });
            result.set(url, signedUrl);
          } else {
            noteSignOutcome(url, signedUrl === null ? 'denied' : 'unavailable');
            result.set(url, url);
          }
        }
      } catch {
        if (!current()) return fallback();
        for (const url of batch) { result.set(url, url); noteSignOutcome(url, failure); }
      }
    }
    return current() ? result : fallback();
  } catch {
    if (current()) for (const url of urls) noteSignOutcome(url, 'unavailable');
    return fallback();
  } finally {
    budget.dispose(); unsubscribe();
  }
}

// ── Why the last sign attempt did not produce a URL (Media §39) ──────────────
//
// batchSignUrls hands back the ORIGINAL url both when the server refused it and
// when the server could not be reached, and every existing caller treats the two
// alike. The offline media cache must not: a copy cached on this device may be
// shown while the sign endpoint is UNREACHABLE, and must be deleted the moment
// the server DENIES it. This records which of the two the last attempt was.
// Appended at the tail so no line above moves.
type SignOutcome = 'signed' | 'denied' | 'unreachable' | 'unavailable';
const _lastOutcome = new Map<string, SignOutcome>();
const MAX_OUTCOMES = 2000;

function noteSignOutcome(url: string, outcome: SignOutcome): void {
  _lastOutcome.delete(url);
  if (_lastOutcome.size >= MAX_OUTCOMES) {
    const oldest = _lastOutcome.keys().next().value;
    if (oldest !== undefined) _lastOutcome.delete(oldest);
  }
  _lastOutcome.set(url, outcome);
}

/** The outcome of the last sign attempt for `url`, or null if it was never attempted (or was served from cache). */
export function lastSignOutcome(url: string): SignOutcome | null {
  return _lastOutcome.get(url) ?? null;
}
import { isVideoRef } from './media/videoPosterRef.ts';
