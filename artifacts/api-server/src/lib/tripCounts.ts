/**
 * countUserTrips — canonical "how many trips is this user part of" count.
 *
 * Must match the membership definition used by GET /api/trips/me (owner OR
 * any non-"invited" trip_members role), not just trips.owner_id. Counting
 * owner_id alone undercounts the "Trips" stat for anyone who joined a trip
 * as a member/co-traveler without owning it, producing a mismatch against
 * the Trips tab list.  Counting only trip_members alone undercounts for
 * owners who were created before the automatic trip_members owner-row
 * insertion was in place and therefore have no corresponding row.
 *
 * Strategy:
 *   1. Collect trip IDs from both sources in parallel:
 *      (a) trip_members where role != 'invited'
 *      (b) trips where owner_id = userId
 *   2. Union + dedup by trip ID.
 *   3. Count only trips that still exist with a non-null status — matching
 *      the .not("status", "is", null) filter in GET /api/trips/me.
 */
export async function countUserTrips(
  sc: any,
  userId: string,
): Promise<{ count: number }> {
  // Step 1: query both sources in parallel.
  const [memberships, ownerships] = await Promise.all([
    sc
      .from("trip_members")
      .select("trip_id")
      .eq("user_id", userId)
      .neq("role", "invited"),
    sc
      .from("trips")
      .select("id")
      .eq("owner_id", userId),
  ]);

  // Step 2: union + dedup.
  const tripIds = new Set<string>();
  if (!memberships.error && Array.isArray(memberships.data)) {
    for (const r of memberships.data as any[]) {
      if (r.trip_id) tripIds.add(r.trip_id as string);
    }
  }
  if (!ownerships.error && Array.isArray(ownerships.data)) {
    for (const r of ownerships.data as any[]) {
      if (r.id) tripIds.add(r.id as string);
    }
  }

  if (tripIds.size === 0) return { count: 0 };

  // Step 3: count only trips that still exist with a non-null status.
  const { count, error: tripsErr } = await sc
    .from("trips")
    .select("id", { count: "exact", head: true })
    .in("id", Array.from(tripIds))
    .not("status", "is", null);

  if (tripsErr) {
    return { count: 0 };
  }

  return { count: count ?? 0 };
}
