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
 * A "CREW" IS A SHARED PARTY (≥2 accepted members). A trip with only its owner is
 * NOT a crew — it is one person, indistinguishable from solo. This is load-bearing:
 * without it, a member of a real crew could split themselves off by ALSO owning any
 * overlapping trip (a personal decoy, or innocently a second trip), because a
 * solo-owned trip would resolve to a distinct crew key and fragment the crew — the
 * very "one crew reads as many parties" leak this module claims to close. So a
 * solo-owned trip resolves to null, and the observer falls back to their own solo
 * group; only a genuinely shared trip yields a crew token.
 *
 * WHAT "ACTIVE" MEANS, AND WHY NOT trips.status. A trip is active for grouping
 * when today falls within its [start_date, end_date] window. We do NOT key on
 * trips.status: the only existing "active trip" reader (dailyBrief) filters
 * status='in_progress', which is not even a member of the trip_status enum, so it
 * is an unreliable signal. The window is widened by ±1 day because a trip's LOCAL
 * calendar day can lead or lag UTC by up to a day; erring toward RESOLVING a crew
 * is fail-closed (it collapses groups), whereas missing one would SPLIT the crew —
 * the leak direction. (Per-trip-timezone precision is a later refinement.)
 *
 * FAIL-SOFT. Any error, a missing client, a trip with no date window, or a
 * non-shared trip yields null — the caller falls back to the client attestation.
 * A null result can only WEAKEN grouping (a crew member reads as solo), never
 * fabricate a crew, so failing soft here cannot manufacture a group.
 */

/** Membership roles that count as an accepted crew member (mirrors tripMembership). */
const ACCEPTED_ROLES = ["owner", "member"] as const;

/** A trip qualifies as a shared crew only with at least this many distinct members. */
const MIN_CREW_MEMBERS = 2;

/** Shift a YYYY-MM-DD day by whole days, UTC-based. `day` already came from a clock. */
function shiftDay(day: string, deltaDays: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return day;
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

interface TripRow { id: string; start_date: string | null; owner_id: string }

/**
 * The observer's active Trip Crew id (a SHARED trip — ≥2 accepted members — that
 * they own or are an accepted member of, whose ±1-day date window contains `now`),
 * or null. When several qualify, the most recently started wins — a single
 * deterministic token per observation.
 */
export async function resolveActiveCrewId(sc: any, actorId: string, now: Date): Promise<string | null> {
  if (!sc || !actorId) return null;
  try {
    const today = now.toISOString().slice(0, 10);
    const lo = shiftDay(today, -1); // timezone tolerance, fail-closed toward collapsing
    const hi = shiftDay(today, 1);
    const roles = ACCEPTED_ROLES as unknown as string[];

    // Candidate active trips the actor owns…
    const owned = await sc
      .from("trips").select("id, start_date, owner_id")
      .eq("owner_id", actorId).lte("start_date", hi).gte("end_date", lo);

    // …or is an accepted member of.
    const memberships = await sc
      .from("trip_members").select("trip_id").eq("user_id", actorId).in("role", roles);
    const memberTripIds = ((memberships?.data as any[]) ?? []).map((r) => r.trip_id).filter(Boolean);
    let memberTrips: TripRow[] = [];
    if (memberTripIds.length > 0) {
      const mt = await sc
        .from("trips").select("id, start_date, owner_id")
        .in("id", memberTripIds).lte("start_date", hi).gte("end_date", lo);
      memberTrips = ((mt?.data as any[]) ?? []) as TripRow[];
    }

    // Merge + dedupe, most-recently-started first (deterministic single token).
    const byId = new Map<string, TripRow>();
    for (const t of [...(((owned?.data as any[]) ?? []) as TripRow[]), ...memberTrips]) {
      if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
    }
    const candidates = [...byId.values()].sort((a, b) =>
      (b.start_date ?? "") < (a.start_date ?? "") ? -1 : (b.start_date ?? "") > (a.start_date ?? "") ? 1 : 0,
    );
    if (candidates.length === 0) return null;

    // Keep only SHARED crews: count distinct accepted members (owner + trip_members)
    // per candidate, and return the first with ≥2. A solo-owned trip → null.
    const ids = candidates.map((c) => c.id);
    const memberRows = await sc
      .from("trip_members").select("trip_id, user_id").in("trip_id", ids).in("role", roles);
    const membersByTrip = new Map<string, Set<string>>();
    for (const c of candidates) {
      const s = new Set<string>();
      if (c.owner_id) s.add(c.owner_id);
      membersByTrip.set(c.id, s);
    }
    for (const r of ((memberRows?.data as any[]) ?? [])) {
      const s = membersByTrip.get(r.trip_id);
      if (s && r.user_id) s.add(r.user_id);
    }
    for (const c of candidates) {
      if ((membersByTrip.get(c.id)?.size ?? 0) >= MIN_CREW_MEMBERS) return c.id;
    }
    return null;
  } catch {
    return null;
  }
}
