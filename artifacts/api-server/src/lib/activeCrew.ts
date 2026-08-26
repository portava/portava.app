/**
 * activeCrew — resolve the observer's ACTIVE Trip Crew server-side, so the
 * independent-group signal does not depend on the client volunteering its trip
 * context.
 *
 * WHY THIS EXISTS. The V1 group signal (lib/intelGroupKey) collapses a Trip Crew
 * to one independent group only if it learns the crew id. Left to the client, a
 * crew member who omits the trip context and answers "just me" is credited as an
 * independent solo group — so fifteen members of one organized crew could publish
 * as fifteen parties, the exact leak the privacy gate exists to stop. Resolving
 * the crew on the server closes that: a real active-crew membership OVERRIDES a
 * "just me" answer.
 *
 * WHAT "ACTIVE" MEANS, AND WHY NOT trips.status. A trip is active for grouping
 * when today falls within its [start_date, end_date] window. We deliberately do
 * NOT key on trips.status: the only existing "active trip" reader (dailyBrief)
 * filters status='in_progress', which is not even a member of the trip_status enum
 * (draft/planning/upcoming/active/completed/cancelled/archived), so that value is
 * an unreliable signal. Date windows are concrete and need no enum agreement.
 *
 * FAIL-SOFT. Any error, a missing client, or a trip with no date window yields
 * null — the caller then falls back to the client attestation. A null result can
 * only WEAKEN grouping (a crew member reads as solo), never fabricate a crew, so
 * failing soft here cannot manufacture a group.
 */

/** Membership roles that count as an accepted crew member (mirrors tripMembership). */
const ACCEPTED_ROLES = ["owner", "member"] as const;

/**
 * The observer's active Trip Crew id (a trip they own or are an accepted member
 * of, whose date window contains `now`), or null. When several qualify, the most
 * recently started wins — a single deterministic token per observation.
 */
export async function resolveActiveCrewId(sc: any, actorId: string, now: Date): Promise<string | null> {
  if (!sc || !actorId) return null;
  try {
    const today = now.toISOString().slice(0, 10); // UTC calendar day, YYYY-MM-DD

    // 1. An owned trip whose window contains today.
    const owned = await sc
      .from("trips")
      .select("id, start_date")
      .eq("owner_id", actorId)
      .lte("start_date", today)
      .gte("end_date", today)
      .order("start_date", { ascending: false })
      .limit(1);
    const ownedId = ((owned?.data as any[]) ?? [])[0]?.id;
    if (ownedId) return ownedId;

    // 2. An accepted-member trip whose window contains today.
    const memberships = await sc
      .from("trip_members")
      .select("trip_id")
      .eq("user_id", actorId)
      .in("role", ACCEPTED_ROLES as unknown as string[]);
    const tripIds = ((memberships?.data as any[]) ?? []).map((r) => r.trip_id).filter(Boolean);
    if (tripIds.length === 0) return null;

    const memberTrip = await sc
      .from("trips")
      .select("id, start_date")
      .in("id", tripIds)
      .lte("start_date", today)
      .gte("end_date", today)
      .order("start_date", { ascending: false })
      .limit(1);
    return ((memberTrip?.data as any[]) ?? [])[0]?.id ?? null;
  } catch {
    return null;
  }
}
