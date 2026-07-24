/**
 * mediaSource — private-bucket URL rewriting and auth-bearing source resolver.
 *
 * When `media_private_buckets_enabled` is OFF (default today) every call returns
 * the original URL unchanged — zero overhead, pixel-identical to before.
 *
 * When the flag is ON, app-storage URLs are rewritten to the relay endpoint
 * (`/api/media/file/<bucket>/<path>`) and a Bearer token is attached.
 *
 * Exports:
 *   toAppMediaUrl(url)          — sync URL rewriter (non-matching URLs unchanged)
 *   mediaSource(url)            — async: returns { uri, headers? } for ExpoImage / Video
 *   _resolveMediaFlag(base, ts) — async flag resolver with 5-min module-level cache
 *   _resetMediaFlagCache()      — reset cache (tests only)
 *   _setTestTokenGetter(fn)     — inject a mock token getter (tests only)
 *   _resetTestTokenGetter()     — restore real token getter (tests only)
 */

// Read at call-time so test environments can override the env var
// without being blocked by module-level snapshot.
function getApiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Flag cache ────────────────────────────────────────────────────────────────

let _cachedEnabled: boolean | null = null;
let _cacheTs = 0;

/** Reset the module-level flag cache. For use in tests only. */
export function _resetMediaFlagCache(): void {
  _cachedEnabled = null;
  _cacheTs = 0;
}

/**
 * Fetch `media_private_buckets_enabled` from /api/feature-flags with a
 * 5-minute module-level cache. Fail-safe: returns false on any error.
 */
export async function _resolveMediaFlag(apiBase: string, nowMs = Date.now()): Promise<boolean> {
  if (_cachedEnabled !== null && nowMs - _cacheTs < CACHE_TTL_MS) {
    return _cachedEnabled;
  }
  try {
    const r = await fetch(`${apiBase}/api/feature-flags`);
    const body = (await r.json()) as { flags?: Record<string, boolean> };
    const val = body?.flags?.['media_private_buckets_enabled'] ?? false;
    _cachedEnabled = val;
    _cacheTs = nowMs;
    return val;
  } catch {
    return false; // fail-safe: treat as OFF
  }
}

// ── URL rewriter ──────────────────────────────────────────────────────────────

// Matches: .../storage/v1/object/public/<bucket>/<path>[?query]
const STORAGE_PUBLIC_RE = /\/storage\/v1\/object\/public\/([^/?#]+)\/([^?#]+)/;

/**
 * Rewrite a Supabase public-storage URL to the relay endpoint.
 * Non-matching URLs (CDN, Unsplash, already-signed, etc.) are returned unchanged.
 * Query params (Supabase transform params) are intentionally stripped — the
 * relay serves the raw file; transforms are not applied through this path.
 */
export function toAppMediaUrl(publicUrl: string): string {
  const m = STORAGE_PUBLIC_RE.exec(publicUrl);
  if (!m) return publicUrl;
  const bucket = m[1];
  const path = m[2];
  return `${getApiBase()}/api/media/file/${bucket}/${path}`;
}

// ── Token getter (test-injectable) ───────────────────────────────────────────

type TokenGetter = () => Promise<string | null>;
let _tokenGetter: TokenGetter | null = null;

/** Inject a mock token getter for tests (avoids pulling in react-native). */
export function _setTestTokenGetter(fn: TokenGetter): void {
  _tokenGetter = fn;
}

/** Restore the real token getter (call in afterEach). */
export function _resetTestTokenGetter(): void {
  _tokenGetter = null;
}

async function getToken(): Promise<string | null> {
  if (_tokenGetter) return _tokenGetter();
  // Lazy import avoids loading react-native in node:test environments
  const { freshToken } = await import('../services/apiToken.ts');
  return freshToken();
}

// ── Resolved source type ──────────────────────────────────────────────────────

export interface ResolvedMediaSource {
  uri: string;
  headers?: { Authorization: string };
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve a media URL for use as an image/video `source` prop.
 *
 * Flag OFF → `{ uri: url }` unchanged (fast path from cache after first load).
 * Flag ON  → `{ uri: rewritten, headers: { Authorization: 'Bearer <token>' } }`.
 *
 * Returns `{ uri: '' }` when publicUrl is null/undefined/empty.
 */
export async function mediaSource(publicUrl: string | null | undefined): Promise<ResolvedMediaSource> {
  if (!publicUrl) return { uri: '' };

  const flagOn = await _resolveMediaFlag(getApiBase());
  if (!flagOn) return { uri: publicUrl };

  const rewritten = toAppMediaUrl(publicUrl);
  // Only attach auth headers when the URL was actually rewritten to the relay
  // endpoint.  Non-app URLs (CDN, Unsplash, third-party hosts) are returned
  // unchanged and WITHOUT headers to prevent leaking the bearer token to
  // untrusted origins.
  if (rewritten === publicUrl) return { uri: publicUrl };

  const token = await getToken();
  return token
    ? { uri: rewritten, headers: { Authorization: `Bearer ${token}` } }
    : { uri: rewritten };
}
