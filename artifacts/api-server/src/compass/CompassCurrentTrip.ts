/**
 * CompassCurrentTrip — the ONE place Compass decides "which trip is this user on".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Trips `:25` (census-compass `CT-02`) requires Compass to consume typed Trip
 * projections *rather than duplicating Trip semantics*. The plan-item half of
 * that is done — `toolGetCurrentTrip` reads the plan from
 * `TripCompassProjection` through the §19.1 consumer rule. The half nobody had
 * touched is SELECTION: "which trip is current" was re-derived, from raw
 * `trip_members` + `trips` reads, in five Compass modules with three different
 * rules:
 *
 *   CompassTools.toolGetCurrentTrip   owner ∪ accepted member · active|upcoming|planning
 *   CompassTripContext                owner ∪ accepted member · active|upcoming|planning|draft
 *   CompassSenseEngine.fetchActiveTrip  owner ∪ member(any status) · then status = active
 *   CompassLiveEngine                 the same shape again
 *   CompassFallbackFeedBuilder        the same shape again
 *
 * Three rules is not a refactoring nicety: it means two Compass surfaces can
 * answer about DIFFERENT trips in the same minute, and the assistant has no way
 * to know which one the user meant.
 *
 * THE DIVERGENCE IS PRESERVED, NOT SILENTLY RESOLVED. Whether a `draft` trip is
 * "the current trip" is a product decision nobody has written down, so the
 * status set stays a parameter and both existing sets are exported as named
 * constants. What changes is that the divergence is now visible in one file
 * instead of invisible across five. Reported to the owner rather than decided
 * here.
 *
 * THE BUG THIS FIXES
 * ==================
 * `toolGetCurrentTrip` did not bind `error` on ANY of its three selection
 * reads:
 *
 *     const { data: memberRows } = await sc.from("trip_members")...
 *
 * An unreadable `trip_members` therefore produced zero member trips, which fell
 * through to `{ trip: null, info: "No active or upcoming trip." }` — and the
 * assistant told a traveller standing in Lisbon that they have no trip. That is
 * not a degraded answer, it is a wrong one, and it is the same defect
 * `CompassTripContext` had already fixed for itself and `TripCompassProjection`
 * describes at length: *"the old tool could not tell 'no plan' from 'could not
 * read the plan'"*. An unreadable selection read is now `unread`, a distinct
 * outcome from `none`, and the caller must say which it got.
 *
 * The framing document states the same rule in its own words: *"Distinguish
 * authorized empty results from dependency failure internally and give an
 * honest user-facing limitation"* and *"Unknown is not zero"*.
 *
 * NOT PURE — it reads. It writes nothing, and it never widens what the caller
 * may see: membership is the same owner ∪ accepted-member union every caller
 * already used.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Columns every Compass caller needs from a trip row, as one list. */
const TRIP_COLUMNS =
  "id, title, destination_city, destination_country, start_date, end_date, status, timezone";

/**
 * The tool's rule: a trip that is happening or is planned.
 * `toolGetCurrentTrip` has always used these three.
 */
export const TOOL_TRIP_STATUSES = ["active", "upcoming", "planning"] as const;

/**
 * The always-on chat-grounding rule, which additionally counts `draft`.
 * `buildTripContextLines` has always used these four.
 *
 * OWNER DECISION, NAMED RATHER THAN RESOLVED: is a `draft` trip the user's
 * current trip? The tool says no and the context block says yes, and they have
 * disagreed since both were written.
 */
export const CONTEXT_TRIP_STATUSES = ["active", "upcoming", "planning", "draft"] as const;

/** A selected trip, in one shape, with the raw column names left behind. */
export interface CompassTripCandidate {
  id:                 string;
  title:              string | null;
  destinationCity:    string | null;
  destinationCountry: string | null;
  startDate:          string | null;
  endDate:            string | null;
  status:             string | null;
  timezone:           string | null;
}

/**
 * Three-valued, like `TripCompassProjection.planItems` and for the same reason:
 * `none` is a fact about the traveller and `unread` is a fact about the
 * database, and a caller that cannot tell them apart will state the first when
 * it observed the second.
 */
export type CurrentTripOutcome =
  | { status: "ok";     trip: CompassTripCandidate }
  | { status: "none" }
  | { status: "unread"; reason: string };

function toCandidate(row: any): CompassTripCandidate {
  return {
    id:                 String(row.id),
    title:              row.title ?? null,
    destinationCity:    row.destination_city ?? null,
    destinationCountry: row.destination_country ?? null,
    startDate:          typeof row.start_date === "string" ? row.start_date.slice(0, 10) : null,
    endDate:            typeof row.end_date   === "string" ? row.end_date.slice(0, 10)   : null,
    status:             row.status ?? null,
    timezone:           typeof row.timezone === "string" && row.timezone ? row.timezone : null,
  };
}

/**
 * Every trip the user owns or is an accepted member of, in the given statuses.
 *
 * Exported because two callers want the SET (Sense and Live ask "any of my
 * trips", not "my current trip") and re-deriving the union for them would put
 * the duplication straight back.
 */
export async function resolveUserTrips(
  sc: SupabaseClient,
  userId: string,
  statuses: readonly string[] = TOOL_TRIP_STATUSES,
): Promise<{ status: "ok"; trips: CompassTripCandidate[] } | { status: "unread"; reason: string }> {
  // Membership. An unreadable membership table must NOT read as "not a member
  // of anything": that silently narrows the union and the caller then answers
  // about the wrong trip, or about none.
  let memberTripIds: string[] = [];
  try {
    const { data: memberRows, error: memberErr } = await sc
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", userId)
      .in("role", ["owner", "member"]);
    if (memberErr) return { status: "unread", reason: "trip_members could not be read" };
    memberTripIds = ((memberRows ?? []) as any[]).map((r) => String(r.trip_id));
  } catch {
    return { status: "unread", reason: "trip_members could not be read" };
  }

  let owned: any[] = [];
  try {
    const { data, error } = await sc
      .from("trips")
      .select(TRIP_COLUMNS)
      .eq("owner_id", userId)
      .in("status", statuses as string[]);
    if (error) return { status: "unread", reason: "trips could not be read" };
    owned = (data ?? []) as any[];
  } catch {
    return { status: "unread", reason: "trips could not be read" };
  }

  let memberTrips: any[] = [];
  if (memberTripIds.length > 0) {
    try {
      const { data, error } = await sc
        .from("trips")
        .select(TRIP_COLUMNS)
        .in("id", memberTripIds)
        .in("status", statuses as string[]);
      if (error) return { status: "unread", reason: "trips could not be read" };
      memberTrips = (data ?? []) as any[];
    } catch {
      return { status: "unread", reason: "trips could not be read" };
    }
  }

  const seen = new Set<string>();
  const all: CompassTripCandidate[] = [];
  for (const row of [...owned, ...memberTrips]) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    all.push(toCandidate(row));
  }
  return { status: "ok", trips: all };
}

/**
 * The user's current trip: prefer an `active` one, then the earliest start
 * date. This ordering is the rule every Compass caller already applied; it is
 * stated once here so a change to it changes every surface at once instead of
 * one.
 */
export async function resolveCurrentTrip(
  sc: SupabaseClient,
  userId: string,
  statuses: readonly string[] = TOOL_TRIP_STATUSES,
): Promise<CurrentTripOutcome> {
  const read = await resolveUserTrips(sc, userId, statuses);
  if (read.status === "unread") return read;
  if (read.trips.length === 0) return { status: "none" };

  const sorted = [...read.trips].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(a.startDate ?? "9999").localeCompare(String(b.startDate ?? "9999"));
  });
  return { status: "ok", trip: sorted[0]! };
}
