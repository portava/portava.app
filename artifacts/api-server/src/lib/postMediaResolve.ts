/**
 * postMediaResolve — the single place that answers "what media does this post
 * have?", now that the answer lives in two stores with two different jobs.
 *
 * THE SPLIT, RULED 2026-08-12
 * ===========================
 *
 * `post_media` is CANONICAL FOR STORAGE-BACKED MEDIA. Every image or video that
 * lives in one of this app's own buckets has a `post_media` row, carrying the
 * per-item metadata the array column never could: bucket, path, dimensions,
 * mime type, moderation state, processing state, sort order.
 *
 * `posts.media_urls` is the documented home for EXTERNAL REFERENCES ONLY —
 * editorial posts that point at imagery hosted somewhere else. That is a
 * deliberate product decision, not leftover drift. Ten official Portava posts
 * reference external imagery, and those references have no meaningful
 * `storage_bucket` / `storage_path`; forcing them into `post_media` would mean
 * writing placeholder values into NOT NULL columns that `lib/mediaAccess` reads
 * when it authorizes a request. The array column keeps them instead, with its
 * role narrowed rather than its existence extended.
 *
 * The narrowed role is ENFORCED, not hoped for:
 * `scripts/checkMediaUrlsExternalOnly.ts` fails if any `media_urls` element is a
 * storage-backed shape, so a future write of a bucket path into the array goes
 * red rather than quietly re-creating the two-stores-for-one-thing problem.
 *
 * WHY A MERGE AND NOT A CUTOVER
 * =============================
 *
 * Callers need both stores because the two hold different things, and a post's
 * media is the union. The merge also makes this module correct BEFORE and AFTER
 * the backfill migration: pre-migration a storage-backed post has its URL in
 * `media_urls` and no row; post-migration it has a row and no array entry.
 * Either way the union is the same list, so the code can ship ahead of the
 * migration with no window in which media vanishes. That ordering is not
 * optional — doing it the other way round is what broke three public posts
 * earlier the same day.
 *
 * ORDER: storage-backed items first, by `sort_order`, then external references
 * in their stored array order. Several surfaces render only `[0]`, so the
 * ordering is load-bearing rather than cosmetic.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** A post row that carries at least an id and the external-reference array. */
export interface PostMediaSource {
  id: string;
  media_urls?: string[] | null;
}

/**
 * Fetch storage-backed media for many posts in ONE query.
 *
 * Returns a Map keyed by post id. A post with no storage-backed media is
 * absent from the map rather than present-and-empty, so callers can tell "no
 * rows" from "not looked up".
 *
 * Fail-soft: on a query error the map is empty and callers fall back to
 * `media_urls` alone. That degrades to the pre-2083 rendering rather than to a
 * blank feed, which is the better failure for a read path — and it is the
 * reason this returns a Map instead of throwing.
 */
export async function fetchPostMediaMap(
  sc: SupabaseClient,
  postIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(postIds.filter(Boolean))];
  if (ids.length === 0) return out;

  try {
    const { data, error } = await sc
      .from("post_media")
      .select("post_id, public_url, sort_order, processing_status, moderation_status")
      .in("post_id", ids)
      .order("sort_order", { ascending: true });
    if (error || !data) return out;

    for (const row of data as any[]) {
      // Only media that finished processing and was not refused is renderable.
      // `pending` moderation is NOT excluded: it is the default for every new
      // row and excluding it would hide media that has simply not been reviewed.
      if (row.processing_status && row.processing_status !== "ready") continue;
      if (row.moderation_status === "rejected" || row.moderation_status === "flagged") continue;
      const url = typeof row.public_url === "string" ? row.public_url.trim() : "";
      if (!url) continue;
      const list = out.get(row.post_id) ?? [];
      list.push(url);
      out.set(row.post_id, list);
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * The media list for one post: storage-backed first (already sorted), then
 * external references. Deduplicated, because during the transition a post can
 * legitimately hold the same object in both stores.
 */
export function mergePostMedia(
  post: PostMediaSource,
  storageBacked: Map<string, string[]>,
): string[] {
  const fromRows = storageBacked.get(post.id) ?? [];
  const external = Array.isArray(post.media_urls) ? post.media_urls : [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const u of [...fromRows, ...external]) {
    if (typeof u !== "string") continue;
    const v = u.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    merged.push(v);
  }
  return merged;
}

/**
 * Convenience for the common shape: resolve a whole page of posts at once.
 * One query for the page, then a pure merge per row.
 */
export async function resolveMediaForPosts<T extends PostMediaSource>(
  sc: SupabaseClient,
  posts: T[],
): Promise<Map<string, string[]>> {
  const storageBacked = await fetchPostMediaMap(sc, posts.map((p) => p.id));
  const out = new Map<string, string[]>();
  for (const p of posts) out.set(p.id, mergePostMedia(p, storageBacked));
  return out;
}
