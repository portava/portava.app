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
 * Parse + validate an app-storage URL or bare storage path.
 *
 * Accepts two formats:
 *   1. Full public URL: `/storage/v1/object/public/<bucket>/<path>` and the
 *      image-transform variant `/storage/v1/render/image/public/<bucket>/<path>`,
 *      on the configured SUPABASE_URL origin only. Query strings are ignored.
 *   2. Bare storage path: `<bucket>/<path>` (e.g. `post-media/generated-visuals/…`)
 *      — used by the AI visuals service which stores bare paths after upload.
 *
 * Returns null for anything else — callers must reject.
 */
export function appStorageUrlInfo(rawUrl: string): AppStorageRef | null {
  if (!rawUrl) return null;

  // ── Format 1: full Supabase public/render URL ────────────────────────────
  const base = process.env.SUPABASE_URL;
  if (base) {
    try {
      const url = new URL(rawUrl);
      const origin = new URL(base).origin;
      if (url.origin === origin) {
        const m = url.pathname.match(/^\/storage\/v1\/(?:object|render\/image)\/public\/([^/]+)\/(.+)$/);
        if (m) {
          const bucket = decodeURIComponent(m[1]);
          const path = decodeURIComponent(m[2]);
          if (ALLOWED_BUCKETS.has(bucket) && path && !path.includes("..")) {
            return { bucket, path };
          }
        }
        // Valid URL for our origin but no matching storage path → reject.
        return null;
      }
      // Valid URL but wrong origin → reject (foreign URL injection).
      return null;
    } catch {
      // Not a valid URL — fall through to bare-path parsing.
    }
  }

  // ── Format 2: bare storage path `<bucket>/<path>` ────────────────────────
  // e.g. "post-media/generated-visuals/event/uuid/uuid/hero.webp"
  // Reject anything that looks like an absolute or scheme-relative URL so we
  // never silently accept a non-storage string.
  if (rawUrl.startsWith("//") || rawUrl.includes("://")) return null;
  const slash = rawUrl.indexOf("/");
  if (slash < 1) return null;
  const bucket = rawUrl.slice(0, slash);
  const path = rawUrl.slice(slash + 1);
  if (!ALLOWED_BUCKETS.has(bucket)) return null;
  if (!path || path.includes("..")) return null;
  return { bucket, path };
}
