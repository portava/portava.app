/**
 * mediaPosterPath — where a video's poster frame lives, and what that means for
 * who may see it. Pure string policy with no imports, so lib/mediaAccess can use
 * it without pulling the upload pipeline (sharp, rate limits, flags) into the
 * authorization module's import graph.
 *
 * The poster for a `post_media` slot is ALWAYS `<storage_path>.poster.jpg`. The
 * server writes it (routes/postcardMediaTransport.ts; for a general-upload
 * video, routes/mediaVideoPoster.ts), the client never names it, and
 * `/complete` admits no other thumbnail path. That derivation is what
 * makes the authorization rule below safe: a poster is a frame of exactly one
 * video, so it is shown to exactly that video's audience — no wider, no
 * narrower — by authorizing the video it was cut from.
 */

export const POSTER_SUFFIX = ".poster.jpg";

/** `<uid>/<postId>/<mediaId>.<ext>` → `<uid>/<postId>/<mediaId>.<ext>.poster.jpg`. */
export function posterPathFor(storagePath: string): string {
  return `${storagePath}${POSTER_SUFFIX}`;
}

/**
 * Prefixes of `post-media` that an AUTHENTICATED CLIENT can write to directly
 * (the out-of-band `memories/{uid}` / `stories/{uid}` storage grant —
 * scripts/auditStagingBoundaryGrant.ts). An object there never went through
 * the server's EXIF strip, so nothing under them is ever treated as a poster.
 */
const CLIENT_WRITABLE_PREFIXES = ["memories/", "stories/"] as const;

/** Only a video has a poster. */
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;

/**
 * If `path` is a video's derived poster, the video's own storage path; else
 * null. Exactly one suffix, stripped once; a path that would reduce to nothing,
 * to a folder, to another poster or to anything but a video is not a poster —
 * and neither is anything under a client-writable prefix, because the server
 * did not write it.
 */
export function derivedPosterBase(path: string): string | null {
  if (typeof path !== "string" || !path.endsWith(POSTER_SUFFIX)) return null;
  const base = path.slice(0, -POSTER_SUFFIX.length);
  if (!base || base.endsWith("/") || base.endsWith(POSTER_SUFFIX)) return null;
  if (!VIDEO_EXT.test(base)) return null;
  if (CLIENT_WRITABLE_PREFIXES.some((p) => base.startsWith(p))) return null;
  return base;
}

/**
 * What `/complete` may store as a slot's thumbnail: nothing, or THIS slot's own
 * derived poster. Any other value — another user's object, another slot's
 * poster, the video itself — is refused: `thumbnail_url` is served to the
 * post's audience, and a client-chosen path there would publish whatever the
 * client pointed it at.
 */
export function admissiblePosterPath(
  storagePath: string,
  thumbnailPath: unknown,
): { ok: true; path: string | null } | { ok: false; message: string } {
  if (thumbnailPath === undefined || thumbnailPath === null || thumbnailPath === "") {
    return { ok: true, path: null };
  }
  if (typeof thumbnailPath === "string" && storagePath && thumbnailPath === posterPathFor(storagePath)) {
    return { ok: true, path: thumbnailPath };
  }
  return { ok: false, message: "thumbnailPath must be the poster uploaded for this media item." };
}
