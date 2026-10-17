/**
 * Trips spec §19.1 — the USER-scoped membership projections Compass consumes
 * instead of reading `trip_members` itself (census-compass CT-02, Trips `:25`).
 *
 * "Which trips is this user on" is a question about `trip_members`, and three
 * Compass modules answered it with their own reads: the current-trip seam
 * (compass/CompassCurrentTrip.ts, by role), and the fallback feed twice (a
 * membership row joined to its trip, for the active-trip and saved-trip
 * sections). Census-compass §62 counted four such reads. They are Trips' now:
 *
 *   buildTripCompassMembershipProjection      the user's memberships in the named
 *                                             roles: trip id, role, status, and
 *                                             which of them are ACCEPTED
 *   buildTripCompassMemberTripsProjection     the user's membership rows (any
 *                                             role, any status — the fallback
 *                                             feed's own question, kept as it
 *                                             was), each with its trip
 *
 * WHAT "ACCEPTED" MEANS IS TRIPS', NOT COMPASS'S. `trip_members.status` is NOT
 * NULL DEFAULT 'accepted'; a row is accepted when its status is `accepted` or
 * (for a row read through a path that did not select it) absent. That rule was
 * re-derived inline by the seam's `acceptedOnly` filter; it is stated once here.
 * WHICH ROLES count as "on the trip" for a given Compass surface stays the
 * caller's parameter — compass/CompassCurrentTrip.ts names those lists as an
 * owner question rather than resolving it.
 *
 * THE ENVELOPE IS UNATTRIBUTABLE, AND SAYS SO. A membership set spans trips; it
 * is not the state of one trip aggregate, so there is no single
 * `trips.version` it was read at, and reading every member trip's version would
 * add a read per call to answer a question nobody asks of a membership list. The
 * envelope is therefore `freshness: "unattributable"` with
 * `sourceTripVersion: null` — §19.1's own word for "generated live, not
 * attributable to a trip version": it may be used, and must not be cached or
 * compared (TripProjectionEnvelope.ts). The joined member-trips projection's
 * EMBEDDED trips do carry their row's version, per trip, in `sources`.
 *
 * FAILURE IS NOT EMPTINESS. An error, a non-array body or a row that is not a
 * membership row is `TRIP_PROJECTION_UNAVAILABLE`; a readable empty array is
 * "on no trips".
 *
 * NOT PURE — it reads `trip_members` (and, embedded, `trips`). It writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import {
  toTripCompassTripSummary, tripRowVersion, type TripCompassTripSource, type TripCompassTripSummary,
} from "./TripCompassTripSummaryProjection.js";

export interface TripCompassMembership {
  tripId: string;
  role: string;
  /** null = the status column was not served; Trips counts that as accepted. */
  status: string | null;
}

export interface TripCompassMembershipProjection extends TripProjectionEnvelope {
  userId: string;
  roles: string[];
  memberships: TripCompassMembership[];
  /** Every membership's trip id, in read order — any status. */
  tripIds: string[];
  /** The trip ids whose membership is ACCEPTED (status `accepted` or not served). */
  acceptedTripIds: string[];
}

export type TripCompassMembershipResult =
  | { ok: true; projection: TripCompassMembershipProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

export interface TripCompassMemberTrip {
  tripId: string;
  role: string | null;
  status: string | null;
  /** The embedded trip; null when the join served none (a trip the caller cannot see). */
  trip: TripCompassTripSummary | null;
}

export interface TripCompassMemberTripsProjection extends TripProjectionEnvelope {
  userId: string;
  readLimit: number;
  memberTrips: TripCompassMemberTrip[];
  /** One per embedded trip, carrying that trip row's own version. */
  sources: TripCompassTripSource[];
}

export type TripCompassMemberTripsResult =
  | { ok: true; projection: TripCompassMemberTripsProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;

/** `member_role` (baseline 20260819): the only labels a role filter may name; an unknown one is refused unread. */
export const TRIP_MEMBER_ROLE_LABELS = ["owner", "member", "invited", "co_host", "viewer"] as const;

/** Trips' one rule for an accepted membership (2420: NOT NULL DEFAULT 'accepted'). */
export function isAcceptedMembershipStatus(status: string | null): boolean {
  return status === null || status === "accepted";
}

function nullableString(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : false;
}

/**
 * The memberships `userId` holds in `roles`. Every status is returned; the
 * accepted ones are named separately so a caller that wants only those does not
 * re-derive what "accepted" means.
 */
export async function buildTripCompassMembershipProjection(
  sc: SupabaseClient,
  userId: string,
  opts: { roles: readonly string[]; now?: Date },
): Promise<TripCompassMembershipResult> {
  if (!opts.roles.every((r) => (TRIP_MEMBER_ROLE_LABELS as readonly string[]).includes(r))) return UNAVAILABLE;
  try {
    const { data, error } = await sc.from("trip_members")
      .select("trip_id, role, status")
      .eq("user_id", userId)
      .in("role", [...opts.roles]);
    if (error || !Array.isArray(data)) return UNAVAILABLE;
    const memberships: TripCompassMembership[] = [];
    for (const value of data as unknown[]) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return UNAVAILABLE;
      const row = value as Record<string, unknown>;
      const status = nullableString(row.status);
      if (typeof row.trip_id !== "string" || row.trip_id.length === 0 || typeof row.role !== "string" || status === false) return UNAVAILABLE;
      memberships.push({ tripId: row.trip_id, role: row.role, status });
    }
    return { ok: true, projection: {
      ...liveEnvelope(null, opts.now),
      userId,
      roles: [...opts.roles],
      memberships,
      tripIds: memberships.map((m) => m.tripId),
      acceptedTripIds: memberships.filter((m) => isAcceptedMembershipStatus(m.status)).map((m) => m.tripId),
    } };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * The user's membership rows, each joined to its trip — the fallback feed's
 * read, kept exactly as it asked it: no role or status filter, capped at
 * `limit` membership rows, in read order. Which of these a surface shows (a
 * status, a date) is the surface's filter over the typed rows.
 */
export async function buildTripCompassMemberTripsProjection(
  sc: SupabaseClient,
  userId: string,
  opts: { limit: number; now?: Date },
): Promise<TripCompassMemberTripsResult> {
  try {
    const { data, error } = await sc.from("trip_members")
      .select("trip_id, role, status, trips(id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version)")
      .eq("user_id", userId)
      .limit(opts.limit);
    if (error || !Array.isArray(data) || data.length > opts.limit) return UNAVAILABLE;
    const now = opts.now ?? new Date();
    const memberTrips: TripCompassMemberTrip[] = [];
    const sources: TripCompassTripSource[] = [];
    for (const value of data as unknown[]) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return UNAVAILABLE;
      const row = value as Record<string, unknown>;
      const role = nullableString(row.role);
      const status = nullableString(row.status);
      if (typeof row.trip_id !== "string" || row.trip_id.length === 0 || role === false || status === false) return UNAVAILABLE;
      // A many-to-one embed is one object or null. Anything else is not a trip:
      // it is served as "no trip", as the feed's `.filter(Boolean)` + id check did.
      const embedded = row.trips;
      const trip = embedded === null || embedded === undefined || typeof embedded !== "object" || Array.isArray(embedded)
        ? null : toTripCompassTripSummary(embedded);
      if (embedded !== null && embedded !== undefined && typeof embedded === "object" && !Array.isArray(embedded) && trip === null
        && typeof (embedded as Record<string, unknown>).id === "string" && ((embedded as Record<string, unknown>).id as string).length > 0) {
        return UNAVAILABLE; // an embedded trip WITH an id whose columns are not a trip row's is malformed, not absent
      }
      memberTrips.push({ tripId: row.trip_id, role, status, trip });
      if (trip) sources.push({ tripId: trip.id, ...liveEnvelope(tripRowVersion((embedded as Record<string, unknown>).version), now) });
    }
    return { ok: true, projection: { ...liveEnvelope(null, now), userId, readLimit: opts.limit, memberTrips, sources } };
  } catch {
    return UNAVAILABLE;
  }
}

export interface TripCompassTripMemberIdsProjection extends TripProjectionEnvelope {
  tripId: string;
  /** Every membership row's user, any role, any status — the trip feed's own question, kept as it asked it. */
  memberIds: string[];
  /** The accepted ones (Trips' rule), for a caller that wants only those. */
  acceptedMemberIds: string[];
}

export type TripCompassTripMemberIdsResult =
  | { ok: true; projection: TripCompassTripMemberIdsProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

/**
 * The users holding a membership row on one trip — the Compass trip-surface feed's
 * member signal, which read `trip_members` itself with no role or status filter.
 * Trip-scoped, so the envelope carries `trips.version`, read before the rows.
 */
export async function buildTripCompassTripMemberIdsProjection(
  sc: SupabaseClient,
  tripId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassTripMemberIdsResult> {
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId);
    if (error || !Array.isArray(data)) return UNAVAILABLE;
    const memberIds: string[] = [];
    const acceptedMemberIds: string[] = [];
    for (const value of data as unknown[]) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return UNAVAILABLE;
      const row = value as Record<string, unknown>;
      const status = nullableString(row.status);
      if (typeof row.user_id !== "string" || row.user_id.length === 0 || status === false || nullableString(row.role) === false) return UNAVAILABLE;
      memberIds.push(row.user_id);
      if (isAcceptedMembershipStatus(status)) acceptedMemberIds.push(row.user_id);
    }
    return { ok: true, projection: { ...liveEnvelope(version, opts.now), tripId, memberIds, acceptedMemberIds } };
  } catch {
    return UNAVAILABLE;
  }
}
