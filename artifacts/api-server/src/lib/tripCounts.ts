/**
 * countUserTrips — canonical "how many trips is this user part of" count.
 *
 * Mirrors the membership definition used by GET /api/trips/me exactly:
 *   1. Collect trip IDs from trip_members where role != 'invited'.
 *   2. Fetch those trips, keeping only ones that exist with a non-null status.
 *
 * This ensures orphaned memberships (trip deleted) and trips with a null status
 * are excluded — matching what the Trips tab actually shows.
 */
export async function countUserTrips(
  sc: any,
  userId: string,
): Promise<{ count: number }> {
  // Step 1: find all trip IDs the user is a non-invited member of.
  const { data: memberRows, error: memErr } = await sc
    .from("trip_members")
    .select("trip_id")
    .eq("user_id", userId)
    .neq("role", "invited");

  if (memErr || !memberRows || memberRows.length === 0) {
    return { count: 0 };
  }

  const tripIds = (memberRows as any[]).map((r) => r.trip_id as string);

  // Step 2: count only trips that still exist and have a non-null status —
  // matching the .not("status", "is", null) filter in GET /api/trips/me.
  const { count, error: tripsErr } = await sc
    .from("trips")
    .select("id", { count: "exact", head: true })
    .in("id", tripIds)
    .not("status", "is", null);

  if (tripsErr) {
    return { count: 0 };
  }

  return { count: count ?? 0 };
}
