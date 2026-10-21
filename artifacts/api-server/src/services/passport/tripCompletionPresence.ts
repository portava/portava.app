/**
 * The occurrence evidence a trip-completion stamp needs.
 *
 * census-highlights-memories H4: "Planned/saved/nearby never represented as
 * 'experienced' without occurrence evidence or user confirmation."
 *
 * WHAT WAS WRONG
 * ==============
 * `routes/trips.ts#awardTripCompletionStamps` mints the nine trip-completion
 * slugs (first_trip_completed, international_voyager, solo_traveler, …). 2970
 * classifies all nine `evidences_presence = true`, so each keeps the trip's
 * destination city and country, and the Passport counts that country as one the
 * traveller has been to.
 *
 * The gate was `status = 'completed'`. That status is not a confirmation by
 * anybody. `computeTripStatus` derives it from the calendar: any PATCH of the
 * trip after its end date (a cover photo, a note, an empty body) recomputes the
 * status, and the transition awarded the stamps to EVERY accepted member. The
 * PATCH body's own `status` is ignored by that computation, and the explicit
 * `POST /trips/:tripId/complete` awards nothing. So a trip planned and never
 * taken became "first trip completed, Paris, France" for each person on it the
 * first time the owner touched it after the dates passed. 2970's header calls
 * completion "the trip owner PATCHing status='completed' … self-attested"; at
 * this tree the PATCH cannot set it, and it attested nothing for the members.
 *
 * WHAT COUNTS AS EVIDENCE HERE
 * ============================
 * Per PERSON and per TRIP, either:
 *
 *   (a) a `plan_checkins` row for this trip and this person carrying an arrival
 *       (`checked_in_at` set, status arrived / late / left). It is written by
 *       `POST /trips/:tripId/geofence/check-in`, which checks the person's fix
 *       against the plan's geofence radius, and stamps `checked_in_at` only on
 *       an arrival; or
 *   (b) a `passport_stamps` row for this trip and this person at a verified
 *       level (`checkin`, `gps`) — the stamp that same check-in, or a completed
 *       layover session tied to the trip, writes.
 *
 * Nothing else is read. A calendar, a destination, membership, an RSVP and the
 * owner's edit are all intent.
 *
 * FAIL CLOSED, AND WHAT THAT COSTS
 * ================================
 * A person without evidence earns no completion stamp: no place, no "completed"
 * achievement, nothing for Countries. That under-claims a trip somebody really
 * took without checking in anywhere, and it is visible to them; the opposite
 * error is a false statement about where a person has been (2970's header,
 * "THE DEFAULT FAILS SAFE"; `nonPresenceStampAwards.ts`). An unreadable source
 * contributes no evidence and is reported, never read as "nobody was there"
 * for the purpose of a count: `countEvidencedCompletedTrips` refuses on any
 * failed read, as the milestone count it replaces already did.
 *
 * KNOWN LIMIT, stated: the award fires once, on the transition to completed. A
 * check-in recorded after that transition does not reach back.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** `plan_checkins.status` values that follow an arrival (2302's vocabulary). */
export const TRIP_PRESENCE_CHECKIN_STATUSES: ReadonlySet<string> = new Set(["arrived", "late", "left"]);

/** `passport_stamps.verification_level` values that record a verified fix. */
export const TRIP_PRESENCE_STAMP_LEVELS: ReadonlySet<string> = new Set(["checkin", "gps"]);

type Row = Record<string, unknown>;

function checkinIsArrival(row: Row): boolean {
  return (
    typeof row.status === "string" &&
    TRIP_PRESENCE_CHECKIN_STATUSES.has(row.status) &&
    row.checked_in_at != null &&
    row.checked_in_at !== ""
  );
}

function stampIsVerifiedFix(row: Row): boolean {
  return typeof row.verification_level === "string" && TRIP_PRESENCE_STAMP_LEVELS.has(row.verification_level);
}

export interface TripPresenceEvidence {
  /** Members with occurrence evidence for this trip. */
  present: ReadonlySet<string>;
  /** Sources that could not be read; they contributed nothing to `present`. */
  unreadable: string[];
}

/**
 * Which of `memberIds` have occurrence evidence for `tripId`.
 *
 * Each source is positive evidence on its own, so a person shown present by a
 * readable source is present even when the other source failed. A person who
 * is not shown present by any readable source is not present.
 */
export async function readTripPresenceEvidence(
  sc: SupabaseClient,
  tripId: string,
  memberIds: readonly string[],
): Promise<TripPresenceEvidence> {
  const present = new Set<string>();
  const unreadable: string[] = [];
  if (!tripId || memberIds.length === 0) return { present, unreadable };
  const members = [...new Set(memberIds)];

  const [checkins, stamps] = await Promise.all([
    Promise.resolve(
      sc.from("plan_checkins").select("user_id, status, checked_in_at").eq("trip_id", tripId).in("user_id", members),
    ).catch((err: unknown) => ({ data: null, error: { message: String(err) } })),
    Promise.resolve(
      sc.from("passport_stamps").select("user_id, verification_level").eq("trip_id", tripId).in("user_id", members),
    ).catch((err: unknown) => ({ data: null, error: { message: String(err) } })),
  ]);

  if (checkins.error || !Array.isArray(checkins.data)) unreadable.push("plan_checkins");
  else for (const r of checkins.data as Row[]) if (checkinIsArrival(r) && typeof r.user_id === "string") present.add(r.user_id);

  if (stamps.error || !Array.isArray(stamps.data)) unreadable.push("passport_stamps");
  else for (const r of stamps.data as Row[]) if (stampIsVerifiedFix(r) && typeof r.user_id === "string") present.add(r.user_id);

  // Only a member can be present: a row for anybody else is ignored.
  for (const id of [...present]) if (!members.includes(id)) present.delete(id);
  return { present, unreadable };
}

/**
 * The number of the owner's completed trips the owner has occurrence evidence
 * for — the count `road_warrior` (5) and `frequent_flyer` (10) are about.
 *
 * Shaped `{ count, error }` like the supabase count read it replaces, so a
 * caller keeps its own "a failed count is not zero" handling. ANY failed read
 * is an error: a partial union would under-count, and an under-count read as a
 * number withholds a milestone exactly as a failure read as 0 did.
 */
export async function countEvidencedCompletedTrips(
  sc: SupabaseClient,
  ownerId: string,
): Promise<{ count: number | null; error: { message: string } | null }> {
  const fail = (message: string) => ({ count: null, error: { message } });
  try {
    const { data: trips, error: tripsErr } = await sc
      .from("trips").select("id").eq("owner_id", ownerId).eq("status", "completed");
    if (tripsErr || !Array.isArray(trips)) return fail(`trips: ${tripsErr?.message ?? "no rows array"}`);
    const ids = (trips as Row[]).map((t) => t.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) return { count: 0, error: null };

    const [checkins, stamps] = await Promise.all([
      sc.from("plan_checkins").select("trip_id, status, checked_in_at").eq("user_id", ownerId).in("trip_id", ids),
      sc.from("passport_stamps").select("trip_id, verification_level").eq("user_id", ownerId).in("trip_id", ids),
    ]);
    if (checkins.error || !Array.isArray(checkins.data)) return fail(`plan_checkins: ${checkins.error?.message ?? "no rows array"}`);
    if (stamps.error || !Array.isArray(stamps.data)) return fail(`passport_stamps: ${stamps.error?.message ?? "no rows array"}`);

    const evidenced = new Set<string>();
    for (const r of checkins.data as Row[]) if (checkinIsArrival(r) && typeof r.trip_id === "string") evidenced.add(r.trip_id);
    for (const r of stamps.data as Row[]) if (stampIsVerifiedFix(r) && typeof r.trip_id === "string") evidenced.add(r.trip_id);
    let n = 0;
    for (const id of ids) if (evidenced.has(id)) n++;
    return { count: n, error: null };
  } catch (err) {
    return fail(String(err));
  }
}

/**
 * Rows read in one request beyond which a page may have been cut by PostgREST's
 * max-rows (1,000 on this project). A chunk answering this many is treated as
 * unreadable, never as complete.
 */
export const EVIDENCE_PAGE_CEILING = 1000;
/** Source ids per request: keeps the URL short and each answer under the ceiling. */
export const EVIDENCE_CHUNK = 25;

/**
 * The same evidence, for many (person, trip) pairs at once — the READ side of
 * H4 (census-highlights-memories, wave 5 lane 5). A stamp reader holds rows
 * from many trips and many people; asking `readTripPresenceEvidence` once per
 * trip would be one round trip per row. These reads answer every pair with the
 * same `plan_checkins` arrival and the same verified `passport_stamps` levels
 * the award path requires, with the same predicates, in chunks of
 * EVIDENCE_CHUNK trips (a traveller with thousands of stamps must not become
 * one unbounded `in.(…)` URL, nor a silently cut page).
 *
 * Returns the evidenced pairs as `${userId}|${tripId}`. A source that could
 * not be read — an error, a throw, or a chunk at the page ceiling — is named
 * in `unreadable` and contributes nothing; a caller that cannot tell "no
 * evidence" from "could not look" for a pair must treat the pair as
 * unverifiable, not as absent.
 */
export async function readTripPresenceEvidenceForPairs(
  sc: SupabaseClient,
  pairs: ReadonlyArray<{ userId: string; tripId: string }>,
): Promise<{ present: ReadonlySet<string>; unreadable: string[] }> {
  const present = new Set<string>();
  const unreadable = new Set<string>();
  const wanted = new Set<string>();
  for (const p of pairs) if (p.userId && p.tripId) wanted.add(`${p.userId}|${p.tripId}`);
  if (wanted.size === 0) return { present, unreadable: [] };
  const users = [...new Set([...wanted].map((k) => k.split("|")[0]))];
  const trips = [...new Set([...wanted].map((k) => k.split("|")[1]))];
  // Narrow by person too when there are few of them (one traveller's own
  // Passport); a many-person read (a feed, the graph) filters by trip alone and
  // matches the person here, so its URL stays bounded.
  const byUser = users.length <= EVIDENCE_CHUNK;

  const take = (r: Row) => {
    const key = `${String(r.user_id)}|${String(r.trip_id)}`;
    if (wanted.has(key)) present.add(key);
  };
  for (let i = 0; i < trips.length; i += EVIDENCE_CHUNK) {
    const chunk = trips.slice(i, i + EVIDENCE_CHUNK);
    const narrow = (q: any) => (byUser ? q.in("user_id", users) : q);
    const [checkins, stamps] = await Promise.all([
      Promise.resolve(
        narrow(sc.from("plan_checkins").select("user_id, trip_id, status, checked_in_at").in("trip_id", chunk)),
      ).catch((err: unknown) => ({ data: null, error: { message: String(err) } })) as Promise<{ data: unknown; error: unknown }>,
      Promise.resolve(
        narrow(sc.from("passport_stamps").select("user_id, trip_id, verification_level").in("trip_id", chunk)),
      ).catch((err: unknown) => ({ data: null, error: { message: String(err) } })) as Promise<{ data: unknown; error: unknown }>,
    ]);
    if (checkins.error || !Array.isArray(checkins.data) || checkins.data.length >= EVIDENCE_PAGE_CEILING) unreadable.add("plan_checkins");
    else for (const r of checkins.data as Row[]) if (checkinIsArrival(r)) take(r);
    if (stamps.error || !Array.isArray(stamps.data) || stamps.data.length >= EVIDENCE_PAGE_CEILING) unreadable.add("passport_stamps");
    else for (const r of stamps.data as Row[]) if (stampIsVerifiedFix(r)) take(r);
  }
  return { present, unreadable: [...unreadable] };
}
