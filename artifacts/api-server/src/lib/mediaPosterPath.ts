/**
 * mediaPosterPath — where a video's poster frame lives, and what that means for
 * who may see it. Pure string policy with no imports, so lib/mediaAccess can use
 * it without pulling the upload pipeline (sharp, rate limits, flags) into the
 * authorization module's import graph.
 *
 * The poster for a `post_media` slot is ALWAYS `<storage_path>.poster.jpg`. The
 * server writes it (routes/postcardMediaTransport.ts), the client never names
 * it, and `/complete` admits no other thumbnail path. That derivation is what
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
 * If `path` is a slot's derived poster, the slot's own storage path; else null.
 * Exactly one suffix, stripped once; a path that would reduce to nothing, to a
 * folder, or to another poster is not a poster.
 */
export function derivedPosterBase(path: string): string | null {
  if (typeof path !== "string" || !path.endsWith(POSTER_SUFFIX)) return null;
  const base = path.slice(0, -POSTER_SUFFIX.length);
  if (!base || base.endsWith("/") || base.endsWith(POSTER_SUFFIX)) return null;
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
