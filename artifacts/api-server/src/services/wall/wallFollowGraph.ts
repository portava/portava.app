/** Shared, keyset-paged follow graph for the Wall feed and quick-media row. */
const FOLLOW_GRAPH_PAGE = 1000;
/**
 * The most follows one request reads. Past it the graph is served as far as it
 * was read and reported NOT known, so Following withholds `caughtUp` instead of
 * asserting it over follows nobody looked at. Five sequential keyset pages.
 */
export const FOLLOW_GRAPH_MAX_ROWS = 5000;

/**
 * Every `user_follows` row of `viewerId`, keyset-paged on `following_id` (the
 * second column of the table's primary key, so each page is an index range
 * scan and a concurrent insert cannot shift a later page the way an OFFSET
 * would). Same envelope as one supabase-js read:
 *   - `error` set and `data` null: the FIRST page failed — nothing is known;
 *   - `error` set and `data` an array: a later page failed, or the graph is
 *     larger than FOLLOW_GRAPH_MAX_ROWS — `data` is what WAS read;
 *   - `error` null: `data` is the whole graph.
 */
export async function readWholeFollowGraph(
  sc: any,
  viewerId: string,
): Promise<{ data: Array<{ following_id: string }> | null; error: unknown }> {
  const out: Array<{ following_id: string }> = [];
  let after: string | null = null;
  for (;;) {
    let q = sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .order("following_id", { ascending: true });
    if (after !== null) q = q.gt("following_id", after);
    const { data, error } = await q.limit(FOLLOW_GRAPH_PAGE);
    if (error) return { data: after === null ? null : out, error };
    const page = ((data as any[]) ?? []).filter((r) => r && r.following_id != null);
    for (const r of page) {
      if (out.length >= FOLLOW_GRAPH_MAX_ROWS) {
        return {
          data: out,
          error: {
            code: "wall_follow_graph_over_bound",
            message: `follow graph is larger than the ${FOLLOW_GRAPH_MAX_ROWS} follows one request reads`,
          },
        };
      }
      out.push({ following_id: String(r.following_id) });
    }
    // A short page is the end. A full one is not evidence of more — the next
    // (possibly empty) page answers that.
    if (page.length < FOLLOW_GRAPH_PAGE) return { data: out, error: null };
    after = String(page[page.length - 1].following_id);
  }
}
