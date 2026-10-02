/**
 * discoverySearchExposure — serve points 8 and 9 (GET /discovery/search and
 * GET /discovery/suggest) consume the served-recommendation contract
 * (lib/discoveryRecommendationRecord.ts; census-discovery DV-40).
 *
 * `04` §5: "Every served item must have a `recommendation_id`." Both routes mint
 * ONE exposure per request (`mintServeExposure`), stamp every served item with
 * it, and hand the same exposure's `sessionId` and `servedAt` to the serve log,
 * so the id a client holds is the id `rank_events` carries. Two clocks or two
 * session ids would mint two ids for one exposure (census-discovery §34.2).
 *
 * The list is stamped by the contract's own `stampServedRecommendations`; this
 * module adds only what the contract leaves to the caller for a GROUPED
 * response: suggest serves several lists in one body, and the serve log
 * flattens them in served order (the tail call in routes/discoverySearch.ts),
 * so each group is stamped with `offset` = the number of items served before
 * it. That is the position the log writes for it.
 *
 * Pure. Additive: one key per item, nothing removed, input not mutated, and an
 * empty list stays empty — stamping can never turn a refusal into items.
 */
import { stampServedRecommendations, type ServeExposure } from "./discoveryRecommendationRecord.js";

/** Stamp every item of every group, positioned as the serve log flattens them. */
export function stampSuggestGroupsServed<G extends { items: ReadonlyArray<{ id: string }> }>(
  groups: readonly G[],
  exposure: ServeExposure,
): Array<Omit<G, "items"> & { items: Array<G["items"][number] & { recommendationId: string }> }> {
  let offset = 0;
  return groups.map((g) => {
    const items = stampServedRecommendations(g.items, exposure, offset);
    offset += g.items.length;
    return { ...g, items };
  });
}
