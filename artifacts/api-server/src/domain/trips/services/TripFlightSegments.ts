/**
 * TripFlightSegments — the Trips flight-segment model (Layover spec §3: "Trips
 * owns flight segments, itinerary relationships, user trip context"; census-
 * layover L11). Migration 3826 made a flight first-class on the Trips §15.1
 * transport segment (`trip_transport_segments`, mode 'flight'): the designator,
 * the airports, the SCHEDULED pair (2782's planned_departure_at /
 * planned_arrival_at), the ESTIMATED pair, terminals, gates and a status with
 * its source and the instant it was observed.
 *
 * WHAT LIVES HERE: the row shape, the reads, the designator rules, the kernel
 * payloads, and "the best known time" WITH the basis it was read from. Writes
 * go through the Trip Kernel only (ADD_TRANSPORT_SEGMENT, RECORD_FLIGHT_STATUS).
 *
 * WHAT DOES NOT (§3, "must not own layover safety calculations"): connection
 * detection, the layover range, the certified deadline and missed-connection
 * risk are the Layover domain's (services/airport/LayoverConnectionDetection.ts,
 * services/airport/LayoverFlightStatus.ts). Nothing in this file computes a
 * buffer, a deadline or a risk.
 *
 * UNKNOWN STAYS UNKNOWN. An estimate nobody stated is `null`, never the
 * scheduled time; a flight nobody observed has status "unknown"; a best-known
 * time says whether it is an ESTIMATE, the SCHEDULE, or UNKNOWN.
 */

/** 3826's CHECK vocabulary, spelled once. "unknown" is a member, not an absence. */
export const FLIGHT_STATUSES = ["unknown", "scheduled", "delayed", "boarding", "departed", "landed", "cancelled", "diverted"] as const;
export type FlightStatus = (typeof FLIGHT_STATUSES)[number];
export const FLIGHT_STATUS_SOURCES = ["traveller", "feed"] as const;
export type FlightStatusSource = (typeof FLIGHT_STATUS_SOURCES)[number];

export function isFlightStatus(v: unknown): v is FlightStatus {
  return typeof v === "string" && (FLIGHT_STATUSES as readonly string[]).includes(v);
}

/** One flight of a trip, as Trips holds it. Every field that can be unknown is nullable and says so. */
export interface FlightSegment {
  id: string;
  tripId: string;
  legId: string | null;
  carrierCode: string | null;
  flightNumber: string | null;
  /** "BA286", or null when either half is unknown. */
  designator: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  scheduledDepartureAt: string | null;
  scheduledArrivalAt: string | null;
  estimatedDepartureAt: string | null;
  estimatedArrivalAt: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  departureGate: string | null;
  arrivalGate: string | null;
  /** "unknown" when nothing was observed — including a pre-3826 row, whose column is NULL. */
  status: FlightStatus;
  statusSource: FlightStatusSource | null;
  statusObservedAt: string | null;
  bookingRef: string | null;
  createdBy: string | null;
}

/** The columns a flight read names. 2782's plus 3826's. */
export const FLIGHT_SEGMENT_COLUMNS =
  "id, trip_id, leg_id, mode, carrier_code, flight_number, departure_airport_iata, arrival_airport_iata, planned_departure_at, planned_arrival_at, estimated_departure_at, estimated_arrival_at, departure_terminal, arrival_terminal, departure_gate, arrival_gate, flight_status, flight_status_source, flight_status_observed_at, booking_ref, created_by";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function rowToFlightSegment(row: Record<string, unknown>): FlightSegment {
  const carrierCode = str(row.carrier_code);
  const flightNumber = str(row.flight_number);
  const status = isFlightStatus(row.flight_status) ? row.flight_status : "unknown";
  const source = row.flight_status_source === "traveller" || row.flight_status_source === "feed" ? row.flight_status_source : null;
  return {
    id: String(row.id),
    tripId: String(row.trip_id),
    legId: str(row.leg_id),
    carrierCode,
    flightNumber,
    designator: carrierCode && flightNumber ? carrierCode + flightNumber : null,
    departureAirport: str(row.departure_airport_iata),
    arrivalAirport: str(row.arrival_airport_iata),
    scheduledDepartureAt: str(row.planned_departure_at),
    scheduledArrivalAt: str(row.planned_arrival_at),
    estimatedDepartureAt: str(row.estimated_departure_at),
    estimatedArrivalAt: str(row.estimated_arrival_at),
    departureTerminal: str(row.departure_terminal),
    arrivalTerminal: str(row.arrival_terminal),
    departureGate: str(row.departure_gate),
    arrivalGate: str(row.arrival_gate),
    status,
    statusSource: source,
    statusObservedAt: str(row.flight_status_observed_at),
    bookingRef: str(row.booking_ref),
    createdBy: str(row.created_by),
  };
}

export type FlightSegmentsRead =
  | { ok: true; segments: FlightSegment[] }
  | { ok: false; message: string };

/** A trip's flights. A failed read is `ok: false`, never "this trip has no flights". */
export async function readTripFlightSegments(sc: any, tripId: string): Promise<FlightSegmentsRead> {
  const { data, error } = await sc
    .from("trip_transport_segments")
    .select(FLIGHT_SEGMENT_COLUMNS)
    .eq("trip_id", tripId)
    .eq("mode", "flight")
    .order("planned_departure_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false, message: String(error.message ?? "trip_transport_segments unreadable") };
  return { ok: true, segments: ((data ?? []) as Record<string, unknown>[]).map(rowToFlightSegment) };
}

/** Flights by id, any trip — the caller has established why it may ask (a session's own segments). */
export async function readFlightSegmentsByIds(sc: any, ids: string[]): Promise<FlightSegmentsRead> {
  const want = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (want.length === 0) return { ok: true, segments: [] };
  const { data, error } = await sc
    .from("trip_transport_segments")
    .select(FLIGHT_SEGMENT_COLUMNS)
    .in("id", want.slice(0, 50))
    .eq("mode", "flight")
    .limit(50);
  if (error) return { ok: false, message: String(error.message ?? "trip_transport_segments unreadable") };
  return { ok: true, segments: ((data ?? []) as Record<string, unknown>[]).map(rowToFlightSegment) };
}

/**
 * The Trips flights that carry one designator with a scheduled departure inside
 * [fromIso, toIso] — how an approved feed's flight identity (designator + date)
 * is resolved to the segments it describes (3826's idx_trip_transport_segments_flight).
 * A segment whose scheduled departure is unknown cannot be matched to a dated
 * feed record and is not returned.
 */
export async function findFlightSegmentsByDesignator(
  sc: any,
  q: { carrierCode: string; flightNumber: string; fromIso: string; toIso: string; limit?: number },
): Promise<FlightSegmentsRead> {
  const { data, error } = await sc
    .from("trip_transport_segments")
    .select(FLIGHT_SEGMENT_COLUMNS)
    .eq("mode", "flight")
    .eq("carrier_code", q.carrierCode)
    .eq("flight_number", q.flightNumber)
    .gte("planned_departure_at", q.fromIso)
    .lte("planned_departure_at", q.toIso)
    .limit(q.limit ?? 200);
  if (error) return { ok: false, message: String(error.message ?? "trip_transport_segments unreadable") };
  return { ok: true, segments: ((data ?? []) as Record<string, unknown>[]).map(rowToFlightSegment) };
}

// ── designators ──────────────────────────────────────────────────────────────

/**
 * The carrier half of lib/providers/flightItineraryProvider.ts's DESIGNATOR_RE,
 * and 3826's CHECK: three ICAO letters, or two IATA characters that are not both
 * digits (the contract test that caught "286" read as carrier "28" is why).
 */
const CARRIER_RE = /^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])$/;
const DESIGNATOR_RE = /^((?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z]))(\d{1,4})$/;

/** "ba 0286" → { BA, 286 }; anything that is not a designator → null. Leading zeros are not part of a flight number. */
export function parseDesignator(raw: unknown): { carrierCode: string; flightNumber: string } | null {
  if (typeof raw !== "string") return null;
  const canon = raw.replace(/[\s-]/g, "").toUpperCase();
  const m = DESIGNATOR_RE.exec(canon);
  if (!m) return null;
  const n = String(Number(m[2]));
  if (n === "0") return null;
  return { carrierCode: m[1]!, flightNumber: n };
}

export function isCarrierCode(raw: unknown): raw is string {
  return typeof raw === "string" && CARRIER_RE.test(raw);
}

// ── best known times, with their basis ───────────────────────────────────────

export type TimeBasis = "estimated" | "scheduled" | "unknown";
export interface KnownTime { at: string | null; basis: TimeBasis }

function known(estimated: string | null, scheduled: string | null): KnownTime {
  if (estimated && Number.isFinite(Date.parse(estimated))) return { at: new Date(Date.parse(estimated)).toISOString(), basis: "estimated" };
  if (scheduled && Number.isFinite(Date.parse(scheduled))) return { at: new Date(Date.parse(scheduled)).toISOString(), basis: "scheduled" };
  return { at: null, basis: "unknown" };
}

/** The departure the trip knows best: the latest observation's estimate, else the schedule, else UNKNOWN (never a guess). */
export function bestKnownDeparture(s: Pick<FlightSegment, "estimatedDepartureAt" | "scheduledDepartureAt">): KnownTime {
  return known(s.estimatedDepartureAt, s.scheduledDepartureAt);
}

/** The arrival the trip knows best. See bestKnownDeparture. */
export function bestKnownArrival(s: Pick<FlightSegment, "estimatedArrivalAt" | "scheduledArrivalAt">): KnownTime {
  return known(s.estimatedArrivalAt, s.scheduledArrivalAt);
}

// ── the kernel payloads ──────────────────────────────────────────────────────

export interface FlightItineraryInput {
  carrierCode: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  /** UTC instants, already converted from each airport's local wall time by the caller. */
  scheduledDepartureAt: string;
  scheduledArrivalAt: string;
  departureTerminal?: string | null;
  arrivalTerminal?: string | null;
  departureGate?: string | null;
  arrivalGate?: string | null;
  bookingRef?: string | null;
  legId?: string | null;
}

/** ADD_TRANSPORT_SEGMENT for a flight. Optional facts the traveller did not state are OMITTED, not sent as guesses. */
export function addFlightSegmentPayload(input: FlightItineraryInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    mode: "flight",
    carrier_code: input.carrierCode,
    flight_number: input.flightNumber,
    departure_airport_iata: input.departureAirport,
    arrival_airport_iata: input.arrivalAirport,
    from_label: input.departureAirport,
    to_label: input.arrivalAirport,
    planned_departure_at: input.scheduledDepartureAt,
    planned_arrival_at: input.scheduledArrivalAt,
  };
  const opt: Array<[string, string | null | undefined]> = [
    ["departure_terminal", input.departureTerminal], ["arrival_terminal", input.arrivalTerminal],
    ["departure_gate", input.departureGate], ["arrival_gate", input.arrivalGate],
    ["booking_ref", input.bookingRef], ["leg_id", input.legId],
  ];
  for (const [k, v] of opt) if (typeof v === "string" && v.trim().length > 0) p[k] = v.trim();
  return p;
}

/**
 * What one observation STATES about a flight. A key present is a statement —
 * `null` included, which records "unknown" — and a key absent says nothing, so
 * the segment keeps what it had (3826's RECORD_FLIGHT_STATUS contract).
 */
export interface FlightObservation {
  estimatedDepartureAt?: string | null;
  estimatedArrivalAt?: string | null;
  departureTerminal?: string | null;
  arrivalTerminal?: string | null;
  departureGate?: string | null;
  arrivalGate?: string | null;
  status?: FlightStatus | null;
}

const OBSERVATION_KEYS: Array<[keyof FlightObservation, string]> = [
  ["estimatedDepartureAt", "estimated_departure_at"], ["estimatedArrivalAt", "estimated_arrival_at"],
  ["departureTerminal", "departure_terminal"], ["arrivalTerminal", "arrival_terminal"],
  ["departureGate", "departure_gate"], ["arrivalGate", "arrival_gate"], ["status", "flight_status"],
];

/** Does this observation state anything? An empty one is refused by the kernel; better to know first. */
export function observationStatesAnything(o: FlightObservation): boolean {
  return OBSERVATION_KEYS.some(([k]) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined);
}

/** RECORD_FLIGHT_STATUS. `source` must be the actor's own: traveller for a user, feed for the system actor. */
export function recordFlightStatusPayload(segmentId: string, source: FlightStatusSource, observedAt: string, o: FlightObservation): Record<string, unknown> {
  const p: Record<string, unknown> = { segment_id: segmentId, source, observed_at: observedAt };
  for (const [k, col] of OBSERVATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined) p[col] = o[k];
  }
  return p;
}
