/**
 * Trips spec §19.1 — the trip-ROW projections Compass consumes instead of reading
 * `trips` itself (census-compass CT-02, Trips `:25`).
 *
 * WHAT THIS REPLACES
 * ==================
 * Before this module, nine Compass modules each spelled out their own
 * `.from("trips")` read: which columns make up "a trip", how an owner's trips are
 * found, how a member's trips are found by id, which statuses count. Census-compass
 * §61/§62 measured fourteen such reads. Each consumer now asks Trips one of three
 * questions, and Trips answers with ONE typed row shape:
 *
 *   buildTripCompassOwnedTripsProjection   the trips a user OWNS (optionally in
 *                                          some statuses, ordered, capped)
 *   buildTripCompassTripsByIdProjection    named trips (optionally in some statuses)
 *   buildTripCompassTripSummaryProjection  one trip by id (optionally only if the
 *                                          caller owns it), or null
 *
 * The filters each consumer applied are PARAMETERS here, not re-decided: a status
 * list the caller names, an owner constraint the caller names, a cap and an order
 * the caller names. Which statuses count as "current" stays the consumer's
 * decision (compass/CompassCurrentTrip.ts names it as an owner question); what a
 * trip row IS, and how it is read, is Trips'.
 *
 * THE ENVELOPE
 * ============
 * Every returned trip carries its own §19.1 source envelope, with
 * `sourceTripVersion` taken from `trips.version` IN THE SAME ROW — so attribution
 * costs no extra read and names exactly the state the row was read at. A row whose
 * version is unreadable is `unattributable` (TripProjectionEnvelope.ts), never a
 * fabricated 0. A consumer checks every source with `acceptTripProjection` before
 * using the rows, as check_trip_conflicts already does for the range projection.
 *
 * FAILURE IS NOT EMPTINESS
 * ========================
 * A returned error, a non-array body, or a row that is not a trip row is
 * `TRIP_PROJECTION_UNAVAILABLE` — never an empty list. §59 recorded the defect
 * this prevents: a `{ data: null, error: null }` body read as "this user has no
 * trips". A readable empty array is an empty list.
 *
 * NOT PURE — it reads `trips`, and nothing else. It writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";

/** The one column list a Compass trip row is read with. `version` is the envelope's source. */
export const TRIP_COMPASS_SUMMARY_COLUMNS =
  "id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version" as const;

/** A trip, as Compass may know it. Raw column values, typed; no column is invented. */
export interface TripCompassTripSummary {
  id: string;
  ownerId: string | null;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  /** As stored (a `date`); a consumer that needs YYYY-MM-DD slices it itself. */
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  timezone: string | null;
  visibility: string | null;
  createdAt: string | null;
}

/** §19.1's four fields for one trip, as `TripCompassRangeProjection.sources` carries them. */
export type TripCompassTripSource = TripProjectionEnvelope & { tripId: string };

export interface TripCompassTripListProjection {
  /** Who asked: the owner for an owned list, the viewer for a by-id list. */
  userId: string;
  trips: TripCompassTripSummary[];
  /** One per trip, in the same order. */
  sources: TripCompassTripSource[];
}

export type TripCompassTripListResult =
  | { ok: true; projection: TripCompassTripListProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

export interface TripCompassTripSummaryProjection extends TripProjectionEnvelope {
  tripId: string;
  /** null = no such trip (or, with `ownerId`, not this caller's) — a READ fact, not a failure. */
  trip: TripCompassTripSummary | null;
}

export type TripCompassTripSummaryResult =
  | { ok: true; projection: TripCompassTripSummaryProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;

/**
 * `trip_status` (baseline 20260819), the only labels a status filter may name.
 * Compass's status lists used to be literals inside its own `.in("status", […])`
 * calls, where `check:enum-literals` could read them (it once caught
 * `in_progress`, which made the fallback feed's read fail whole with 22P02). Now
 * that the list is a PARAMETER, this is that check: an unknown label is refused
 * before any read is issued, rather than sent to PostgREST to fail.
 */
export const TRIP_STATUS_LABELS = ["draft", "planning", "upcoming", "active", "completed", "cancelled", "archived"] as const;
function knownStatuses(statuses: readonly string[] | undefined): boolean {
  return statuses === undefined || statuses.every((s) => (TRIP_STATUS_LABELS as readonly string[]).includes(s));
}

/** `trip_visibility` (baseline 20260819). The same refusal as statuses: an unknown label is never sent. */
export const TRIP_VISIBILITY_LABELS = ["public", "buddies", "private", "invite"] as const;

/** A YYYY-MM-DD calendar day, or absent. Anything else would be a filter Trips cannot state. */
function isDayOrAbsent(day: string | undefined): boolean {
  return day === undefined || (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

/** `trips.version`, or null when it is not a version (absent, negative, not an integer). */
export function tripRowVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A trip row, typed — or null when the value is not one. Every column is either
 * absent/null or the type the schema gives it; an id is a non-empty string.
 * Exported so a joined read (the membership projection's embedded trip) types its
 * rows by the same rule.
 */
export function toTripCompassTripSummary(value: unknown): TripCompassTripSummary | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  const text = ["owner_id", "title", "destination_city", "destination_country", "start_date", "end_date", "status", "timezone", "visibility", "created_at"] as const;
  if (!text.every((column) => isNullableString(row[column]))) return null;
  const str = (column: (typeof text)[number]) => (row[column] as string | null | undefined) ?? null;
  return {
    id: row.id,
    ownerId: str("owner_id"),
    title: str("title"),
    destinationCity: str("destination_city"),
    destinationCountry: str("destination_country"),
    startDate: str("start_date"),
    endDate: str("end_date"),
    status: str("status"),
    timezone: str("timezone"),
    visibility: str("visibility"),
    createdAt: str("created_at"),
  };
}

function listFrom(userId: string, data: unknown, now: Date): TripCompassTripListResult {
  if (!Array.isArray(data)) return UNAVAILABLE;
  const trips: TripCompassTripSummary[] = [];
  const sources: TripCompassTripSource[] = [];
  for (const value of data as unknown[]) {
    const trip = toTripCompassTripSummary(value);
    if (!trip) return UNAVAILABLE;
    trips.push(trip);
    sources.push({ tripId: trip.id, ...liveEnvelope(tripRowVersion((value as Record<string, unknown>).version), now) });
  }
  return { ok: true, projection: { userId, trips, sources } };
}

/**
 * The trips `userId` owns. `statuses` omitted = every status (the profile's
 * question); `order: "id_desc"` + `limit` are the Passport list's cap, exactly as
 * it read them.
 */
export async function buildTripCompassOwnedTripsProjection(
  sc: SupabaseClient,
  userId: string,
  opts: { statuses?: readonly string[]; endingOnOrAfter?: string; order?: "id_desc"; limit?: number; now?: Date } = {},
): Promise<TripCompassTripListResult> {
  if (!knownStatuses(opts.statuses) || !isDayOrAbsent(opts.endingOnOrAfter)) return UNAVAILABLE;
  try {
    let query: any = sc.from("trips").select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version" satisfies typeof TRIP_COMPASS_SUMMARY_COLUMNS).eq("owner_id", userId);
    if (opts.statuses) query = query.in("status", [...opts.statuses]);
    if (opts.endingOnOrAfter !== undefined) query = query.gte("end_date", opts.endingOnOrAfter);
    if (opts.order === "id_desc") query = query.order("id", { ascending: false });
    if (opts.limit !== undefined) query = query.limit(opts.limit);
    const { data, error } = await query;
    if (error) return UNAVAILABLE;
    return listFrom(userId, data, opts.now ?? new Date());
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * The named trips, optionally only those in `statuses`. An empty id list is an
 * empty answer and reads nothing (the membership union with no member trips).
 * `viewerId` is the caller the answer is for; this read authorises nothing — the
 * ids come from the caller's own membership projection.
 */
export async function buildTripCompassTripsByIdProjection(
  sc: SupabaseClient,
  viewerId: string,
  tripIds: readonly string[],
  opts: { statuses?: readonly string[]; now?: Date } = {},
): Promise<TripCompassTripListResult> {
  if (!knownStatuses(opts.statuses)) return UNAVAILABLE;
  if (tripIds.length === 0) return { ok: true, projection: { userId: viewerId, trips: [], sources: [] } };
  try {
    let query: any = sc.from("trips").select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version" satisfies typeof TRIP_COMPASS_SUMMARY_COLUMNS).in("id", [...tripIds]);
    if (opts.statuses) query = query.in("status", [...opts.statuses]);
    const { data, error } = await query;
    if (error) return UNAVAILABLE;
    return listFrom(viewerId, data, opts.now ?? new Date());
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Other users' trips, as a matching surface may know them: the trips the named
 * owners hold in `statuses`, in `visibilities` only, still running on or after a
 * day. The visibility list is the privacy rule and the caller states it; Trips
 * refuses a label `trip_visibility` does not have (Compass's traveller match once
 * asked for `"friends"`, and Postgres refused the whole read with 22P02). No owner
 * ids is an empty answer and reads nothing.
 */
export async function buildTripCompassTripsByOwnersProjection(
  sc: SupabaseClient,
  viewerId: string,
  ownerIds: readonly string[],
  opts: { statuses: readonly string[]; visibilities: readonly string[]; endingOnOrAfter?: string; now?: Date },
): Promise<TripCompassTripListResult> {
  if (!knownStatuses(opts.statuses) || !isDayOrAbsent(opts.endingOnOrAfter)
    || opts.visibilities.length === 0
    || !opts.visibilities.every((v) => (TRIP_VISIBILITY_LABELS as readonly string[]).includes(v))) return UNAVAILABLE;
  if (ownerIds.length === 0) return { ok: true, projection: { userId: viewerId, trips: [], sources: [] } };
  try {
    let query: any = sc.from("trips").select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version" satisfies typeof TRIP_COMPASS_SUMMARY_COLUMNS)
      .in("owner_id", [...ownerIds])
      .in("status", [...opts.statuses])
      .in("visibility", [...opts.visibilities]);
    if (opts.endingOnOrAfter !== undefined) query = query.gte("end_date", opts.endingOnOrAfter);
    const { data, error } = await query;
    if (error) return UNAVAILABLE;
    const listed = listFrom(viewerId, data, opts.now ?? new Date());
    // Defence in depth: a row outside the owners or the visibilities asked for is not this answer.
    if (listed.ok && listed.projection.trips.some((t) => !ownerIds.includes(t.ownerId ?? "")
      || !opts.visibilities.includes(t.visibility ?? ""))) return UNAVAILABLE;
    return listed;
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * One trip by id. With `ownerId`, only if that user owns it: a borrowed trip id
 * resolves to `trip: null`, exactly as the Memory recap's owner-scoped read did.
 * Not found is `ok` with `trip: null` and an unattributable envelope (there is no
 * row to take a version from); a failed read is unavailable.
 */
export async function buildTripCompassTripSummaryProjection(
  sc: SupabaseClient,
  tripId: string,
  opts: { ownerId?: string; now?: Date } = {},
): Promise<TripCompassTripSummaryResult> {
  try {
    let query: any = sc.from("trips").select("id, owner_id, title, destination_city, destination_country, start_date, end_date, status, timezone, visibility, created_at, version" satisfies typeof TRIP_COMPASS_SUMMARY_COLUMNS).eq("id", tripId);
    if (opts.ownerId !== undefined) query = query.eq("owner_id", opts.ownerId);
    const { data, error } = await query.maybeSingle();
    if (error) return UNAVAILABLE;
    if (data === null || data === undefined) {
      return { ok: true, projection: { ...liveEnvelope(null, opts.now), tripId, trip: null } };
    }
    const trip = toTripCompassTripSummary(data);
    if (!trip || trip.id !== tripId) return UNAVAILABLE;
    return { ok: true, projection: { ...liveEnvelope(tripRowVersion((data as Record<string, unknown>).version), opts.now), tripId, trip } };
  } catch {
    return UNAVAILABLE;
  }
}
