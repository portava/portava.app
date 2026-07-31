/**
 * countUserTrips — canonical "how many trips is this user part of" count.
 *
 * Must match the membership definition used by GET /api/trips/me (owner OR
 * any non-"invited" trip_members role), not just trips.owner_id. Counting
 * owner_id alone undercounts the "Trips" stat for anyone who joined a trip
 * as a member/co-traveler without owning it, producing a mismatch against
 * the Trips tab list.
 */
export async function countUserTrips(
  sc: any,
  userId: string,
): Promise<{ count: number }> {
  // Query both sources in parallel:
  //   (a) trip_members where role != 'invited' — non-owner members and co-travellers
  //   (b) trips where owner_id = userId — owners who may lack a trip_members row
  // Union + dedup by trip id to match /api/trips/me semantics exactly.
  const [memberships, ownerships] = await Promise.all([
    sc.from("trip_members").select("trip_id").eq("user_id", userId).neq("role", "invited"),
    sc.from("trips").select("id").eq("owner_id", userId),
  ]);
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
  return { count: tripIds.size };
}
