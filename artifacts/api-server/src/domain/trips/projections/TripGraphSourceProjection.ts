/**
 * The trip facts the Compass intelligence graph is built from — a Trips-owned,
 * typed SOURCE contract (census-compass CT-02, Trips `:25`).
 *
 * compass/CompassGraphEngine.ts read `trips` twice with its own literal: once in
 * the batch build (person —took_trip→ trip —destination→ city, ≥2 trips to a city
 * → returned_to) and once in the revocation reconcile, which must read the SAME
 * columns with the SAME predicates or it judges edges against a different world
 * than the one that wrote them (compassGraphRevocation.test.ts case P). Both now
 * read through `tripGraphSourceRows` — one literal, here — and the build types
 * every row through `toTripGraphSourceFact` before it derives anything from it.
 *
 * WHAT TRIPS STATES HERE, AND WHAT THE GRAPH STILL DECIDES
 * =======================================================
 * Trips states what a trip's destination fact IS: its id, its owner, its
 * destination city as stored, its dates as stored, its destination coordinates.
 * A row that is not one (no id, a column of the wrong type) is not a fact and the
 * build skips it — as it skipped a row with no owner. City canonicalisation,
 * edge vocabulary and the ≥2 rule stay the graph's: they are graph semantics.
 *
 * WHY THE READ RETURNS A QUERY, NOT ROWS — AND WHY THERE IS NO §19.1 ENVELOPE
 * ===========================================================================
 * The graph reads trips in BULK, in pages, anchored by owner or by id, with its
 * own completeness accounting (`readAllPages`: a page that failed and a read that
 * hit its bound are both "not complete", never "absent"). That machinery, and the
 * replay that iterates the rows to the end, belong to the graph; so the shared
 * read is the builder the graph pages over, exactly as its `circleSourceRows`
 * is for circles. A §19.1 envelope describes one trip aggregate's state for a
 * consumer that may reject it as stale; a world-graph rebuild over every trip is
 * not that consumer, and stamping `trips.version` on 5,000 rows it never compares
 * would be decoration. The select list is therefore unchanged from the graph's.
 *
 * NOT PURE — `tripGraphSourceRows` builds a read of `trips`. Nothing here writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** A trip's destination fact, as the graph may derive from it. */
export interface TripGraphSourceFact {
  tripId: string;
  ownerId: string | null;
  /** As stored; the graph canonicalises it. */
  destinationCity: string | null;
  startDate: string | null;
  endDate: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
}

/**
 * The ONE literal read of `trips` the graph's build and its reconcile both page
 * over. The caller adds its anchor (`.in("owner_id", …)`, `.in("id", …)`) and
 * its bound (`.limit`, or `.order().range()`).
 */
export function tripGraphSourceRows(db: SupabaseClient) {
  return db
    .from("trips")
    .select("id, owner_id, destination_city, start_date, end_date, destination_lat, destination_lng");
}

function textOrNull(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : false;
}

function coordinateOrNull(value: unknown): number | null | false {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

/** A source row, typed — or null when it is not a trip's destination fact. */
export function toTripGraphSourceFact(value: unknown): TripGraphSourceFact | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  const ownerId = textOrNull(row.owner_id);
  const destinationCity = textOrNull(row.destination_city);
  const startDate = textOrNull(row.start_date);
  const endDate = textOrNull(row.end_date);
  const destinationLat = coordinateOrNull(row.destination_lat);
  const destinationLng = coordinateOrNull(row.destination_lng);
  if (ownerId === false || destinationCity === false || startDate === false || endDate === false
    || destinationLat === false || destinationLng === false) return null;
  return { tripId: row.id, ownerId, destinationCity, startDate, endDate, destinationLat, destinationLng };
}
