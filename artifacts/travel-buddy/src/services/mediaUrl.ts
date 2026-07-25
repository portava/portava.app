/**
 * mediaUrl — client-side signed-URL hydration layer (SEC-02 gate).
 *
 * Wraps batchSignUrls so that every rendering surface can resolve
 * `post-media` and `profile-media` URLs through the sign endpoint before
 * they are bound to an <Image source>.  When the
 * `media_private_buckets_enabled` flag is OFF (today) every URL passes
 * through unchanged — zero network calls, zero visible change.
 *
 * Exports:
 *   PRIVATE_BUCKETS           — the two buckets going private
 *   hydrateMediaUrls(urls)    — async: resolve a list of URLs to signed
 *                               URLs (or null for server-rejected entries)
 *   useHydratedMedia(urls)    — React hook wrapping hydrateMediaUrls;
 *                               returns { resolved, loading }
 */

import { useState, useEffect, useMemo } from 'react';
import { batchSignUrls, _resolveMediaFlag } from '../lib/batchSignMedia.ts';

function getApiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** The two Supabase storage buckets that will be flipped to private. */
export const PRIVATE_BUCKETS: string[] = ['post-media', 'profile-media'];

// Matches: .../storage/v1/object/public/<bucket>/…
const STORAGE_PUBLIC_BUCKET_RE = /\/storage\/v1\/object\/public\/([^/?#]+)\//;

function extractBucket(url: string): string | null {
  const m = STORAGE_PUBLIC_BUCKET_RE.exec(url);
  return m ? m[1] : null;
}

/**
 * Resolve a list of URLs through the signed-URL layer.
 *
 * - Private-bucket URLs (`post-media`, `profile-media`) are forwarded to
 *   `batchSignUrls` when the `media_private_buckets_enabled` flag is ON.
 *   If the server returns `null` for a URL (unauthorized / unrecognised),
 *   the result entry is `null` — the caller must show the designed fallback.
 * - Non-private-bucket URLs and non-storage URLs are returned unchanged.
 * - Flag OFF: every URL is returned unchanged (no network calls).
 */
export async function hydrateMediaUrls(
  urls: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  if (urls.length === 0) return result;

  // Partition into private-bucket vs. pass-through
  const privateBucketUrls: string[] = [];
  for (const url of urls) {
    const bucket = extractBucket(url);
    if (bucket && PRIVATE_BUCKETS.includes(bucket)) {
      privateBucketUrls.push(url);
    } else {
      result[url] = url; // non-private-bucket or non-storage: pass through unchanged
    }
  }

  if (privateBucketUrls.length === 0) return result;

  // Short-circuit when the private-buckets flag is OFF — return originals.
  const flagOn = await _resolveMediaFlag(getApiBase());
  if (!flagOn) {
    for (const url of privateBucketUrls) {
      result[url] = url;
    }
    return result;
  }

  // Flag ON — call batchSignUrls (handles chunking ≤50 per request + LRU cache).
  // batchSignUrls returns the original URL when the server returns null or on
  // error; compare to detect those cases and surface them as null to the caller.
  const signed = await batchSignUrls(privateBucketUrls);
  for (const url of privateBucketUrls) {
    const signedUrl = signed.get(url);
    // signedUrl === url  →  server returned null or a network error occurred
    // signedUrl != url   →  a real signed URL was returned
    result[url] = signedUrl && signedUrl !== url ? signedUrl : null;
  }

  return result;
}

/**
 * React hook that resolves a URL list through the signed-URL layer.
 *
 * - Deduplicates the URL list.
 * - Re-fires only when the SET of non-null URLs changes (stable serialised key),
 *   not on every array identity change.
 * - Returns `{ resolved, loading }`:
 *     resolved  — Record<originalUrl, signedUrl | null>
 *     loading   — true while the first async call is in-flight
 */
export function useHydratedMedia(
  urls: (string | null | undefined)[],
): { resolved: Record<string, string | null>; loading: boolean } {
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);

  // Build a stable string key from the SORTED unique non-null URLs so the
  // effect only re-fires when the content changes, not on every render.
  const stableKey = useMemo(() => {
    const unique = [...new Set(urls.filter((u): u is string => !!u))].sort();
    return unique.join('\0');
  }, [urls]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Reconstruct the URL list from the stable key (avoids stale-closure issues).
    const unique = stableKey ? stableKey.split('\0') : [];
    if (unique.length === 0) {
      setResolved({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    hydrateMediaUrls(unique).then((result) => {
      if (!cancelled) {
        setResolved(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stableKey]);

  return { resolved, loading };
}
