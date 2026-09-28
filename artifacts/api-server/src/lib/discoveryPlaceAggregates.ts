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

export type VoteRatingAgg = { worthItCount: number; avgRating: number | null; reviewCount: number };

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
        .select("entity_id, vote")
        .eq("entity_type", entityType)
        .in("entity_id", entityIds),
      sc
        .from("reviews")
        .select("entity_id, rating")
        .eq("entity_type", "place")
        .in("entity_id", entityIds)
        .eq("state", "published"),
    ]);

    for (const row of (votesRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
      if (row.vote === "worth_it") result.get(id)!.worthItCount++;
    }

    const reviewsByEntity = new Map<string, number[]>();
    for (const row of (reviewsRes.data ?? []) as any[]) {
      const id = row.entity_id as string;
      if (!reviewsByEntity.has(id)) reviewsByEntity.set(id, []);
      if (row.rating != null) reviewsByEntity.get(id)!.push(parseFloat(String(row.rating)));
    }
    for (const [id, ratings] of reviewsByEntity) {
      if (!result.has(id)) result.set(id, { worthItCount: 0, avgRating: null, reviewCount: 0 });
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
