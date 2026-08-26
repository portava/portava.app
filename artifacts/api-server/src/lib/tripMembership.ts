/**
 * tripMembership — the one question the intel group signal needs to ask about a
 * trip: is this user an ACCEPTED member of it?
 *
 * A Portava "Trip Crew" is a trip plus its accepted members: the trip's owner
 * (trips.owner_id) and the trip_members rows whose role is 'owner' or 'member'
 * ('invited' is a pending invite, not a member). This mirrors the access rule
 * getMemberRole already enforces in routes/tripCrewLocation.ts; it is a role
 * check, deliberately independent of the trips.status lifecycle (which is not a
 * reliable "is this trip active right now" signal today).
 *
 * WHY IT IS A VALIDATION, NOT A LOOKUP: a client asserts "I am capturing as part
 * of trip T" (its partyId). Honoring an unshared/foreign token could only ever
 * MERGE observers into one group, which suppresses a label (fail-closed) — never
 * a leak. But we still verify membership so a client cannot attach a trip it is
 * not on, keeping the crew token meaningful. Fail-closed: any error or a missing
 * client returns false.
 */

/** True iff `userId` is the owner or an accepted member of `tripId`. */
export async function isAcceptedTripMember(sc: any, tripId: string, userId: string): Promise<boolean> {
  if (!sc || !tripId || !userId) return false;
  try {
    const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
    if ((trip as any)?.owner_id === userId) return true;

    const { data: member } = await sc
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "member"])
      .maybeSingle();
    return Boolean(member);
  } catch {
    return false;
  }
}
