/**
 * mediaUrl — validates that a client-supplied media URL points at THIS app's
 * own Supabase Storage, and extracts its bucket + object path.
 *
 * Why: the events and messaging media endpoints accepted ANY `z.string().url()`
 * — an external-URL injection hole (hotlinking, trackers, other users' objects
 * by guessed URL, SSRF-on-render). Every client-passed media URL must resolve
 * to one of our allowed buckets or be rejected.
 */

const ALLOWED_BUCKETS = new Set(["post-media", "profile-media"]);

export interface AppStorageRef {
  bucket: string;
  path: string;
}

/**
 * Parse + validate an app-storage public URL.
 * Accepts `/storage/v1/object/public/<bucket>/<path>` and the image-transform
 * variant `/storage/v1/render/image/public/<bucket>/<path>`, on the configured
 * SUPABASE_URL origin only. Query strings (transform params) are ignored.
 * Returns null for anything else — callers must reject.
 */
export function appStorageUrlInfo(rawUrl: string): AppStorageRef | null {
  const base = process.env.SUPABASE_URL;
  if (!base || !rawUrl) return null;
  let url: URL, origin: string;
  try {
    url = new URL(rawUrl);
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;

  const m = url.pathname.match(/^\/storage\/v1\/(?:object|render\/image)\/public\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const bucket = decodeURIComponent(m[1]);
  const path = decodeURIComponent(m[2]);
  if (!ALLOWED_BUCKETS.has(bucket)) return null;
  if (!path || path.includes("..")) return null;
  return { bucket, path };
}
