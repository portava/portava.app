/**
 * storageBackedPostMedia — the ONE authority for a post's uploaded media when
 * the upload is named by `posts.media_urls` rather than by a `post_media` row.
 *
 * ── THE DEFECT (owner-reported 2026-10-24: "video media still not playing") ──
 * 2083 split the two stores: `post_media` is canonical for storage-backed media,
 * and `posts.media_urls` holds EXTERNAL references only
 * (scripts/checkMediaUrlsExternalOnly.ts). The create path never followed it:
 * `POST /posts` wrote an upload's bare key (`post-media/<uid>/<ts>.mov`) into
 * `media_urls` and created no row. Every post with uploaded media since
 * 2026-08-16 has no `post_media` row (4 of 4 in production, read 2026-10-24).
 * The read side builds `media` from rows only, so those posts arrived with
 * `media: []`; the client's detail screen chose its player from
 * `media[0].media_type`, fell through to the image branch, and handed a `.mov`
 * to an <Image>. No AVPlayer request was ever made.
 *
 * ── WHAT THIS MODULE DOES ───────────────────────────────────────────────────
 *   READ (part A). `mediaUrlsFallback` + `projectedMedia`: when a post has NO
 *   `post_media` row at all, its storage-backed `media_urls` entries are
 *   projected as media items, marked `id: null, source: "media_urls"`. A post
 *   with ANY row — ready or not, approved or rejected — is never synthesized
 *   for: a row moderated away must not come back through the array. An
 *   unreadable read is `null` (unknown), never `[]` (census-media §47).
 *   ISOLATION: an item exposes exactly the reference `media_urls` already
 *   exposes to the same viewer, from the same row, after the route's own
 *   visibility and Hidden-Gem gates. Nothing here reads another post.
 *
 *   WRITE (part B). `planPostMediaUploads` + `insertUploadRows`: the create
 *   path turns each storage-backed reference into a `post_media` row and keeps
 *   only external references in `media_urls`. Ownership follows 2098's
 *   `post_media_path_is_owned` pin, narrowed: the key's FIRST segment must be
 *   the author (client-writable `memories/` and `stories/` prefixes are not
 *   accepted), and a key in `post_media_moderation_ledger` is refused.
 *
 * Posters: a video's poster is `<path>.poster.jpg` (lib/mediaPosterPath), and
 * it is named only when the object EXISTS. A video with no poster, or whose
 * listing failed, gets `thumbnail_url: null` — never an invented path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { postMediaStorageRef } from "./postMediaModerationHold.js";
import { derivedPosterBase, posterPathFor } from "../mediaPosterPath.js";
import { videoObjectExists, type PosterBucketLike } from "../mediaVideoPoster.js";

/** The bucket uploads live in. A post never carries another bucket's object as media. */
export const POST_MEDIA_BUCKET = "post-media";

/** How a synthesized item says where it came from. */
export const MEDIA_URLS_SOURCE = "media_urls" as const;

/** At most this many poster listings per call; beyond it a video's poster is unknown (null). */
export const MAX_POSTER_LOOKUPS = 24;

/** A storage-backed `media_urls` entry, canonicalised. */
export interface StorageBackedRef {
  /** The entry exactly as stored. */
  ref: string;
  /** `post-media`. */
  bucket: string;
  /** The object key inside the bucket. */
  path: string;
  /** `<bucket>/<path>` — the form `post_media.public_url` carries. */
  bareKey: string;
  /** Position in `media_urls`, 0-based. */
  ord: number;
}

/** The storage-backed entries of a `media_urls` array, in order, deduplicated by object. */
export function storageBackedRefs(mediaUrls: readonly unknown[] | null | undefined): StorageBackedRef[] {
  const out: StorageBackedRef[] = [];
  const seen = new Set<string>();
  (Array.isArray(mediaUrls) ? mediaUrls : []).forEach((raw, ord) => {
    if (typeof raw !== "string") return;
    const r = postMediaStorageRef(raw);
    if (r.kind !== "object" || r.bucket !== POST_MEDIA_BUCKET || !r.path) return;
    const bareKey = `${r.bucket}/${r.path}`;
    if (seen.has(bareKey)) return;
    seen.add(bareKey);
    out.push({ ref: raw, bucket: r.bucket, path: r.path, bareKey, ord });
  });
  return out;
}

/**
 * Video by extension first, as 2083 derived it and as the client's
 * `lib/media/videoPosterRef.ts` reads a ref (mov, mp4, m4v, webm, qt; 2083 adds
 * 3gp). An extension that names neither kind falls back to the post's own
 * declared type (`posts.media_type` is a MIME such as `video/quicktime`;
 * `primary_media_type` is `video` / `image`).
 */
const VIDEO_EXT = /\.(mov|mp4|m4v|webm|qt|3gp)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i;
export function mediaKindForPath(
  path: string,
  postMediaType?: string | null,
  primaryMediaType?: string | null,
): "video" | "image" {
  const file = String(path ?? "").split(/[?#]/)[0] ?? "";
  if (VIDEO_EXT.test(file)) return "video";
  if (IMAGE_EXT.test(file)) return "image";
  if (typeof postMediaType === "string" && postMediaType.toLowerCase().startsWith("video")) return "video";
  if (primaryMediaType === "video") return "video";
  return "image";
}

/** The MIME a row records, from the extension (2083's table), else the post's declared MIME, else a generic one. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  gif: "image/gif", avif: "image/avif", mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", qt: "video/quicktime",
  webm: "video/webm", "3gp": "video/3gpp",
};
export function mimeTypeForPath(path: string, kind: "video" | "image", postMediaType?: string | null): string {
  const ext = (String(path ?? "").split(/[?#]/)[0] ?? "").split(".").pop()?.toLowerCase() ?? "";
  const byExt = MIME_BY_EXT[ext];
  if (byExt) return byExt;
  if (typeof postMediaType === "string" && postMediaType.toLowerCase().startsWith(`${kind}/`)) return postMediaType.toLowerCase();
  return kind === "video" ? "video/mp4" : "application/octet-stream";
}

/** The poster key a video at `path` would have, or null when it cannot have one (not a video, or a client-writable prefix). */
export function posterKeyFor(path: string): string | null {
  const poster = posterPathFor(path);
  return derivedPosterBase(poster) === path ? poster : null;
}

/** Answers "does this object exist?" for one key in the bucket. */
export type ObjectPresence = (path: string) => Promise<"present" | "absent" | "error">;

/** The production presence check: one storage listing of the key's folder, searched by file name. */
export function storagePresence(sc: SupabaseClient | any): ObjectPresence {
  return async (path) => {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return "error";
    const bucket = sc?.storage?.from?.(POST_MEDIA_BUCKET) as PosterBucketLike | undefined;
    if (!bucket || typeof bucket.list !== "function") return "error";
    return videoObjectExists(bucket, { folder: path.slice(0, slash), file: path.slice(slash + 1) });
  };
}

/** For each video key, its poster key when the poster is PRESENT. Absent, errored or over the cap: no entry. */
export async function presentPosters(presence: ObjectPresence, videoPaths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(videoPaths)].map((p) => [p, posterKeyFor(p)] as const).filter((x): x is readonly [string, string] => x[1] !== null).slice(0, MAX_POSTER_LOOKUPS);
  const answers = await Promise.all(wanted.map(async ([video, poster]) => {
    try { return [video, poster, await presence(poster)] as const; } catch { return [video, poster, "error" as const] as const; }
  }));
  for (const [video, poster, state] of answers) if (state === "present") out.set(video, poster);
  return out;
}

// ── Part A: the read projection ──────────────────────────────────────────────

/** A media item projected from `media_urls`. Same keys as routes/posts.ts filterPostMedia's, plus `source`. */
export interface SynthesizedMediaItem {
  id: null;
  source: typeof MEDIA_URLS_SOURCE;
  media_type: "video" | "image";
  url: string;
  feed_url: null;
  thumbnail_url: string | null;
  duration_seconds: null;
  width: null;
  height: null;
  sort_order: number;
  processing_status: "ready";
  stamp_overlay: null;
}

/** The fields of a post row this module reads. */
export interface PostMediaSourceRow {
  id?: unknown;
  media_urls?: unknown;
  media_type?: unknown;
  primary_media_type?: unknown;
}

/** Items for one post's storage-backed entries. Pure. */
export function synthesizeMediaItems(post: PostMediaSourceRow, posters: ReadonlyMap<string, string>): SynthesizedMediaItem[] {
  const refs = storageBackedRefs(post?.media_urls as unknown[]);
  return refs.map((r, i) => {
    const kind = mediaKindForPath(r.path, post?.media_type as string | null, post?.primary_media_type as string | null);
    const poster = kind === "video" ? posters.get(r.path) ?? null : null;
    return {
      id: null, source: MEDIA_URLS_SOURCE, media_type: kind, url: r.bareKey, feed_url: null,
      thumbnail_url: poster ? `${POST_MEDIA_BUCKET}/${poster}` : null,
      duration_seconds: null, width: null, height: null, sort_order: i, processing_status: "ready", stamp_overlay: null,
    };
  });
}

export interface MediaUrlsFallbackOptions {
  /** Test seam for the poster listing. */
  presence?: ObjectPresence;
}

/**
 * The fallback for a page of posts. Returns an entry ONLY for a post that
 * (1) has no row in `rowsByPost`, (2) carries a storage-backed `media_urls`
 * entry, and (3) has no `post_media` row at all, ready or not — read here, by
 * post id, unfiltered. Its value is the synthesized items, or null when that
 * existence read failed (unknown, census-media §47). A post with any row keeps
 * whatever the route shaped from its rows. When the route's own media read was
 * unreadable (`unread`), nothing is synthesized: the route already answers null.
 */
export async function mediaUrlsFallback(
  sc: SupabaseClient | any,
  posts: readonly PostMediaSourceRow[],
  rowsByPost: Readonly<Record<string, readonly unknown[] | undefined>>,
  unread: boolean,
  opts: MediaUrlsFallbackOptions = {},
): Promise<Map<string, SynthesizedMediaItem[] | null>> {
  const out = new Map<string, SynthesizedMediaItem[] | null>();
  if (unread || !Array.isArray(posts)) return out;
  const candidates = posts.filter((p) => typeof p?.id === "string" && (rowsByPost[p.id as string]?.length ?? 0) === 0 && storageBackedRefs(p.media_urls as unknown[]).length > 0);
  if (candidates.length === 0) return out;
  const ids = candidates.map((p) => p.id as string);
  let withRows: Set<string>;
  try {
    const { data, error } = await sc.from("post_media").select("post_id").in("post_id", ids);
    if (error || !Array.isArray(data)) { for (const id of ids) out.set(id, null); return out; }
    withRows = new Set((data as Array<{ post_id?: unknown }>).map((r) => String(r?.post_id ?? "")));
  } catch {
    for (const id of ids) out.set(id, null);
    return out;
  }
  const synth = candidates.filter((p) => !withRows.has(p.id as string));
  if (synth.length === 0) return out;
  const videoPaths = synth.flatMap((p) => storageBackedRefs(p.media_urls as unknown[])
    .filter((r) => mediaKindForPath(r.path, p.media_type as string | null, p.primary_media_type as string | null) === "video")
    .map((r) => r.path));
  const posters = videoPaths.length > 0 ? await presentPosters(opts.presence ?? storagePresence(sc), videoPaths) : new Map<string, string>();
  for (const p of synth) out.set(p.id as string, synthesizeMediaItems(p, posters));
  return out;
}

/** What a route serves as `media`: null stays null, a fallback entry wins over an empty shaping, rows win otherwise. */
export function projectedMedia<T>(
  postId: unknown,
  fallback: ReadonlyMap<string, SynthesizedMediaItem[] | null>,
  shaped: T[] | null,
): T[] | SynthesizedMediaItem[] | null {
  if (shaped === null) return null;
  const key = typeof postId === "string" ? postId : "";
  if (fallback.has(key)) return fallback.get(key) ?? null;
  return shaped;
}

// ── Part B: the create path ──────────────────────────────────────────────────

export interface PlannedUpload extends StorageBackedRef {
  kind: "video" | "image";
  mime: string;
}

export type UploadPlan =
  | { ok: true; external: string[]; uploads: PlannedUpload[] }
  | { ok: false; code: "invalid_payload" | "forbidden"; message: string };

export const UPLOAD_NOT_OWNED_MESSAGE = "You can only attach media you uploaded.";
export const UPLOAD_UNCLEAN_MESSAGE = "A media reference could not be read as one of your uploads.";

/**
 * Split a create payload's `mediaUrls` into the external references that stay in
 * `media_urls` and the uploads that become rows. Refuses, before anything is
 * written: a reference to our storage that cannot be canonicalised, an object in
 * any bucket but `post-media`, and a key whose first segment is not the author.
 */
export function planPostMediaUploads(
  mediaUrls: readonly unknown[] | null | undefined,
  authorId: string,
  postMediaType?: string | null,
): UploadPlan {
  const external: string[] = [];
  const uploads: PlannedUpload[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(mediaUrls) ? mediaUrls : [];
  for (let ord = 0; ord < list.length; ord++) {
    const raw = list[ord];
    if (typeof raw !== "string") continue;
    const r = postMediaStorageRef(raw);
    if (r.kind === "foreign") { external.push(raw); continue; }
    if (r.kind === "unclean") return { ok: false, code: "invalid_payload", message: UPLOAD_UNCLEAN_MESSAGE };
    if (r.bucket !== POST_MEDIA_BUCKET || !r.path) return { ok: false, code: "invalid_payload", message: UPLOAD_UNCLEAN_MESSAGE };
    if (!authorId || r.path.split("/")[0] !== authorId) return { ok: false, code: "forbidden", message: UPLOAD_NOT_OWNED_MESSAGE };
    const bareKey = `${r.bucket}/${r.path}`;
    if (seen.has(bareKey)) continue;
    seen.add(bareKey);
    const kind = mediaKindForPath(r.path, postMediaType);
    uploads.push({ ref: raw, bucket: r.bucket, path: r.path, bareKey, ord, kind, mime: mimeTypeForPath(r.path, kind, postMediaType) });
  }
  return { ok: true, external, uploads };
}

/**
 * The planned keys that carry a moderation verdict in `post_media_moderation_ledger`
 * (2098: a rejected or flagged key may never be attached again). Null when the
 * ledger could not be read — the caller refuses rather than guessing.
 */
export async function moderatedUploadKeys(sc: SupabaseClient | any, uploads: readonly PlannedUpload[]): Promise<Set<string> | null> {
  if (uploads.length === 0) return new Set();
  try {
    const { data, error } = await sc.from("post_media_moderation_ledger").select("storage_path").in("storage_path", uploads.map((u) => u.path));
    if (error || !Array.isArray(data)) return null;
    return new Set((data as Array<{ storage_path?: unknown }>).map((r) => String(r?.storage_path ?? "")));
  } catch {
    return null;
  }
}

/** The summary columns a post carries for its uploads (routes/postcards.ts refreshMediaCounts' rule: `pending` counts). */
export function uploadSummary(uploads: readonly PlannedUpload[]): { media_count: number; has_video: boolean; primary_media_type: string } | null {
  if (uploads.length === 0) return null;
  const hasVideo = uploads.some((u) => u.kind === "video");
  return { media_count: uploads.length, has_video: hasVideo, primary_media_type: hasVideo ? "video" : "image" };
}

/**
 * Insert one `post_media` row per upload, in one statement (all or none).
 * `processing_status` is `ready` because POST /api/media/upload verified,
 * processed and stored the bytes before returning the key; `moderation_status`
 * is `pending`, the value 2098 pins every insert to. A video's poster is
 * recorded only when it exists.
 */
export async function insertUploadRows(
  sc: SupabaseClient | any,
  postId: string,
  authorId: string,
  uploads: readonly PlannedUpload[],
  opts: { presence?: ObjectPresence; durationSeconds?: number | null } = {},
): Promise<{ ok: true; count: number } | { ok: false; error: unknown }> {
  if (uploads.length === 0) return { ok: true, count: 0 };
  let posters: Map<string, string>;
  try {
    const videos = uploads.filter((u) => u.kind === "video").map((u) => u.path);
    posters = videos.length > 0 ? await presentPosters(opts.presence ?? storagePresence(sc), videos) : new Map();
  } catch {
    posters = new Map();
  }
  const singleVideo = uploads.length === 1 && uploads[0]!.kind === "video";
  const rows = uploads.map((u, i) => {
    const poster = posters.get(u.path) ?? null;
    return {
      post_id: postId, user_id: authorId, media_type: u.kind, storage_bucket: u.bucket, storage_path: u.path,
      public_url: u.bareKey, mime_type: u.mime, processing_status: "ready", moderation_status: "pending", sort_order: i,
      thumbnail_storage_path: poster, thumbnail_url: poster ? `${POST_MEDIA_BUCKET}/${poster}` : null,
      duration_seconds: singleVideo && typeof opts.durationSeconds === "number" && Number.isFinite(opts.durationSeconds) ? opts.durationSeconds : null,
    };
  });
  try {
    const { error } = await sc.from("post_media").insert(rows);
    if (error) return { ok: false, error };
    return { ok: true, count: rows.length };
  } catch (error) {
    return { ok: false, error };
  }
}
