/**
 * mediaFeedReads — the per-page reads routes/mediaFeed.ts attaches to Gems
 * items: the viewer's own state and the live save count. census-media §47.
 * (The Watch feed and the single item make the same reads inline, each bound
 * to its error, because their blocks are cited by line and stay line-neutral.)
 *
 * These were `try { const { data } = await … } catch { /* non-fatal *\/ }`
 * blocks, 22 of them in routes/mediaFeed.ts (the S2 sites baselined in
 * SILENT_SUPABASE_READS_BASELINE.json). supabase-js RESOLVES a failure, so the
 * catch never ran and `data ?? []` turned "could not read" into "nothing": the
 * viewer's save, stamp, follow and follow request read as false, and every count
 * read as 0. The counts were also made from one row per stamp or reaction — an
 * unbounded read PostgREST cuts at 1,000 rows — and the save and comment counts
 * were the cached columns, which POST /media/:id/save never maintained.
 *
 * Every field below is the measured value or `null`, and a `null` has its table
 * named in the request's FailedSources (`failedSources` on the response).
 * lib/feedReads.ts holds the read rules; this module only says which reads.
 */
import { FailedSources, viewerRowIds, exactCountsPerId, known } from "./feedReads.js";

/** One page of Gems items, read for one viewer. `null` = could not be read. */
export interface GemPageReads {
  /** Gems the viewer saved (hidden_gem_saves). */
  saved: Set<string> | null;
  /** Live saves per gem (hidden_gem_saves) — never the cached hidden_gems.save_count. */
  saveCounts: Map<string, number> | null;
  /** Submitters the viewer follows (user_follows). */
  following: Set<string> | null;
}

/** The Gems feed's per-page reads: the viewer's saves and follows, and the live save count per gem. */
export async function loadGemPageReads(
  sc: any,
  viewerId: string,
  gemIds: readonly string[],
  submitterIds: readonly string[],
  failed: FailedSources,
): Promise<GemPageReads> {
  const [saved, saveCounts, following] = await Promise.all([
    viewerRowIds(sc, "hidden_gem_saves", "gem_id", gemIds, (q) => q.eq("user_id", viewerId)),
    exactCountsPerId(sc, "hidden_gem_saves", "gem_id", gemIds),
    viewerRowIds(sc, "user_follows", "following_id", submitterIds, (q) => q.eq("follower_id", viewerId)),
  ]);
  return {
    saved: known(saved, failed, "hidden_gem_saves"),
    saveCounts: known(saveCounts, failed, "hidden_gem_saves"),
    following: known(following, failed, "user_follows"),
  };
}
