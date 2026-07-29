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
  const { data, error } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", userId)
    .neq("role", "invited");
  if (error || !data) return { count: 0 };
  const uniqueTripIds = new Set((data as any[]).map((r) => r.trip_id as string));
  return { count: uniqueTripIds.size };
}
