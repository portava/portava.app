/**
 * postCounters — census-media §47: the cached counters on `posts`
 * (`save_count`, `comment_count`) are recounted after a write, and a recount
 * that could not be read is never stamped.
 *
 * Each write path used to run
 *
 *     const { count } = await sc.from(T).select(…, { count: "exact", head: true })…;
 *     await sc.from("posts").update({ X_count: count ?? 0 }).eq("id", postId);
 *     res.json({ …, XCount: count ?? 0 });
 *
 * supabase-js resolves `{ count: null, error }` on a failure, so an outage
 * stamped a measured 0 over the cached value and told the client 0 (the DV-83
 * verifiers' finding, census-discovery §118.13). The UPDATE's own result was
 * never looked at either, so a refused write left the cache stale in silence.
 *
 * Now: the count is EXACT (a HEAD count — Postgres counts, so PostgREST's
 * 1,000-row cap does not apply) or it is `null`; only a count that was read is
 * written; and the table that could not be read is named in the request's
 * `FailedSources`, which the response spreads as `failedSources`. A refused
 * cache write is logged at error level — the measured count is still the
 * honest answer to the client, so it is not a failed SOURCE of this response.
 */
import { FailedSources, exactCount, known, countRowsPerId, viewerRowIds, type FeedReadLog } from "./feedReads.js";

export type PostCounterKind = "save" | "comment";

interface CounterSpec {
  table: string;
  column: "save_count" | "comment_count";
  /** The rows that count. Comments are soft-deleted, so only live ones do. */
  scope: (q: any) => any;
}

const COUNTERS: Record<PostCounterKind, CounterSpec> = {
  save: { table: "post_saves", column: "save_count", scope: (q) => q },
  comment: { table: "posts_comments", column: "comment_count", scope: (q) => q.is("deleted_at", null) },
};

export type PostCounterLog = (FeedReadLog & { error?: (obj: unknown, msg?: string) => void }) | undefined;

/**
 * Recount one post's saves or comments exactly and, ONLY when the count was
 * read, write it into the cached column.
 *
 * Returns `count` — the measured number, or `null` when it could not be read —
 * and `failed`, which names the unread table (`post_saves` / `posts_comments`).
 */
export async function recountPostCounter(
  sc: any,
  postId: string,
  kind: PostCounterKind,
  log?: PostCounterLog,
): Promise<{ count: number | null; failed: FailedSources }> {
  const spec = COUNTERS[kind];
  const failed = new FailedSources(log, `post ${kind} recount`);
  const count = known(
    await exactCount(
      spec.scope(sc.from(spec.table).select("post_id", { count: "exact", head: true }).eq("post_id", postId)),
    ),
    failed,
    spec.table,
  );
  if (count !== null) {
    const { error } = await sc.from("posts").update({ [spec.column]: count }).eq("id", postId);
    if (error) {
      log?.error?.(
        { err: error, postId, column: spec.column, measured: count },
        `posts.${spec.column} write refused — the cached counter is stale; the measured count is still answered`,
      );
    }
  }
  return { count, failed };
}

/** What every post feed attaches to a post. `null` is "could not be read" — never 0 or false. */
export interface PostEngagement {
  /** Stamps on the post (content_stamps, entity_type 'post') — the unified like. */
  likeCount: number | null;
  stampCount: number | null;
  /** Live, non-deleted comments — never the cached comment_count. */
  commentCount: number | null;
  /** Live saves — never the cached save_count, which POST /media/:id/save never maintained. */
  saveCount: number | null;
  likedByMe: boolean | null;
  isStampedByViewer: boolean | null;
  savedByMe: boolean | null;
}

/** The engagement of a post no read answered for. */
export const UNKNOWN_POST_ENGAGEMENT: Readonly<PostEngagement> = Object.freeze({
  likeCount: null, stampCount: null, commentCount: null, saveCount: null,
  likedByMe: null, isStampedByViewer: null, savedByMe: null,
});

/**
 * The engagement for one page of posts: exact counts read whole (so a page
 * past PostgREST's row cap is not undercounted) and the viewer's own stamps and
 * saves. Every id gets an entry. A read that fails leaves its fields `null` on
 * every post and names its table in `failed`; the reads that worked still
 * answer.
 */
export async function loadPostEngagement(
  sc: any,
  postIds: readonly string[],
  viewerId: string,
  failed: FailedSources,
): Promise<Map<string, PostEngagement>> {
  const ids = [...new Set(postIds)];
  const out = new Map<string, PostEngagement>();
  if (ids.length === 0) return out;
  const [stamps, comments, saves, myStamps, mySaves] = await Promise.all([
    countRowsPerId(sc, "content_stamps", "entity_id", ids, (q) => q.eq("entity_type", "post")),
    countRowsPerId(sc, "posts_comments", "post_id", ids, (q) => q.is("deleted_at", null)),
    countRowsPerId(sc, "post_saves", "post_id", ids),
    viewerRowIds(sc, "content_stamps", "entity_id", ids, (q) => q.eq("user_id", viewerId).eq("entity_type", "post")),
    viewerRowIds(sc, "post_saves", "post_id", ids, (q) => q.eq("user_id", viewerId)),
  ]);
  const stampCounts = known(stamps, failed, "content_stamps");
  const commentCounts = known(comments, failed, "posts_comments");
  const saveCounts = known(saves, failed, "post_saves");
  const stampedByViewer = known(myStamps, failed, "content_stamps");
  const savedByViewer = known(mySaves, failed, "post_saves");
  for (const id of ids) {
    const stamp = stampCounts ? (stampCounts.get(id) ?? 0) : null;
    out.set(id, {
      likeCount: stamp,
      stampCount: stamp,
      commentCount: commentCounts ? (commentCounts.get(id) ?? 0) : null,
      saveCount: saveCounts ? (saveCounts.get(id) ?? 0) : null,
      likedByMe: stampedByViewer ? stampedByViewer.has(id) : null,
      isStampedByViewer: stampedByViewer ? stampedByViewer.has(id) : null,
      savedByMe: savedByViewer ? savedByViewer.has(id) : null,
    });
  }
  return out;
}
