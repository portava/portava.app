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
export type FromOwnMediaResult<T> = { ok: true; value: T } | { ok: false; reason: FromOwnMediaRefusal; detail: string };

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
  mediaType: string;
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
  const media = Array.isArray(post.media_urls) ? (post.media_urls as unknown[]) : [];
  const url = media[input.mediaIndex];
  if (typeof url !== "string" || !url) return refuse("no_such_media", `the post carries no media at index ${input.mediaIndex}`);
  return { ok: true, value: { postId: String(post.id), mediaUrl: url, mediaType: memoryItemMediaTypeFor(post.media_type) } };
}
