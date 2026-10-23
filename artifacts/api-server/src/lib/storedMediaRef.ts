/**
 * storedMediaRef — the ONE zod field for a picked photo or video that a client
 * hands back after uploading it.
 *
 * POST /media/upload (routes/posts.ts) answers `{ url: "post-media/<user>/<ts>.jpg" }`:
 * a bare storage ref, not a URL. The trip cover, event cover, Hidden Gem image
 * and passport-memory photo fields were each `z.string().url()`, which refuses
 * that shape, so a traveller who attached a photo to any of those saw the whole
 * create or edit fail with a 400 — the photo they had just uploaded was the
 * thing that sank it.
 *
 * Accepted:
 *   - an app storage ref this server minted, in either form appStorageUrlInfo
 *     understands (the bare `<bucket>/<path>` the upload returns, or our own
 *     public storage URL on the configured origin);
 *   - an https URL (the migration-era absolute form, e.g. a curated cover).
 *
 * Refused: every other string — a bare word, an http URL on a foreign host,
 * data:, blob:, javascript:, a bucket outside the media allow-list, a path with
 * `..`. This is NOT a widening to arbitrary strings: the bare-path branch is
 * exactly appStorageUrlInfo's, which events.ts already uses as its storage gate.
 */
import { z } from "zod";
import { appStorageUrlInfo } from "./mediaUrl.js";

export const STORED_MEDIA_REF_MESSAGE =
  "Must be an https URL or an uploaded app media path (upload it with /api/media/upload first)";

/** Whether `v` is a media reference a create/edit body may store. */
export function isStoredMediaRef(v: string): boolean {
  if (appStorageUrlInfo(v)) return true;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** The shared field. Chain `.nullable().optional()` at the use site as each schema did before. */
export const storedMediaRef = z.string().min(1).max(2048).refine(isStoredMediaRef, { message: STORED_MEDIA_REF_MESSAGE });
