/**
 * discoveryDismissed — "Not interested", made to mean something.
 *
 * WHAT THIS CLOSES
 * ================
 * `rank_events.outcome` has admitted `'dismiss'` since migration 2297, and
 * `POST /api/rank-events/outcome` has accepted it against `surface: 'discovery'`
 * since the same change. census-discovery §12.6 measured the consequence
 * precisely:
 *
 *   "the writer exists and is unexercised, which is a different sentence with a
 *    different owner (the client)"
 *
 * It was worse than unexercised. Nothing READ the rows either. Had a client
 * sent a dismiss, the row would have landed in `rank_events`, moved
 * `content_distribution_stats.negative_signal_count` — a global, cross-viewer
 * ranking statistic — and changed NOTHING about what the person who sent it was
 * shown next. The one thing "Not interested" plainly promises is the one thing
 * it did not do.
 *
 * So this module is the reader, and `routes/discovery.ts` applies it on every
 * serve path. A dismissal now removes the place from that viewer's Discovery
 * results, which is what the control says it does.
 *
 * A FILTER, NOT A PENALTY — AND WHY THAT IS THE OPPOSITE CHOICE FROM `seenIds`
 * ===========================================================================
 * `lib/discoveryPde.ts` reads recent impressions into a seen set and feeds it to
 * `portavaRank` as a NEGATIVE WEIGHT, and says why in its own comment: "a viewer
 * who has seen everything in a small city still gets a full page, reordered".
 * That is right for "you have seen this", which is an inference the system made.
 *
 * It is wrong for "I do not want this", which is an instruction the person gave.
 * Re-ranking an explicit rejection means the place comes back, lower down, and
 * the person gets to reject it again — a control that visibly does not work is
 * worse than no control, because it also teaches them the app ignores them. So
 * a dismissal REMOVES, and the cost of that choice is stated below rather than
 * hidden.
 *
 * WHAT THIS COSTS, SAID OUT LOUD
 * ------------------------------
 * A viewer who dismisses a lot in a thin city shrinks their own results and
 * there is no in-product way to undo one. That is a real cost and it is the
 * correct one to pay for honouring an explicit instruction, but it is a cost,
 * and `docs/BUILD-BACKLOG.md` carries the missing undo as an owner-facing item
 * rather than leaving it implied. `DISMISSED_MAX_IDS` bounds the blast radius of
 * the read, not of the behaviour.
 *
 * NO WINDOW, ON PURPOSE. The seen set expires after 24 hours because "recently
 * shown" is a statement about recency. "Not interested" is not: nobody means it
 * for a day. An expiring dismissal would quietly resurrect every rejected place
 * on a schedule the person was never told about.
 *
 * FAILURE IS REPORTED, NEVER GUESSED
 * ==================================
 * The read can fail. Both available answers are bad in different directions:
 *
 *   fail OPEN  — serve the feed unfiltered. The person sees places they told us
 *                to remove, with no indication that anything went wrong.
 *   fail CLOSED — refuse the whole feed over a ranking-preference read. An
 *                empty Discovery tab because a suppression list was unreadable
 *                is a much larger failure than the one it is avoiding.
 *
 * So this reports instead of choosing silently: `degraded` is returned, the
 * route folds it into `failedSources`, and the response carries
 * `coverage: "partial"` — the vocabulary this surface already uses for "part of
 * this answer is not what it should be". The feed is served, and the fact that
 * it may contain dismissed places is ON the response rather than inferred from
 * its absence.
 *
 * PRIVACY. Strictly viewer-scoped: `user_id` is the authenticated viewer's and
 * nothing widens it. One person's dismissals never affect another person's
 * results, and this module never reads a row it did not key to the caller. The
 * cross-viewer effect of a dismiss — `negative_signal_count` — is migration
 * 2297's RPC and is deliberately not touched here.
 */

/** The `discovery` surface's dismissals, keyed to one viewer. */
export interface DismissedSet {
  /** `rank_events.item_id`s this viewer dismissed on the discovery surface. */
  ids: Set<string>;
  /**
   * TRUE when the read did not complete, so `ids` is NOT the viewer's full
   * dismissal list and a filter built from it will under-remove. Callers report
   * this; they must not silently treat it as "no dismissals".
   */
  degraded: boolean;
}

/**
 * Cap on the set. A dismissal list is small in practice — it takes a deliberate
 * tap per entry — so this is a bound on pathological growth rather than a
 * working limit, and it is ordered most-recent-first so the entries that survive
 * the cap are the ones the person chose most recently.
 */
export const DISMISSED_MAX_IDS = 1_000;

/** The surface these dismissals were recorded against. */
export const DISMISSED_SURFACE = "discovery";

/** The `rank_events.outcome` token migration 2297 admitted. */
export const DISMISSED_OUTCOME = "dismiss";

/**
 * Read one viewer's dismissed discovery items.
 *
 * Returns an EMPTY, non-degraded set for an anonymous caller: there is no viewer
 * to have dismissed anything, and that is a complete answer rather than a failed
 * one.
 *
 * A MISSING CLIENT IS THE OPPOSITE ANSWER, and the two were the same expression
 * (`if (!sc || !userId)`) until V4's sweep. Anonymity means there was nothing to
 * read. No client means there is a viewer, they may well have dismissals, and we
 * cannot see them — which is the degraded case this module exists to name. Left
 * merged, a deployment whose `getServiceClient()` is null served every Discovery
 * page unfiltered under `coverage: "full"`: the rejected place comes back and
 * the envelope states positively that nothing went wrong.
 */
export async function loadDismissedPlaceIds(
  sc: any,
  userId: string | null | undefined,
): Promise<DismissedSet> {
  const ids = new Set<string>();
  // No viewer: complete. No client: unreadable. See the note above.
  if (!userId) return { ids, degraded: false };
  if (!sc) return { ids, degraded: true };

  try {
    const { data, error } = await sc
      .from("rank_events")
      .select("item_id")
      .eq("user_id", userId)
      .eq("surface", DISMISSED_SURFACE)
      .eq("outcome", DISMISSED_OUTCOME)
      .order("served_at", { ascending: false })
      .limit(DISMISSED_MAX_IDS);

    // supabase-js RESOLVES on a DB error, so `error` set with `data` null is how
    // an unreadable table arrives — it does not throw. Binding it is the whole
    // difference between "this viewer has dismissed nothing" and "we could not
    // find out", which are the two facts this surface has a long history of
    // serving as one.
    if (error) return { ids, degraded: true };
    if (!Array.isArray(data)) return { ids, degraded: true };

    for (const row of data as Array<{ item_id?: unknown }>) {
      if (typeof row?.item_id === "string" && row.item_id !== "") ids.add(row.item_id);
    }
    return { ids, degraded: false };
  } catch {
    return { ids, degraded: true };
  }
}

/**
 * Remove dismissed items from a page of places.
 *
 * Pure and total: with an empty set it returns the SAME ARRAY REFERENCE, so a
 * viewer who has dismissed nothing — which is almost everyone, almost always —
 * pays no allocation and no reordering. Order is never touched, so this cannot
 * disturb the ranking that produced the list.
 */
export function withoutDismissed<T extends { id: string }>(
  places: T[],
  dismissed: ReadonlySet<string>,
): T[] {
  if (dismissed.size === 0 || places.length === 0) return places;
  return places.filter((p) => !dismissed.has(p.id));
}
