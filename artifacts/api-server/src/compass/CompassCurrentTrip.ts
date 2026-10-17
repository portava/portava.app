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
 * THE READS ARE TRIPS' NOW (CT-02)
 * ================================
 * This module used to hold the three sanctioned raw reads of `trip_members` and
 * `trips`, on the ground that no Trip projection answered a USER-scoped question.
 * Trips now publishes those projections (domain/trips/projections/
 * TripCompassMembershipProjection.ts and TripCompassTripSummaryProjection.ts),
 * so this module CONSUMES them through the §19.1 consumer rule and reads no
 * table itself. What it still owns is Compass's: which statuses and roles count
 * for which surface, and the "prefer active, then earliest start" ordering.
 *
 * `src/test/compassTripProjectionReads.test.ts` case D holds every compass/
 * module to zero raw Trip-table reads; a read appearing here fails it.
 *
 * NOT PURE — it reads, through Trips. It writes nothing, and it never widens
 * what the caller may see: membership is the same owner ∪ accepted-member union
 * every caller already used.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTripCompassMembershipProjection, type TripCompassMemberTrip, type TripCompassMemberTripsResult } from "../domain/trips/projections/TripCompassMembershipProjection.js";
import { buildTripCompassOwnedTripsProjection, buildTripCompassTripsByIdProjection, type TripCompassTripListResult, type TripCompassTripSummary } from "../domain/trips/projections/TripCompassTripSummaryProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";


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

/**
 * THE TRIP-ID GRAMMAR — census-compass CT-07, census-trips TR202..TR213.
 *
 * It lives HERE, in the one module that decides which trip Compass is talking
 * about, for the same reason the status sets do: twelve tools that each spell
 * out their own id check are twelve chances for eleven of them to be right.
 *
 * WHY A TOOL MUST CHECK AT ALL. `add_to_trip` has guarded its id since it was
 * written; the other §12.1 tools handed whatever the model sent to
 * `isAcceptedTripMember`. Postgres answers a non-uuid with
 * `22P02 invalid input syntax for type uuid`, PostgREST returns it as a read
 * error, `requireTripMember` refuses — correctly — to read a failed read as
 * "not a member" and throws `TripAccessUnavailableError`, and
 * `executeCompassTool` relays that — correctly — as
 *
 *     "That trip's records are unreadable right now — this is temporary …"
 *
 * Every link is right and the sentence is false. Nothing is unreadable, nothing
 * is temporary, and "try again shortly" is an invitation to resend the same bad
 * id. A string that is not a trip id is a fact the tool can establish itself,
 * before it asks anything, and that is what this does.
 *
 * The pattern is `add_to_trip`'s own, unchanged, so the twelve and the
 * thirteenth agree: 36 characters of hex and dashes. Deliberately NOT a strict
 * RFC-4122 matcher — tightening it here would silently start refusing ids some
 * caller already passes, which is a behaviour change dressed as a clean-up.
 */
export const TRIP_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/** True only for a string shaped like a trip id. Everything else — including `""` — is false. */
export function isWellFormedTripId(value: unknown): value is string {
  return typeof value === "string" && TRIP_ID_PATTERN.test(value);
}

/**
 * The ONE sentence every §12.1 tool answers a malformed id with. One string so
 * the twelve cannot drift, and worded so the model learns the id was wrong
 * rather than that the database was.
 */
export const MALFORMED_TRIP_ID_INFO =
  "That is not a valid trip id — nothing was looked up. Use a trip id from get_current_trip.";

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

function toCandidate(row: TripCompassTripSummary): CompassTripCandidate {
  return {
    id:                 row.id,
    title:              row.title,
    destinationCity:    row.destinationCity,
    destinationCountry: row.destinationCountry,
    startDate:          row.startDate !== null ? row.startDate.slice(0, 10) : null,
    endDate:            row.endDate   !== null ? row.endDate.slice(0, 10)   : null,
    status:             row.status,
    timezone:           row.timezone ? row.timezone : null,
  };
}

/**
 * THE MEMBERSHIP ROLE SETS, named rather than inlined — CT-02.
 *
 * `trip_members.role` is `member_role`, and three Compass surfaces asked it
 * three different questions with three different role lists. The lists stay
 * DIFFERENT, as named constants in this one module, for the reason §15.4 gave
 * for keeping `TOOL_TRIP_STATUSES` and `CONTEXT_TRIP_STATUSES` apart: which
 * roles count as "on this trip" is a product decision nobody has written down,
 * and unifying them here would be a user-visible behaviour change made by a
 * lane with no spec to make it from.
 *
 * What CT-02 buys is that the READ is one read, in one place, that cannot
 * answer "not a member of anything" because the table was unreadable.
 */
/** Selection: who may have a *current* trip. `resolveUserTrips`'s own list. */
export const SELECTION_TRIP_ROLES = ["owner", "member"] as const;
/** The social graph's wider list — a `viewer` is on the trip for context purposes. */
export const SOCIAL_CONTEXT_TRIP_ROLES = ["owner", "co_host", "member", "viewer"] as const;

/**
 * Three-valued for the same reason `CurrentTripOutcome` is: an unreadable
 * `trip_members` is a fact about the database, and a caller that cannot tell it
 * from "this user is on no trips" will state the second having observed the
 * first. There is no `none` arm because an empty id list is a perfectly good
 * `ok` answer — the distinction that matters is read / did-not-read.
 */
export type MemberTripIdsOutcome =
  | { status: "ok"; tripIds: string[] }
  | { status: "unread"; reason: string };

/**
 * The trip ids this user is on, by role — Compass's ONE consumer of Trips'
 * membership projection, answering "which trips is this user on" for Compass.
 *
 * `acceptedOnly` is explicit and defaults to the *wider* answer because that is
 * what `resolveUserTrips` has always done (it filters nothing on `status`, and
 * `trip_members.status` is NOT NULL DEFAULT 'accepted', so the two differ only
 * where a row is `invited` / `declined` / `removed` / `left`). A caller that
 * wants the narrower set says so; nothing is narrowed on a caller's behalf,
 * because silently narrowing an authorization set is the mirror image of the
 * defect this module exists to stop.
 */
export async function resolveMemberTripIds(
  sc: SupabaseClient,
  userId: string,
  opts: { roles: readonly string[]; acceptedOnly?: boolean },
): Promise<MemberTripIdsOutcome> {
  // An unreadable membership must NOT read as "not a member of anything": that
  // silently narrows the union and the caller then answers about the wrong
  // trip, or about none. Trips' projection refuses an errored or non-array read
  // (§59), and its envelope passes the §19.1 consumer rule before it is used.
  const built = await buildTripCompassMembershipProjection(sc, userId, { roles: opts.roles });
  if (!built.ok || !acceptTripProjection(built.projection, {
    acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, metric: "TripCompassMembershipProjection",
  }).accepted) {
    return { status: "unread", reason: "trip_members could not be read" };
  }
  // What "accepted" means (status `accepted`, or not served) is Trips' rule,
  // stated once in the projection; which callers want only those stays theirs.
  return {
    status: "ok",
    tripIds: opts.acceptedOnly === true ? built.projection.acceptedTripIds : built.projection.tripIds,
  };
  // (Read order is the projection's: membership rows as the table served them.)
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
  const membership = await resolveMemberTripIds(sc, userId, { roles: SELECTION_TRIP_ROLES });
  if (membership.status === "unread") return membership;
  const memberTripIds = membership.tripIds;

  // The owned trips and the member trips, in the requested statuses, from Trips'
  // trip-row projection: one typed row shape, each row carrying its own §19.1
  // envelope, and every envelope must pass the consumer rule before ANY row is
  // used. Each read failing — an error, a non-array body (§59), a row that is not
  // a trip row, a refused envelope — is the whole selection `unread`, never a
  // partial union: a union missing the owned half answers about the wrong trip.
  //
  // Order is unchanged: membership, then owned, then member trips; and with no
  // member trip ids the member read is not issued at all (the projection
  // answers an empty id list without reading).
  const owned = acceptedTripRows(
    await buildTripCompassOwnedTripsProjection(sc, userId, { statuses }),
  );
  if (owned === null) return { status: "unread", reason: "trips could not be read" };

  const memberTrips = acceptedTripRows(
    await buildTripCompassTripsByIdProjection(sc, userId, memberTripIds, { statuses }),
  );
  if (memberTrips === null) return { status: "unread", reason: "trips could not be read" };

  // Owned first, then member trips; a trip the user both owns and is a member
  // of appears once (below). Status filtering happened in Trips' read, as it
  // did in the raw reads it replaced; nothing is filtered again here.
  //
  // The rows are TripCompassTripSummary values: typed columns, no `any`, and
  // the version each was read at is in the projection's `sources`.


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

/**
 * The rows of a Trips trip-list projection, if Compass may use them: null when the
 * projection was unavailable OR any one trip's §19.1 envelope is refused (schema
 * mismatch, version ahead, stale). One refused source refuses the list, as
 * check_trip_conflicts does for the range projection's sources — a list missing
 * one trip is a partial union, which callers here treat as unread.
 */
export function acceptedTripRows(built: TripCompassTripListResult): TripCompassTripSummary[] | null {
  if (!built.ok) return null;
  for (const source of built.projection.sources) {
    if (!acceptTripProjection(source, {
      acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, metric: "TripCompassTripSummaryProjection",
    }).accepted) return null;
  }
  return built.projection.trips;
}

/**
 * The membership rows of a Trips member-trips projection (each joined to its
 * trip), if Compass may use them: null when the projection was unavailable, its
 * own envelope was refused, or any embedded trip's envelope was refused (§19.1).
 */
export function acceptedMemberTrips(built: TripCompassMemberTripsResult): TripCompassMemberTrip[] | null {
  if (!built.ok) return null;
  const rule = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, metric: "TripCompassMemberTripsProjection" };
  if (!acceptTripProjection(built.projection, rule).accepted) return null;
  for (const source of built.projection.sources) {
    if (!acceptTripProjection(source, rule).accepted) return null;
  }
  return built.projection.memberTrips;
}
