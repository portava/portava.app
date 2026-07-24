/**
 * batchSignMedia — batch-sign helper for list screens.
 *
 * Calls POST /api/media/sign with up to 50 app-storage URLs per request,
 * caches results for 45 minutes, and silently falls back to the original URL
 * on any error (including 429). Cache hits are served without a network request.
 *
 * When the `media_private_buckets_enabled` flag is OFF the function returns
 * all original URLs immediately (zero network calls).
 *
 * Exports:
 *   batchSignUrls(urls)      — resolve signed/relay URLs for a list of sources
 *   _resetBatchSignCache()   — clear the cache (tests only)
 */

import { _resolveMediaFlag } from './mediaSource.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
const BATCH_SIZE = 50;
const CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

/** Clear the signed-URL cache. For use in tests only. */
export function _resetBatchSignCache(): void {
  _cache.clear();
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
    const entry = _cache.get(url);
    if (entry && now < entry.expiresAt) {
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
      const expiresAt = now + CACHE_TTL_MS;
      for (const url of batch) {
        const signedUrl = body.signed?.[url] ?? null;
        if (signedUrl) {
          _cache.set(url, { url: signedUrl, expiresAt });
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
