/**
 * "Save to a Memory" from one's OWN post — census-media MD385, lead ruling D-26j.
 *
 * Media spec §44 names the signal "Memory / Postcard created"; §31 names the
 * kind of Memory it can be ("Saved visual inspiration"). D-26j
 * (docs/ops/lead-rulings-20261007-media.md): "from their own media only. The
 * server checks that the person owns the source post." Someone else's photo in
 * your Memory needs consent, credit and deletion rules that do not exist.
 *
 * This module READS and decides; the one write is the route's
 * (`POST /memories/:id/items/from-post` in routes/memories.ts, the declared
 * writer of memory_items). It answers three questions, in order:
 *
 *   1. May the feature run at all? `memory_from_own_media_enabled` (3999,
 *      seeded FALSE) must be ON — off or absent is `disabled`, unreadable is
 *      `unavailable` (never read as on or off). Then the STORAGE: the column
 *      3999 adds is read by name (the schema-marker probe: a sentinel id that
 *      cannot match). Absent is `storage_absent` and the route refuses — it
 *      never writes an item without its source link, because an unlinked copy
 *      is exactly what the link exists to prevent: a photo whose origin and
 *      withdrawal the database cannot follow.
 *   2. Is the post the caller's own, live, with that media? A post that is not
 *      theirs, does not exist, is deleted or held answers the SAME `not_found`,
 *      so a post id cannot be probed for existence. The media is picked
 *      SERVER-SIDE by index from the post's own `media_urls`: the client never
 *      supplies a URL, so it cannot name an object the post does not carry.
 *   3. (The route) Is the Memory the caller's? The existing command path's
 *      owner check.
 *
 * 3999's trigger (`memory_items_source_post_guard`) re-asserts 2 and 3 in the
 * database for every writer.
 */
import { readFlagState, isMissingSchemaError } from "../../lib/capability/schemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID } from "../../lib/capability/schemaRequirement.js";

export const MEMORY_FROM_OWN_MEDIA_FLAG = "memory_from_own_media_enabled";
export const SOURCE_POST_COLUMN = "source_post_id";
/** The most media one post carries that this action will index into. */
export const MAX_POST_MEDIA_INDEX = 49;

export type FromOwnMediaRefusal = "disabled" | "unavailable" | "storage_absent" | "not_found" | "no_such_media";
export type FromOwnMediaResult<T> = { ok: true; value: T } | { ok: false; reason: FromOwnMediaRefusal; detail: string; /** no_such_media only: how many the post has (2026-10-25) */ mediaCount?: number };

const refuse = (reason: FromOwnMediaRefusal, detail: string) => ({ ok: false as const, reason, detail });

/** The flag, then the column 3999 adds. Never throws. */
export async function gateMemoryFromOwnMedia(sc: any): Promise<FromOwnMediaResult<true>> {
  const flag = await readFlagState(sc, MEMORY_FROM_OWN_MEDIA_FLAG);
  if (flag === "unreadable") return refuse("unavailable", `${MEMORY_FROM_OWN_MEDIA_FLAG} could not be read`);
  if (flag !== "on") return refuse("disabled", `${MEMORY_FROM_OWN_MEDIA_FLAG} is ${flag}`);
  try {
    const res = await sc.from("memory_items").select(SOURCE_POST_COLUMN).eq("id", SCHEMA_PROBE_SENTINEL_ID).maybeSingle();
    if (!res || !("error" in res)) return refuse("unavailable", "the memory_items.source_post_id probe answered nothing");
    if (res.error) {
      return isMissingSchemaError(res.error)
        ? refuse("storage_absent", "memory_items.source_post_id is absent: migration 3999 is not applied to this database")
        : refuse("unavailable", `memory_items.source_post_id probe failed: ${String(res.error.message ?? "read failed")}`);
    }
    return { ok: true, value: true };
  } catch (err) {
    return refuse("unavailable", `memory_items.source_post_id probe threw: ${String((err as Error)?.message ?? err)}`);
  }
}

export interface OwnPostMedia {
  postId: string;
  mediaUrl: string;
  /** memory_items.media_type is a MIME type; a post carries one media_type for all its media. */
  mediaType: string; /** 2026-10-25: how many media the post has, by the list this index was read from — the one count the client follows */ mediaCount?: number;
}

/** `posts.media_type` → the MIME-shaped value memory_items holds. */
export function memoryItemMediaTypeFor(postMediaType: unknown): string {
  return postMediaType === "video" ? "video/mp4" : "image/jpeg";
}

/**
 * The caller's own live post's media at `mediaIndex`. Anyone else's post, a
 * missing one and a deleted or held one are one answer: `not_found`.
 */
export async function resolveOwnPostMedia(
  sc: any,
  input: { viewerId: string; postId: string; mediaIndex: number },
): Promise<FromOwnMediaResult<OwnPostMedia>> {
  const { data, error } = await sc
    .from("posts")
    .select("id, author_id, status, deleted_at, media_urls, media_type")
    .eq("id", input.postId)
    .maybeSingle();
  if (error) return refuse("unavailable", `posts unreadable: ${String(error.message ?? "read failed")}`);
  const post = data as Record<string, unknown> | null;
  if (!post || post.author_id !== input.viewerId) return refuse("not_found", "no post of the caller's with that id");
  if (post.status !== "active" || post.deleted_at != null) return refuse("not_found", "the post is not live");
  const listed = await ownPostMediaList(sc, post); // 2026-10-24: post_media first (uploads live there since 2083 / 3924), then media_urls
  if (!listed.ok) return listed;
  const entry = listed.value[input.mediaIndex] ?? null;
  if (!entry) return { ...refuse("no_such_media", `the post carries no media at index ${input.mediaIndex}`), mediaCount: listed.value.length };
  return { ok: true, value: { postId: String(post.id), mediaUrl: entry.url, mediaType: entry.mediaType, mediaCount: listed.value.length } };
}

// ── 2026-10-24, video on every surface — appended at the TAIL so no cited line above moves ────────────────────────
// The reader used to index `posts.media_urls` only. 2083 made `post_media` the store for uploads, 3924 moved the
// last uploads out of `media_urls`, and #795's create path writes uploads as rows only — so "Save to a Memory"
// answered `no_such_media` for every upload post. The list is now the one the post's readers serve
// (routes/posts.ts filterPostMedia + #795's lib/media/storageBackedPostMedia.ts fallback):
//   1. the post has ANY post_media row → its rows that are `ready` and not `rejected`/`flagged`, in sort_order,
//      named by `public_url` (else `<storage_bucket>/<storage_path>`), then its EXTERNAL `media_urls` entries
//      (a storage key left in `media_urls` names an object a row already carries, and is not offered twice);
//   2. no row at all → `media_urls` exactly as before (#795's fallback: a post 3924 has not reached still works).
// A row a moderator rejected or flagged, or one still processing, is never offered — and 4000's guard refuses it
// in the database too. An unreadable post_media read refuses `unavailable`; it is never read as "no rows" (§47).

/** One media item of a post, as "Save to a Memory" indexes it. */
export interface OwnPostMediaEntry {
  url: string;
  /** The MIME-shaped value memory_items.media_type holds. */
  mediaType: string;
  source: "post_media" | "media_urls";
}

const MIME_KIND = /^(image|video)\//i;

/** The media "Save to a Memory" indexes for one post (the post row as resolveOwnPostMedia read it). Never throws. */
export async function ownPostMediaList(
  sc: any,
  post: Record<string, unknown>,
): Promise<FromOwnMediaResult<Array<OwnPostMediaEntry | null>>> {
  let rows: any[];
  try {
    const { data, error } = await sc
      .from("post_media")
      .select("media_type, mime_type, public_url, storage_bucket, storage_path, processing_status, moderation_status, sort_order")
      .eq("post_id", String(post.id));
    if (error || !Array.isArray(data)) return refuse("unavailable", `post_media unreadable: ${String(error?.message ?? "no rows array")}`);
    rows = data;
  } catch (err) {
    return refuse("unavailable", `post_media read threw: ${String((err as Error)?.message ?? err)}`);
  }
  const urls = Array.isArray(post.media_urls) ? (post.media_urls as unknown[]) : [];
  const fromUrl = (raw: unknown): OwnPostMediaEntry | null =>
    typeof raw === "string" && raw
      ? { url: raw, mediaType: memoryItemMediaTypeFor(mediaKindForPath(raw, post.media_type as string | null)), source: "media_urls" }
      : null;
  if (rows.length === 0) return { ok: true, value: urls.map(fromUrl) };
  const visible = rows
    .filter((r) => r?.processing_status === "ready" && r?.moderation_status !== "rejected" && r?.moderation_status !== "flagged")
    .sort((a, b) => (Number(a?.sort_order) || 0) - (Number(b?.sort_order) || 0))
    .map((r): OwnPostMediaEntry | null => {
      const url = typeof r.public_url === "string" && r.public_url
        ? r.public_url
        : typeof r.storage_path === "string" && r.storage_path ? `${r.storage_bucket ?? "post-media"}/${r.storage_path}` : "";
      if (!url) return null;
      const mime = typeof r.mime_type === "string" && MIME_KIND.test(r.mime_type) ? r.mime_type.toLowerCase() : memoryItemMediaTypeFor(r.media_type);
      return { url, mediaType: mime, source: "post_media" };
    })
    .filter((e): e is OwnPostMediaEntry => e !== null);
  const external = urls.filter((u) => typeof u === "string" && u && postMediaStorageRef(u).kind === "foreign").map(fromUrl);
  return { ok: true, value: [...visible, ...external] };
}

import { mediaKindForPath } from "../../lib/media/storageBackedPostMedia.js";
import { postMediaStorageRef } from "../../lib/media/postMediaModerationHold.js";

// ── 2026-10-25, PR #808 verdict finding 2 — appended at the TAIL so no cited line above moves ──────────────────────
// The client used to work out how many media a post has on its own (SaveOwnPostToMemorySheet ownPostMediaCount)
// and could count one more than ownPostMediaList (a public-bucket storage URL, or an unclean string, left in
// `media_urls`): the sheet then asked for an index this list does not have and the copy stopped part-way with a
// 400. The SERVER's count is now the one the client follows: every answer the route gives once it has read the
// caller's OWN live post — the item, "already there", the no-such-index refusal, a later failure — carries
// `mediaCount`, this list's length, and the client never asks past it. Nothing about anyone else's post is said:
// `not_found` (someone else's, missing, deleted or held) is sent before this is stamped, and carries no count.

/** Stamp `mediaCount` on every JSON object body this response sends from here on. */
export function stampPostMediaCount(res: { json: (body: unknown) => unknown }, mediaCount: number | undefined): void {
  if (typeof mediaCount !== "number" || !Number.isInteger(mediaCount) || mediaCount < 0) return;
  const send = res.json.bind(res);
  res.json = (body: unknown) => send(body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>), mediaCount } : body);
}
