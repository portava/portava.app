/**
 * discoveryPlaceAggregates — the two per-row facts a served Discovery place
 * carries that §85's generated rows lacked (census-discovery §85 D-W10-R3-1's
 * "two stated differences"; §95, lane W11-X3; register D-W11X3-3):
 *
 *   distanceKm   great-circle kilometres from the request's reference point,
 *                rounded to one decimal — routes/discovery.ts `haversineKm`
 *                and its `Math.round(… * 10) / 10`, restated;
 *   worthItCount, avgRating, reviewCount
 *                routes/discovery.ts `batchFetchVoteAndRatingAggregates`,
 *                restated: worth-it votes from `place_votes`, and the count and
 *                one-decimal mean of PUBLISHED reviews from `reviews`.
 *
 * WHY A RESTATEMENT AND NOT AN IMPORT. Both are private to routes/discovery.ts,
 * which this lane does not own. src/test/discoveryCandidateRowParity.test.ts
 * pins each body here equal to the route's, token for token, so the two cannot
 * drift; routed hunk R-X3-2 (census §95) lets the route import these and drop
 * its copies.
 *
 * Failure behaviour is the route's: an unreadable aggregate read yields no
 * counts (the tile degrades), never an error and never a fabricated zero.
 */

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The route's `distanceKm` for a row, or null when either end is unknown. */
export function servedDistanceKm(
  center: { lat: number; lng: number } | null | undefined, lat: number | null, lng: number | null,
): number | null {
  if (!center || lat == null || lng == null) return null;
  return Math.round(haversineKm(center.lat, center.lng, lat, lng) * 10) / 10;
}

export type VoteRatingAgg = { worthItCount: number | null; avgRating: number | null; reviewCount: number | null };  // census-discovery §111 (D-W11X2-114): null = that field's read failed or was cut — never a 0

export async function batchFetchVoteAndRatingAggregates(
  sc: any,
  entityIds: string[],
  entityType: "place" | "gem",
): Promise<Map<string, VoteRatingAgg>> {
  const result = new Map<string, VoteRatingAgg>();
  if (!sc || entityIds.length === 0) return result;

  try {
    const [votesRes, reviewsRes] = await Promise.all([
      sc
        .from("place_votes")
        .select("entity_id, vote", { count: "exact" })  // census-discovery §110 (D-W11X2-103): the whole count, so a response cut at db-max-rows is known
        .eq("entity_type", entityType)
        .in("entity_id", entityIds),
      sc
        .from("reviews")
        .select("entity_id, rating", { count: "exact" })
        .eq("entity_type", "place")
        .in("entity_id", entityIds)
        .eq("state", "published"),
    ]);

    for (const row of (aggregateReadComplete(votesRes) ? votesRes.data ?? [] : []) as any[]) {  // §110: a cut or failed read states no count, never a low one
      const id = row.entity_id as string;
      if (!result.has(id)) result.set(id, emptyVoteRatingAgg(votesRes, reviewsRes));  // §111 (D-W11X2-114): each field starts from its OWN read
      if (row.vote === "worth_it") result.get(id)!.worthItCount = (result.get(id)!.worthItCount ?? 0) + 1;
    }

    const reviewsByEntity = new Map<string, number[]>();
    for (const row of (aggregateReadComplete(reviewsRes) ? reviewsRes.data ?? [] : []) as any[]) {
      const id = row.entity_id as string;
      if (!reviewsByEntity.has(id)) reviewsByEntity.set(id, []);
      if (row.rating != null) reviewsByEntity.get(id)!.push(parseFloat(String(row.rating)));
    }
    for (const [id, ratings] of reviewsByEntity) {
      if (!result.has(id)) result.set(id, emptyVoteRatingAgg(votesRes, reviewsRes));  // §111 (D-W11X2-114): each field starts from its OWN read
      const entry = result.get(id)!;
      entry.reviewCount = ratings.length;
      if (ratings.length > 0) {
        entry.avgRating =
          Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;
      }
    }
  } catch { /* non-fatal */ }

  return result;
}

// ── census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-103): a count is stated only over a complete read ──
// PostgREST cuts every response at db-max-rows (production 1000) with `error: null`. A votes or reviews
// read that came back short of its exact count — or failed — states no count from it (no badge, as for
// a place with none), never a low one presented as the count.

/** True when the read succeeded and returned every row its exact count says exists (no count: taken as complete). */
export function aggregateReadComplete(res: { data?: unknown; error?: unknown; count?: number | null }): boolean {
  if (res.error) return false;
  const rows = Array.isArray(res.data) ? res.data.length : 0;
  return typeof res.count !== "number" || res.count <= rows;
}

// ── census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-114): each count comes from its own read ──
// The entry a place gets is created by whichever loop meets it first, and it was created as
// `{ worthItCount: 0, avgRating: null, reviewCount: 0 }` — so when the votes read succeeded and the reviews
// read failed (or the reverse), the failed read's count was served as 0 beside the other's real one. A field
// now starts at 0 only when its own read was complete (0 is then a fact), and null otherwise.
export function emptyVoteRatingAgg(
  votesRes: { data?: unknown; error?: unknown; count?: number | null },
  reviewsRes: { data?: unknown; error?: unknown; count?: number | null },
): VoteRatingAgg {
  return {
    worthItCount: aggregateReadComplete(votesRes) ? 0 : null,
    avgRating: null,
    reviewCount: aggregateReadComplete(reviewsRes) ? 0 : null,
  };
}
