/**
 * mediaUrl — client-side signed-URL hydration layer (SEC-02 gate).
 *
 * Wraps batchSignUrls so that every rendering surface can resolve
 * `post-media` and `profile-media` URLs through the sign endpoint before
 * they are bound to an <Image source>.
 *
 * Both buckets are PRIVATE, so this is not an optimisation — it is the only
 * way media renders at all. Upload endpoints return a bare `<bucket>/<path>`
 * reference and older rows hold full public URLs into those same private
 * buckets; neither form loads in an <Image>. Both are accepted by the sign
 * endpoint (see api-server lib/mediaUrl.ts appStorageUrlInfo) and both come
 * back as self-authenticating signed URLs.
 *
 * A surface that binds a URL without going through here renders blank.
 *
 * Exports:
 *   PRIVATE_BUCKETS           — the two buckets going private
 *   hydrateMediaUrls(urls)    — async: resolve a list of URLs to signed
 *                               URLs (or null for server-rejected entries)
 *   useHydratedMedia(urls)    — React hook wrapping hydrateMediaUrls;
 *                               returns { resolved, loading }
 */

import { useState, useEffect, useMemo } from 'react';
import { batchSignUrls } from '../lib/batchSignMedia.ts';

/** The two Supabase storage buckets that are private. */
export const PRIVATE_BUCKETS: string[] = ['post-media', 'profile-media'];

// Matches: .../storage/v1/object/public/<bucket>/…
const STORAGE_PUBLIC_BUCKET_RE = /\/storage\/v1\/object\/public\/([^/?#]+)\//;

/**
 * Extract the storage bucket from a URL or bare storage path.
 *
 * Accepts two formats:
 *   1. Supabase public URL: `https://…/storage/v1/object/public/<bucket>/…`
 *   2. Bare storage path: `<bucket>/<path>` — returned by upload endpoints
 *      after the bucket-privacy migration (no URL scheme, bucket name first).
 *
 * Returns null for anything that doesn't match either format.
 */
function extractBucket(url: string): string | null {
  // Format 1: full Supabase public URL
  const m = STORAGE_PUBLIC_BUCKET_RE.exec(url);
  if (m) return m[1];
  // Format 2: bare storage path "bucket/path" — no scheme, no double-slash
  if (!url.startsWith('//') && !url.includes('://')) {
    const slash = url.indexOf('/');
    if (slash > 0) return url.slice(0, slash);
  }
  return null;
}

/**
 * Resolve a list of URLs through the signed-URL layer.
 *
 * - Private-bucket URLs (`post-media`, `profile-media`) are forwarded to
 *   `batchSignUrls`.  If the server returns `null` for a URL (unauthorized /
 *   unrecognised), the result entry is `null` — the caller must show the
 *   designed fallback.
 * - Non-private-bucket URLs and non-storage URLs are returned unchanged.
 *
 * @param transform  Optional image-transform options forwarded to the sign
 *   endpoint.  When supplied, the server generates a `/render/image/sign/` URL
 *   that Supabase resizes on the fly — the only supported resize path for
 *   private-bucket media.
 */
export async function hydrateMediaUrls(
  urls: string[],
  transform?: { width?: number; quality?: number },
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

  // Call batchSignUrls (handles chunking ≤50 per request + LRU cache).
  // batchSignUrls returns the original URL when the server returns null or on
  // error; compare to detect those cases and surface them as null to the caller.
  const signed = await batchSignUrls(privateBucketUrls, transform);
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
 *
 * @param transform  Optional image-transform options forwarded to the sign
 *   endpoint.  When supplied, the server generates a `/render/image/sign/` URL
 *   that Supabase resizes on the fly.  The transform is treated as stable for
 *   the lifetime of the hook instance — changes to `transform` do NOT trigger a
 *   re-fetch (use a new hook instance or a new component mount for that).
 */
export function useHydratedMedia(
  urls: (string | null | undefined)[],
  transform?: { width?: number; quality?: number },
): { resolved: Record<string, string | null>; loading: boolean } {
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);

  // Build a stable string key from the SORTED unique non-null URLs so the
  // effect only re-fires when the content changes, not on every render.
  const stableKey = useMemo(() => {
    const unique = [...new Set(urls.filter((u): u is string => !!u))].sort();
    return unique.join('\0');
  }, [urls]); // eslint-disable-line react-hooks/exhaustive-deps

  // Capture transform options at hook definition time.  They are expected to
  // be a stable literal (e.g. `{ width: 400, quality: 80 }`) at each call
  // site, so no useMemo is needed.
  const transformRef = useMemo(
    () => transform,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transform?.width, transform?.quality],
  );

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
    hydrateMediaUrls(unique, transformRef).then((result) => {
      if (!cancelled) {
        setResolved(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stableKey, transformRef]);

  return { resolved, loading };
}
