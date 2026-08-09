/**
 * storagePath — resolve a stored media reference to a Supabase Storage object path.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deleting a media object requires the object's *path within its bucket*
 * (`avatars/<uid>/<file>.jpg`). What the database actually stores is not that
 * path, and not one single format either. As of 2026-08-09, `profiles`
 * (56 rows) holds THREE different shapes in `avatar_url` / `cover_photo_url`:
 *
 *   1. `https://<ref>.supabase.co/storage/v1/object/public/profile-media/avatars/…`
 *   2. `profile-media/avatars/<uid>/<file>.jpg`   ← bucket-qualified path
 *   3. `https://picsum.photos/…`, unsplash, dicebear — external, no object exists
 *
 * The delete paths previously handled only shape 1, by searching for the
 * literal `/object/public/<bucket>/` and slicing after it:
 *
 *     const idx = oldUrl.indexOf(marker);
 *     if (idx === -1) { }          // ← silently skipped, row nulled anyway
 *
 * Shape 2 is what the upload endpoints return TODAY —
 * `res.json({ url: `${AVATAR_BUCKET}/${path}` })` in routes/profile.ts — so the
 * format the app currently writes is precisely the one the delete could not
 * parse. Every such delete nulled the column and orphaned the object, with no
 * error and no log. Shape 3 is external: there is no object, and skipping is
 * correct rather than a failure. The old code could not tell those two apart.
 *
 * Note `profile-media` and `post-media` are PRIVATE buckets (`public = false`),
 * so shape 1 URLs do not even serve — but they are still valid object paths and
 * must still be deletable.
 *
 * CONTRACT
 * --------
 * Returns a discriminated result so the caller can distinguish "nothing to
 * delete" from "I could not work out what to delete". Those must never be
 * collapsed: the first is normal, the second means an orphan is about to be
 * created and the caller is expected to fail loudly rather than proceed.
 */

export type StorageRef =
  /** An object in `bucket`. Safe to pass to `.storage.from(bucket).remove()`. */
  | { kind: "path"; path: string }
  /** Not in our storage (external host, or a different bucket). Nothing to delete. */
  | { kind: "external" }
  /** Empty / absent reference. Nothing to delete. */
  | { kind: "none" }
  /** Looks like ours but no path could be derived — caller MUST NOT proceed silently. */
  | { kind: "unresolvable"; value: string };

/**
 * Resolve a stored reference to an object path inside `bucket`.
 *
 * Recognised, in order:
 *   - `<bucket>/<path>`                        → path
 *   - `…/object/public/<bucket>/<path>`        → path
 *   - `…/object/sign/<bucket>/<path>?token=…`  → path (query stripped)
 *   - `…/object/authenticated/<bucket>/<path>` → path
 *   - any other absolute URL not mentioning `<bucket>` → external
 *   - anything else                            → unresolvable
 */
export function resolveStoragePath(
  stored: string | null | undefined,
  bucket: string,
): StorageRef {
  if (stored == null) return { kind: "none" };
  const raw = stored.trim();
  if (raw === "") return { kind: "none" };

  // Bucket-qualified path — the shape the upload endpoints return today.
  if (raw.startsWith(`${bucket}/`)) {
    const path = raw.slice(bucket.length + 1);
    return path ? { kind: "path", path: stripQuery(path) } : { kind: "unresolvable", value: raw };
  }

  // Supabase Storage URL forms. `sign` carries a ?token= that is not part of
  // the object path, so the query string is always stripped.
  for (const marker of [
    `/object/public/${bucket}/`,
    `/object/sign/${bucket}/`,
    `/object/authenticated/${bucket}/`,
  ]) {
    const idx = raw.indexOf(marker);
    if (idx !== -1) {
      const path = stripQuery(raw.slice(idx + marker.length));
      return path ? { kind: "path", path } : { kind: "unresolvable", value: raw };
    }
  }

  // An absolute URL that never mentions this bucket is somebody else's host
  // (seed data, avatar generators, a CDN). No object of ours to remove.
  if (/^https?:\/\//i.test(raw) && !raw.includes(`/${bucket}/`)) {
    return { kind: "external" };
  }

  // Mentions the bucket, or is a bare relative string, but matched no known
  // shape. Deleting nothing here would orphan an object we do own.
  return { kind: "unresolvable", value: raw };
}

function stripQuery(p: string): string {
  const q = p.indexOf("?");
  return q === -1 ? p : p.slice(0, q);
}
