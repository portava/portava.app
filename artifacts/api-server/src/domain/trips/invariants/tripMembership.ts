/**
 * tripMembership — the questions the intel group signal needs to ask about a trip:
 * is this user an accepted member, and is the trip a SHARED crew (≥2 members)?
 *
 * A Portava "Trip Crew" is a trip plus its accepted members: the trip's owner
 * (trips.owner_id) and the trip_members rows whose role is 'owner' or 'member'
 * ('invited' is a pending invite, not a member) AND whose status says they are
 * still on the trip. This mirrors the access rule getMemberRole already
 * enforces in routes/tripCrewLocation.ts; it is a role+status check,
 * deliberately independent of the trips.status lifecycle (which is not a
 * reliable "is this trip active right now" signal today).
 *
 * STATUS IS HALF OF MEMBERSHIP, AND THIS FILE USED TO READ ONLY THE OTHER HALF.
 * trip_members.status is `text NOT NULL DEFAULT 'accepted' CHECK (status IN
 * ('invited','accepted','declined','removed','left'))` (migration 0078), and
 * the ROLE column does not change when someone leaves or is removed — the
 * kernel's REMOVE_PARTICIPANT records the role AT removal (migration 2450). So
 * `role IN ('owner','member')` alone cannot tell a member from an ex-member: a
 * row of {role:'member', status:'removed'} answered TRUE to every question
 * below, and a person removed from a trip went on minting that trip's crew
 * token — the merge this signal exists to control. The rule of record is
 * lib/http.ts requireTripMember's: coalesce(status,'accepted') = 'accepted'.
 *
 * WHY MEMBERSHIP IS NOT ENOUGH — the shared-crew check is load-bearing. A client
 * asserts "I am capturing as part of trip T" (its partyId). If T were a SOLO trip
 * (just its owner), honoring it would mint a distinct crew token per person, so 15
 * people each asserting their own solo trip would read as 15 independent groups —
 * a SPLIT, i.e. the exact leak the crew signal exists to prevent (NOT a harmless
 * merge). So a crew token is honored only for a trip with ≥2 accepted members;
 * a solo trip resolves to nothing and the observer falls back to their own solo
 * group. Fail-closed: any error or missing client returns false / 0 — which is
 * a DEFAULT and not a finding. readAcceptedTripMembership / readAcceptedCrewSize
 * / readSharedCrewMembership carry the distinction for callers that need it.
 */

/**
 * True when a trip_members row's status means the person is still ON the trip.
 * `null`/absent counts as accepted, for rows written before migration 0078 added
 * the column — the same back-compat requireTripMember applies.
 */
function isAcceptedStatus(row: any): boolean {
  const status = (row as any)?.status;
  return status == null || String(status) === "accepted";
}

/**
 * A membership answer that keeps DENY and UNKNOWN apart.
 *
 * `{ readable: true, member: false }` — the roster was read; this person is not
 * on the trip. `{ readable: false, member: false }` — nothing was read, and the
 * `false` is a fail-closed DEFAULT rather than a finding.
 */
export interface MembershipRead {
  readable: boolean;
  member: boolean;
}

/**
 * The discriminating read. `isAcceptedTripMember` is this function with the
 * distinction thrown away, and callers that must not throw the distinction away
 * call this one instead.
 *
 * WHY THIS EXISTS (census-trips §70.6, reported and left open there).
 * supabase-js RESOLVES on a database error, so `const { data } = await ...`
 * made a failed read byte-identical to "no rows" and the surrounding try/catch
 * never fired. The booleans below therefore answered `false` to two different
 * questions. That is safe for AUTHORIZATION — nothing is granted on an unread
 * roster, and that stays — but it is NOT safe for the thing this file is
 * actually used for. `isSharedCrewMember` gates whether a client's asserted
 * partyId is honoured as a CREW TOKEN, and its own header says what a wrong
 * `false` costs: "15 people each asserting their own solo trip would read as 15
 * independent groups — a SPLIT, i.e. the exact leak the crew signal exists to
 * prevent". An unreadable `trip_members` did precisely that to a real crew, and
 * silently, because the caller had no way to see the difference.
 */
export async function readAcceptedTripMembership(sc: any, tripId: string, userId: string): Promise<MembershipRead> {
  if (!sc || !tripId || !userId) return { readable: false, member: false };
  try {
    const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
    if (tripErr) return { readable: false, member: false };
    if ((trip as any)?.owner_id === userId) return { readable: true, member: true };

    const { data: member, error: memberErr } = await sc
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "member"])
      .maybeSingle();
    // Status compared in JS, not filtered in PostgREST: coalesce-on-a-nullable
    // column is awkward to express as a filter and easy to get subtly wrong,
    // and this read returns at most one row.
    if (memberErr) return { readable: false, member: false };
    return { readable: true, member: Boolean(member) && isAcceptedStatus(member) };
  } catch {
    return { readable: false, member: false };
  }
}

/**
 * True iff `userId` is the owner or an accepted member of `tripId`.
 *
 * WHY THIS ONE DOES NOT THROW, unlike its namesake in `lib/http.ts` (which
 * §29.6 made throw `TripAccessUnavailableError`). Its two callers —
 * `services/intel/IntelCaptureService.ts` and
 * `domain/telegraph/policies/requestOrigin.ts` — are outside this module's
 * lane and neither has a catch for it, so making this throw would turn a
 * degraded read into an unhandled rejection in two other subsystems. The
 * distinction is therefore OFFERED rather than forced:
 * `readAcceptedTripMembership` above carries it, this wrapper discards it, and
 * the discarding is now a decision a reader can see instead of an accident of
 * destructuring. Converting those two callers is the remaining work, and it is
 * recorded as such rather than done here.
 */
export async function isAcceptedTripMember(sc: any, tripId: string, userId: string): Promise<boolean> {
  return (await readAcceptedTripMembership(sc, tripId, userId)).member;
}

/**
 * The discriminating count. `readable: false` means the size is a fail-closed
 * ZERO, not a measurement — and a zero that is not a measurement must not be
 * compared against the >= 2 threshold as though it were one.
 *
 * The owner read and the members read are separate: an unreadable `trips` row
 * used to drop the OWNER from the set silently, so a two-person crew counted 1
 * and stopped being SHARED.
 */
export async function readAcceptedCrewSize(sc: any, tripId: string): Promise<{ readable: boolean; size: number }> {
  if (!sc || !tripId) return { readable: false, size: 0 };
  try {
    const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
    const { data: members, error: membersErr } = await sc
      .from("trip_members").select("user_id, status").eq("trip_id", tripId).in("role", ["owner", "member"]);
    if (tripErr || membersErr) return { readable: false, size: 0 };
    const set = new Set<string>();
    if ((trip as any)?.owner_id) set.add((trip as any).owner_id);
    // Without the status gate a trip whose second member had been REMOVED still
    // counted 2 and read as a SHARED crew, so the token kept being honored for
    // a crew that no longer exists.
    for (const m of ((members as any[]) ?? [])) if (m.user_id && isAcceptedStatus(m)) set.add(m.user_id);
    return { readable: true, size: set.size };
  } catch {
    return { readable: false, size: 0 };
  }
}

/** Count of DISTINCT accepted members (owner + role owner/member) on `tripId`. */
export async function acceptedCrewSize(sc: any, tripId: string): Promise<number> {
  return (await readAcceptedCrewSize(sc, tripId)).size;
}

/**
 * True iff `userId` is an accepted member of `tripId` AND `tripId` is a SHARED crew
 * (≥2 distinct accepted members). This is the gate for honoring a client-supplied
 * partyId as a crew token — it prevents a solo trip from minting a per-person crew
 * key that would split a crew (see the header note).
 */
export async function isSharedCrewMember(sc: any, tripId: string, userId: string): Promise<boolean> {
  return (await readSharedCrewMembership(sc, tripId, userId)).member;
}

/**
 * The discriminating form of `isSharedCrewMember`. `readable: false` says the
 * `false` is a default and not a finding — which is the answer the intel crew
 * signal needs, because an unreadable roster and a genuinely solo trip demand
 * opposite treatments: the solo trip SHOULD fall back to a per-person group,
 * and the unreadable crew should be RETRIED rather than split into one group
 * per member.
 */
export async function readSharedCrewMembership(sc: any, tripId: string, userId: string): Promise<MembershipRead> {
  const membership = await readAcceptedTripMembership(sc, tripId, userId);
  if (!membership.readable) return { readable: false, member: false };
  if (!membership.member) return { readable: true, member: false };
  const crew = await readAcceptedCrewSize(sc, tripId);
  if (!crew.readable) return { readable: false, member: false };
  return { readable: true, member: crew.size >= 2 };
}
