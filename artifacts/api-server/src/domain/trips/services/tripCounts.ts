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
 *
 * A FAILED READ IS NOT A COUNT OF ZERO.
 * =====================================
 * This number is rendered as the Passport "Trips" stat. Every read here used to
 * degrade to zero: `if (!memberships.error && ...)` skipped a failed membership
 * read and silently returned owned-trips-only, `if (tripsErr) return {count:0}`
 * finished the job, and PassportProjectionService adds `.catch(() => ({count:0}))`
 * on top. So a database hiccup told a user with nine trips that they had none —
 * on the surface whose entire purpose is to be a record of where they have been.
 *
 * `count` is now `null` when it could not be determined, and `unavailable` says
 * so. A caller that cannot render "unknown" should render nothing, not a zero.
 */
export async function countUserTrips(
  sc: any,
  userId: string,
): Promise<{ count: number | null; unavailable?: true; reason?: string }> {
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

  // Step 2: union + dedup. EITHER source failing makes the union incomplete,
  // and an incomplete union is an undercount presented as a count.
  if (memberships.error) {
    return { count: null, unavailable: true, reason: `trip_members unreadable: ${memberships.error.message}` };
  }
  if (ownerships.error) {
    return { count: null, unavailable: true, reason: `trips (owner) unreadable: ${ownerships.error.message}` };
  }
  if (!Array.isArray(memberships.data) || !Array.isArray(ownerships.data)) {
    return { count: null, unavailable: true, reason: "a trip source returned no array" };
  }

  const tripIds = new Set<string>();
  for (const r of memberships.data as any[]) if (r.trip_id) tripIds.add(r.trip_id as string);
  for (const r of ownerships.data as any[]) if (r.id) tripIds.add(r.id as string);

  // Genuinely zero: both reads succeeded and neither found anything.
  if (tripIds.size === 0) return { count: 0 };

  // Step 3: count only trips that still exist with a non-null status.
  const { count, error: tripsErr } = await sc
    .from("trips")
    .select("id", { count: "exact", head: true })
    .in("id", Array.from(tripIds))
    .not("status", "is", null);

  if (tripsErr) {
    return { count: null, unavailable: true, reason: `trips count failed: ${tripsErr.message}` };
  }
  if (count == null) {
    // The count head-request succeeded and returned no number. That is not a
    // zero either — it is a shape this code does not understand.
    return { count: null, unavailable: true, reason: "trips count returned null" };
  }

  return { count };
}
