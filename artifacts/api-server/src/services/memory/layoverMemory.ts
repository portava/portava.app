/**
 * A completed layover, kept as a private Memory — census-layover L275.
 *
 * Layover spec §25: *"Passport / Memories — convert a **completed** session
 * into an optional stamp/postcard/memory."* §14 of the census closed the stamp
 * half (an elected stamp, written on `completed`, never at creation). Its own
 * `W` sentence named what was left: *"there is no postcard and no memory path
 * from the layover surface."* This module is the memory path.
 *
 * WHAT THE MEMORY MAY CARRY, AND WHAT IT MAY NOT (§3 L19: Passport/Memory
 * "owns post-session durable artifacts if the user chooses; must not own
 * temporary operational location data"):
 *
 *   - the CITY and COUNTRY of the airport, and its canonical city id — the
 *     same granularity the elected Passport stamp already carries;
 *   - the layover's own window as `starts_at` / `ends_at`;
 *   - the trip it belonged to, when it belonged to one.
 *
 *   It never carries a coordinate (`location_lat` / `location_lng` are not
 *   written at all, so the column default applies), a `place_id`, a terminal,
 *   a gate, a crew, a plan stop or any of the session's operational inputs.
 *   The airport row DOES hold `lat` / `lng`; they are deliberately not read.
 *
 * PRIVATE AND UNPUBLISHED BY DEFAULT: `visibility: "only_me"`, `state: "draft"`.
 * A Memory the traveller did not compose is not shared with anyone until they
 * open it and choose to — spec §26 Phase 1 asks for private Memories, and a
 * default that publishes on the traveller's behalf would be the
 * opposite of an election.
 *
 * ONLY A COMPLETED SESSION. `cancelled` (ended early), `expired` (never closed)
 * and `active` are refused by name. The census's objection to the old stamp was
 * exactly an artifact for a layover that did not happen the way it says.
 */

/** The columns the route reads. `airport_profiles(...)` is the FK embed; lat/lng are NOT selected. */
export const LAYOVER_MEMORY_SESSION_SELECT =
  "id, user_id, status, trip_id, canonical_city_id, arrival_time, departure_time, manual_city, manual_country, manual_airport_name, manual_iata, airport_profiles(city, country, name, iata_code)";

export interface LayoverSessionForMemory {
  id: string;
  user_id: string;
  status: string;
  trip_id: string | null;
  canonical_city_id: string | null;
  arrival_time: string;
  departure_time: string;
  manual_city: string | null;
  manual_country: string | null;
  manual_airport_name: string | null;
  manual_iata: string | null;
  airport_profiles?: {
    city: string | null;
    country: string | null;
    name: string | null;
    iata_code: string | null;
  } | null;
}

export type LayoverMemoryEligibility =
  | { ok: true }
  /** Absent, or another traveller's — the same answer, so the route leaks nothing. */
  | { ok: false; code: "not_found" }
  /** The session exists and is the caller's, but did not end in a boarded flight. */
  | { ok: false; code: "not_completed"; status: string };

export function layoverMemoryEligibility(
  session: LayoverSessionForMemory | null,
  userId: string,
): LayoverMemoryEligibility {
  if (!session || session.user_id !== userId) return { ok: false, code: "not_found" };
  if (session.status !== "completed") return { ok: false, code: "not_completed", status: session.status };
  return { ok: true };
}

function clean(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t.slice(0, 120) : null;
}

/** The city and country the Memory carries: the curated airport row first, the traveller's own typing second. */
export function layoverMemoryPlace(session: LayoverSessionForMemory): { city: string | null; country: string | null } {
  const ap = session.airport_profiles ?? null;
  return {
    city: clean(ap?.city) ?? clean(session.manual_city),
    country: clean(ap?.country) ?? clean(session.manual_country),
  };
}

export function layoverMemoryTitle(session: LayoverSessionForMemory): string {
  const { city } = layoverMemoryPlace(session);
  if (city) return `Layover in ${city}`;
  const airport = clean(session.airport_profiles?.name) ?? clean(session.manual_airport_name)
    ?? clean(session.airport_profiles?.iata_code) ?? clean(session.manual_iata);
  return airport ? `Layover at ${airport}` : "Layover";
}

/**
 * The `memories` insert row. Every key is listed so a reader can see what is
 * NOT here: no `location_lat`, no `location_lng`, no `place_id`.
 */
export function layoverMemoryRow(session: LayoverSessionForMemory, ownerId: string): Record<string, unknown> {
  const { city, country } = layoverMemoryPlace(session);
  return {
    owner_id: ownerId,
    title: layoverMemoryTitle(session),
    caption: null,
    visibility: "only_me",
    allowed_user_ids: [],
    hidden_user_ids: [],
    trip_id: session.trip_id ?? null,
    canonical_location_id: session.canonical_city_id ?? null,
    location_city: city,
    location_country: country,
    starts_at: new Date(session.arrival_time).toISOString(),
    ends_at: new Date(session.departure_time).toISOString(),
    state: "draft",
  };
}

/** Keys the row must never carry — asserted by the suite, and by the route before it writes. */
export const LAYOVER_MEMORY_FORBIDDEN_KEYS = ["location_lat", "location_lng", "place_id"] as const;
