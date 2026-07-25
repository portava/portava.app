/**
 * batchSignMedia — batch-sign helper for list screens.
 *
 * Calls POST /api/media/sign with up to 50 app-storage URLs per request,
 * caches results for the server-issued TTL minus a 5-minute safety buffer
 * (55 minutes for the current 3600 s server TTL), and silently falls back to the original URL
 * on any error (including 429). Cache hits are served without a network request.
 *
 * When the `media_private_buckets_enabled` flag is OFF the function returns
 * all original URLs immediately (zero network calls).
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

import { _resolveMediaFlag } from './mediaSource.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
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
  _cache.delete(url);
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
 * - Flag OFF: returns all originals without any network call.
 *
 * @returns Map from original URL → signed/relay URL (or original on fallback).
 */
export async function batchSignUrls(urls: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (urls.length === 0) return result;

  const now = Date.now();

  // Short-circuit when the private-buckets flag is OFF — no signing needed.
  const flagOn = await _resolveMediaFlag(API_BASE, now);
  if (!flagOn) {
    for (const url of urls) result.set(url, url);
    return result;
  }

  // Partition: cached vs. needs fetch
  const toFetch: string[] = [];
  for (const url of urls) {
    const entry = _cacheGet(url, now);
    if (entry) {
      result.set(url, entry.url);
    } else {
      toFetch.push(url);
    }
  }

  if (toFetch.length === 0) return result;

  // Batch into ≤BATCH_SIZE chunks
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    try {
      const r = await fetch(`${API_BASE}/api/media/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: batch }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Server returns { signed: { [url]: string | null }, ttlSeconds: number }
      const body = (await r.json()) as {
        signed?: Record<string, string | null>;
        ttlSeconds?: number;
      };
      // Use the server-reported TTL minus the safety buffer so the cache evicts
      // entries before the actual signed URL expires, preventing mid-session 403s.
      const serverTtlS =
        typeof body.ttlSeconds === 'number' && body.ttlSeconds > SIGN_TTL_SAFETY_BUFFER_S
          ? body.ttlSeconds
          : undefined;
      const cacheTtlMs = serverTtlS !== undefined
        ? (serverTtlS - SIGN_TTL_SAFETY_BUFFER_S) * 1000
        : FALLBACK_CACHE_TTL_MS;
      const expiresAt = now + cacheTtlMs;
      for (const url of batch) {
        const signedUrl = body.signed?.[url] ?? null;
        if (signedUrl) {
          _cacheSet(url, { url: signedUrl, expiresAt });
          result.set(url, signedUrl);
        } else {
          // null = unauthorized or unrecognized — fall back to original per-URL
          result.set(url, url);
        }
      }
    } catch {
      // Silently fall back: pass through the original URLs for this batch.
      // On 429 the caller already has the cached value; new URLs fall back.
      for (const url of batch) {
        if (!result.has(url)) result.set(url, url);
      }
    }
  }

  return result;
}
