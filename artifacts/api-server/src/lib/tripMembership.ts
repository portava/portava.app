/**
 * tripMembership — the questions the intel group signal needs to ask about a trip:
 * is this user an accepted member, and is the trip a SHARED crew (≥2 members)?
 *
 * A Portava "Trip Crew" is a trip plus its accepted members: the trip's owner
 * (trips.owner_id) and the trip_members rows whose role is 'owner' or 'member'
 * ('invited' is a pending invite, not a member). This mirrors the access rule
 * getMemberRole already enforces in routes/tripCrewLocation.ts; it is a role
 * check, deliberately independent of the trips.status lifecycle (which is not a
 * reliable "is this trip active right now" signal today).
 *
 * WHY MEMBERSHIP IS NOT ENOUGH — the shared-crew check is load-bearing. A client
 * asserts "I am capturing as part of trip T" (its partyId). If T were a SOLO trip
 * (just its owner), honoring it would mint a distinct crew token per person, so 15
 * people each asserting their own solo trip would read as 15 independent groups —
 * a SPLIT, i.e. the exact leak the crew signal exists to prevent (NOT a harmless
 * merge). So a crew token is honored only for a trip with ≥2 accepted members;
 * a solo trip resolves to nothing and the observer falls back to their own solo
 * group. Fail-closed: any error or missing client returns false / 0.
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

/** Count of DISTINCT accepted members (owner + role owner/member) on `tripId`. */
export async function acceptedCrewSize(sc: any, tripId: string): Promise<number> {
  if (!sc || !tripId) return 0;
  try {
    const { data: trip } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
    const { data: members } = await sc
      .from("trip_members").select("user_id").eq("trip_id", tripId).in("role", ["owner", "member"]);
    const set = new Set<string>();
    if ((trip as any)?.owner_id) set.add((trip as any).owner_id);
    for (const m of ((members as any[]) ?? [])) if (m.user_id) set.add(m.user_id);
    return set.size;
  } catch {
    return 0;
  }
}

/**
 * True iff `userId` is an accepted member of `tripId` AND `tripId` is a SHARED crew
 * (≥2 distinct accepted members). This is the gate for honoring a client-supplied
 * partyId as a crew token — it prevents a solo trip from minting a per-person crew
 * key that would split a crew (see the header note).
 */
export async function isSharedCrewMember(sc: any, tripId: string, userId: string): Promise<boolean> {
  if (!(await isAcceptedTripMember(sc, tripId, userId))) return false;
  return (await acceptedCrewSize(sc, tripId)) >= 2;
}
