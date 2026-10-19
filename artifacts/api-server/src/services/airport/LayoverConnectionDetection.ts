/**
 * LayoverConnectionDetection — §18 `LayoverSessionService.detectFromTrip(userId,
 * tripId)`, §26.1 step 4 "Trips adapter for connection detection", Appendix B.1
 * step 1 "Trips detects HND connection and creates DETECTED session"; §25
 * "Trips: detect connection; show Layover card/status; pass flight segments
 * into session creation". Census-layover L11, L21, L239, L267 (Layover 165
 * program, lane B1-F; owner decision 2026-10-18, flight data).
 *
 * THE SOURCE IS THE TRAVELLER'S OWN ITINERARY. Trips owns the flight segments
 * (3826, domain/trips/services/TripFlightSegments.ts); this module reads them
 * through that adapter and owns what Trips must not (§3): which two flights
 * form a layover, the layover range, and whether the connection can still be
 * made. No flight feed is involved — none is licensed — and nothing here
 * fabricates a time: a flight whose times are unknown yields an UNDETERMINED
 * connection that says which time is missing.
 *
 * WHAT A CONNECTION IS, HERE (the owner's words: "an arriving and a departing
 * flight segment at the same airport with a gap in the layover range"):
 *   * two flights entered by the same person (a trip is shared; two crew
 *     members' itineraries are two chains, not one), consecutive in scheduled
 *     time;
 *   * the first ARRIVES at the airport the second DEPARTS from (IATA, exact);
 *   * the SCHEDULED gap is above zero and at most 24 hours — beyond that it is a
 *     stopover, not a layover (the IATA line, and POST /airport/sessions refuses
 *     a window over 48h anyway).
 * The pairing is by SCHEDULE (what was booked), so a delayed inbound is still
 * paired with the flight it was booked to connect to: that is exactly the case
 * missed-connection risk exists for. The risk is judged on the BEST-KNOWN times.
 *
 * MISSED-CONNECTION RISK uses the engine's own terms, never a new number
 * (Appendix C4): `computeReturnDeadline` anchors the cutoff (boarding, else
 * departure) and the buffer; an AIRSIDE transfer needs the PROCESS terms of
 * that buffer — base (security + boarding), immigration, bags, live — which is
 * precisely the set `computeReturnState` says "only remain" at
 * CONNECTION_AT_RISK. The landside terms (traffic, time of day, the ride back)
 * do not apply to a traveller who stays airside.
 *   missed     a flight is cancelled, the inbound diverted, or the inbound
 *              arrives at or after the onward cutoff;
 *   at_risk    the connection is shorter than the process terms;
 *   on_track   otherwise;
 *   unknown    a time is unknown. Never on_track by default.
 * It is conservative by construction (the base buffer is the landside return
 * buffer's, a stand-in for a minimum connection time this tree does not hold)
 * and it says so on the wire: `processMinutes` and its terms are published.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  bestKnownArrival, bestKnownDeparture, readFlightSegmentsByIds, readTripFlightSegments,
  type FlightSegment, type KnownTime, type TimeBasis,
} from "../../domain/trips/services/TripFlightSegments.js";
import { lookupByIata, upsertAirportProfile, type AirportProfile } from "./AirportProfileService.js";
import { computeReturnDeadline, type EngineAirport, type LiveConditions } from "./LayoverSafetyEngine.js";
import { baggageChargesBags } from "./LayoverConstraints.js";
import {
  createSessionWrite, readLiveConnectionSessions, readLiveSessionForConnection,
  type LayoverConnectionType, type LayoverSession, type SessionConnection,
} from "./LayoverSessionService.js";

const logger = rootLogger.child({ service: "LayoverConnectionDetection" });

/** Above zero and at most a day. Beyond 24h it is a stopover (IATA), not a layover. */
export const LAYOVER_CONNECTION_MAX_MINUTES = 24 * 60;

export type ConnectionStatus = "detected" | "undetermined";

export interface DetectedConnection {
  /** `${arrivalSegmentId}:${departureSegmentId}` — the pair, as the session stores it. */
  key: string;
  status: ConnectionStatus;
  /** Why an undetermined connection could not be judged: the missing facts, named. */
  unknowns: string[];
  airport: string;
  arrivalSegment: FlightSegment;
  departureSegment: FlightSegment;
  /** The booked gap, scheduled arrival to scheduled departure. null when either is unknown. */
  scheduledGapMinutes: number | null;
  arrival: KnownTime;
  departure: KnownTime;
  /** Best-known gap; can be ≤ 0 (the inbound now lands after the onward leaves). null when a time is unknown. */
  gapMinutes: number | null;
  connectionType: LayoverConnectionType;
  /** The inbound's arrival terminal differs from the onward's departure terminal. null = either unknown. */
  terminalChange: boolean | null;
  enteredBy: string | null;
}

const mins = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

/** What the two booking references say. Never a claim that a carrier protects the connection. */
export function connectionTypeOf(a: Pick<FlightSegment, "bookingRef">, d: Pick<FlightSegment, "bookingRef">): LayoverConnectionType {
  const x = a.bookingRef?.trim().toUpperCase() ?? "";
  const y = d.bookingRef?.trim().toUpperCase() ?? "";
  if (!x || !y) return "unknown";
  return x === y ? "single_booking" : "separate_bookings";
}

function terminalChangeOf(a: FlightSegment, d: FlightSegment): boolean | null {
  const x = a.arrivalTerminal?.trim().toUpperCase() ?? "";
  const y = d.departureTerminal?.trim().toUpperCase() ?? "";
  if (!x || !y) return null;
  return x !== y;
}

/** Chronological order by the schedule, then the best-known time; a flight with neither sorts last (it cannot be placed). */
function orderKey(s: FlightSegment): number {
  const t = s.scheduledDepartureAt ?? bestKnownDeparture(s).at;
  const ms = t ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The connections in a trip's flights. PURE. Per person who entered the
 * flights, consecutive in time; the inbound must land where the onward leaves.
 */
export function detectConnections(segments: readonly FlightSegment[]): DetectedConnection[] {
  const byPerson = new Map<string, FlightSegment[]>();
  for (const s of segments) {
    const k = s.createdBy ?? "";
    const list = byPerson.get(k) ?? [];
    list.push(s);
    byPerson.set(k, list);
  }
  const out: DetectedConnection[] = [];
  for (const list of byPerson.values()) {
    const chain = [...list].sort((p, q) => orderKey(p) - orderKey(q) || p.id.localeCompare(q.id));
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i]!;
      const d = chain[i + 1]!;
      if (!a.arrivalAirport || !d.departureAirport || a.arrivalAirport !== d.departureAirport) continue;
      const unknowns: string[] = [];
      let scheduledGap: number | null = null;
      if (a.scheduledArrivalAt && d.scheduledDepartureAt) {
        scheduledGap = mins(a.scheduledArrivalAt, d.scheduledDepartureAt);
        if (scheduledGap <= 0 || scheduledGap > LAYOVER_CONNECTION_MAX_MINUTES) continue; // not a layover: a later trip, or a stopover
      } else {
        if (!a.scheduledArrivalAt) unknowns.push("inbound_scheduled_arrival_unknown");
        if (!d.scheduledDepartureAt) unknowns.push("onward_scheduled_departure_unknown");
      }
      const arrival = bestKnownArrival(a);
      const departure = bestKnownDeparture(d);
      if (arrival.basis === "unknown") unknowns.push("inbound_arrival_unknown");
      if (departure.basis === "unknown") unknowns.push("onward_departure_unknown");
      out.push({
        key: `${a.id}:${d.id}`,
        status: scheduledGap === null || arrival.at === null || departure.at === null ? "undetermined" : "detected",
        unknowns: [...new Set(unknowns)],
        airport: a.arrivalAirport,
        arrivalSegment: a,
        departureSegment: d,
        scheduledGapMinutes: scheduledGap,
        arrival,
        departure,
        gapMinutes: arrival.at && departure.at ? mins(arrival.at, departure.at) : null,
        connectionType: connectionTypeOf(a, d),
        terminalChange: terminalChangeOf(a, d),
        enteredBy: a.createdBy,
      });
    }
  }
  return out;
}

// ── missed-connection risk ───────────────────────────────────────────────────

export type MissedConnectionRisk = "on_track" | "at_risk" | "missed" | "unknown";

export interface MissedConnectionAssessment {
  risk: MissedConnectionRisk;
  /** Best-known arrival to the onward CUTOFF (boarding when known, else departure). */
  connectionMinutes: number | null;
  /** The engine's process terms an airside transfer still needs. */
  processMinutes: number | null;
  processTerms: { baseBuffer: number; immigrationExtra: number; bagsExtra: number; liveExtra: number } | null;
  slackMinutes: number | null;
  basis: { arrival: TimeBasis; departure: TimeBasis };
  reasons: string[];
}

export interface MissedConnectionInput {
  airport: EngineAirport;
  /** Best-known times; the facts the engine charges for. */
  arrivalTime: string | null;
  departureTime: string | null;
  boardingTime?: string | null;
  flightType: "domestic" | "international";
  immigrationRequired: boolean;
  checkedBags: boolean;
  basis: { arrival: TimeBasis; departure: TimeBasis };
  arrivalStatus?: string | null;
  departureStatus?: string | null;
  live?: LiveConditions | null;
}

export function assessMissedConnection(i: MissedConnectionInput): MissedConnectionAssessment {
  const base = { connectionMinutes: null, processMinutes: null, processTerms: null, slackMinutes: null, basis: i.basis };
  if (i.departureStatus === "cancelled") return { ...base, risk: "missed", reasons: ["onward_cancelled"] };
  if (i.arrivalStatus === "cancelled") return { ...base, risk: "missed", reasons: ["inbound_cancelled"] };
  if (i.arrivalStatus === "diverted") return { ...base, risk: "missed", reasons: ["inbound_diverted"] };
  const reasons: string[] = [];
  if (!i.arrivalTime || i.basis.arrival === "unknown") reasons.push("inbound_arrival_unknown");
  if (!i.departureTime || i.basis.departure === "unknown") reasons.push("onward_departure_unknown");
  if (reasons.length > 0) return { ...base, risk: "unknown", reasons };
  const deadline = computeReturnDeadline(i.airport, {
    flightType: i.flightType, immigrationRequired: i.immigrationRequired, checkedBags: i.checkedBags,
    departureTime: i.departureTime!, boardingTime: i.boardingTime ?? null,
  }, i.live ?? null);
  const b = deadline.breakdown;
  const processTerms = { baseBuffer: b.baseBuffer, immigrationExtra: b.immigrationExtra, bagsExtra: b.bagsExtra, liveExtra: b.liveExtra };
  const processMinutes = b.baseBuffer + b.immigrationExtra + b.bagsExtra + b.liveExtra;
  const arrivalMs = Date.parse(i.arrivalTime!);
  const connectionMinutes = Math.round((deadline.cutoffMs - arrivalMs) / 60_000);
  const slackMinutes = connectionMinutes - processMinutes;
  if (connectionMinutes <= 0) {
    return { risk: "missed", connectionMinutes, processMinutes, processTerms, slackMinutes, basis: i.basis, reasons: ["inbound_lands_after_onward_cutoff"] };
  }
  if (slackMinutes < 0) {
    return { risk: "at_risk", connectionMinutes, processMinutes, processTerms, slackMinutes, basis: i.basis, reasons: ["shorter_than_process_buffer"] };
  }
  return { risk: "on_track", connectionMinutes, processMinutes, processTerms, slackMinutes, basis: i.basis, reasons: [] };
}

// ── the facts a detected session is born with ────────────────────────────────

export interface ConnectionFacts {
  flightType: "domestic" | "international";
  immigrationRequired: boolean;
  checkedBags: boolean;
  /** Each fact the itinerary does not state and is therefore taken at its CONSERVATIVE reading, named. */
  assumed: string[];
}

/**
 * International when any of the three airports (inbound origin, the connection,
 * onward destination) is in another country. A country that cannot be read is
 * taken as international: the larger buffers, never the smaller. Immigration is
 * charged on an international connection (leaving the airport needs it), and
 * bags as §12.1's UNKNOWN: `baggageChargesBags("UNKNOWN")`. The traveller
 * declares the truth afterwards (PUT /airport/sessions/:id/constraints).
 */
export function connectionFacts(countries: { origin: string | null; connection: string | null; destination: string | null }): ConnectionFacts {
  const assumed: string[] = [];
  const known = [countries.origin, countries.connection, countries.destination];
  let flightType: "domestic" | "international";
  if (known.some((c) => !c)) { flightType = "international"; assumed.push("flight_type_international_country_unknown"); }
  else flightType = new Set(known).size > 1 ? "international" : "domestic";
  const immigrationRequired = flightType === "international";
  if (immigrationRequired) assumed.push("immigration_required_assumed");
  assumed.push("baggage_unknown_charged");
  return { flightType, immigrationRequired, checkedBags: baggageChargesBags("UNKNOWN"), assumed };
}

// ── I/O: detectFromTrip and the session it creates ───────────────────────────

type AirportRead = { ok: true; airport: AirportProfile | null } | { ok: false };

async function readAirport(db: SupabaseClient, iata: string | null, cache: Map<string, AirportRead>): Promise<AirportRead> {
  if (!iata) return { ok: true, airport: null };
  const hit = cache.get(iata);
  if (hit) return hit;
  const looked = await lookupByIata(db, iata);
  const r: AirportRead = looked.kind === "degraded" ? { ok: false } : { ok: true, airport: looked.value.airport };
  cache.set(iata, r);
  return r;
}

function engineAirport(a: AirportProfile): EngineAirport {
  return {
    timezone: a.timezone, verified: a.verified,
    domesticBufferMin: a.domesticBufferMin, internationalBufferMin: a.internationalBufferMin,
    immigrationExtraMin: a.immigrationExtraMin, checkedBagsExtraMin: a.checkedBagsExtraMin, trafficExtraMin: a.trafficExtraMin,
  };
}

export interface TripConnectionView extends DetectedConnection {
  missedConnection: MissedConnectionAssessment;
  facts: ConnectionFacts | null;
  /** The traveller's own live session for this connection, if one was started. */
  session: Pick<SessionConnection, "sessionId" | "status" | "state"> | null;
}

export type DetectFromTripResult =
  | { ok: true; connections: TripConnectionView[]; degradedReasons: string[] }
  | { ok: false; reason: "segments_unreadable" | "sessions_unreadable"; message: string };

/** §18 detectFromTrip: the trip's connections, each with its risk and the traveller's session for it. */
export async function detectFromTrip(db: SupabaseClient, userId: string, tripId: string): Promise<DetectFromTripResult> {
  const read = await readTripFlightSegments(db, tripId);
  if (!read.ok) return { ok: false, reason: "segments_unreadable", message: read.message };
  const connections = detectConnections(read.segments);
  const sessions = await readLiveConnectionSessions(db, userId, read.segments.map((s) => s.id));
  if (!sessions.ok) return { ok: false, reason: "sessions_unreadable", message: sessions.message };
  const cache = new Map<string, AirportRead>();
  const degraded = new Set<string>();
  const out: TripConnectionView[] = [];
  for (const c of connections) {
    const session = sessions.connections.find((s) => s.arrivalSegmentId === c.arrivalSegment.id && s.departureSegmentId === c.departureSegment.id) ?? null;
    const [hub, origin, destination] = [
      await readAirport(db, c.airport, cache),
      await readAirport(db, c.arrivalSegment.departureAirport, cache),
      await readAirport(db, c.departureSegment.arrivalAirport, cache),
    ];
    if (!hub.ok || !origin.ok || !destination.ok) degraded.add("airport_profiles_unreadable");
    const facts = hub.ok && hub.airport
      ? connectionFacts({
          origin: origin.ok ? origin.airport?.countryCode ?? null : null,
          connection: hub.airport.countryCode ?? null,
          destination: destination.ok ? destination.airport?.countryCode ?? null : null,
        })
      : null;
    const missedConnection = hub.ok && hub.airport && facts
      ? assessMissedConnection({
          airport: engineAirport(hub.airport), arrivalTime: c.arrival.at, departureTime: c.departure.at,
          flightType: facts.flightType, immigrationRequired: facts.immigrationRequired, checkedBags: facts.checkedBags,
          basis: { arrival: c.arrival.basis, departure: c.departure.basis },
          arrivalStatus: c.arrivalSegment.status, departureStatus: c.departureSegment.status,
        })
      : { risk: "unknown" as const, connectionMinutes: null, processMinutes: null, processTerms: null, slackMinutes: null,
          basis: { arrival: c.arrival.basis, departure: c.departure.basis }, reasons: [hub.ok ? "connection_airport_unknown" : "airport_profiles_unreadable"] };
    out.push({ ...c, missedConnection, facts, session: session ? { sessionId: session.sessionId, status: session.status, state: session.state } : null });
  }
  return { ok: true, connections: out, degradedReasons: [...degraded] };
}

export type StartConnectionRefusal =
  | "segments_unreadable" | "not_a_connection" | "undetermined" | "airport_unknown" | "airport_unreadable"
  | "already_departed" | "connection_missed" | "window_too_long" | "write_failed";

export type StartConnectionResult =
  | { ok: true; session: LayoverSession; existed: boolean; connection: TripConnectionView | DetectedConnection; facts: ConnectionFacts }
  | { ok: false; reason: StartConnectionRefusal; message: string; unknowns?: string[] };

const REFUSE = (reason: StartConnectionRefusal, message: string, unknowns?: string[]): StartConnectionResult => ({ ok: false, reason, message, ...(unknowns ? { unknowns } : {}) });

/**
 * Pass the flight segments into session creation (§25). The server RE-READS
 * both segments and RE-DETECTS the pair: a client's word that two flights form a
 * connection is never taken, and the session's times are the segments' best-
 * known times, never typed. Idempotent per traveller per connection (3827's
 * unique pair): a second tap returns the session the first one started.
 */
export async function startConnectionSession(
  db: SupabaseClient,
  args: { userId: string; tripId: string; arrivalSegmentId: string; departureSegmentId: string; nowMs: number },
): Promise<StartConnectionResult> {
  const pair = await readFlightSegmentsByIds(db, [args.arrivalSegmentId, args.departureSegmentId]);
  if (!pair.ok) return REFUSE("segments_unreadable", "This trip's flights could not be loaded. Please try again.");
  const inTrip = pair.segments.filter((s) => s.tripId === args.tripId);
  const c = detectConnections(inTrip).find((x) => x.arrivalSegment.id === args.arrivalSegmentId && x.departureSegment.id === args.departureSegmentId);
  if (!c) return REFUSE("not_a_connection", "These two flights are not a connection: the first must land where the second leaves, within 24 hours.");
  if (c.status !== "detected") return REFUSE("undetermined", "A time on one of these flights is unknown. Add it to the flight first.", c.unknowns);

  const existing = await readLiveSessionForConnection(db, args.userId, args.arrivalSegmentId, args.departureSegmentId);
  if (!existing.ok) return REFUSE("write_failed", "Your layover could not be started. Please try again.");

  const cache = new Map<string, AirportRead>();
  const hub = await readAirport(db, c.airport, cache);
  if (!hub.ok) return REFUSE("airport_unreadable", "Airport details could not be loaded. Please try again.");
  if (!hub.airport || hub.airport.iataCode === "UNK") return REFUSE("airport_unknown", `We do not know the airport ${c.airport}.`);
  const origin = await readAirport(db, c.arrivalSegment.departureAirport, cache);
  const destination = await readAirport(db, c.departureSegment.arrivalAirport, cache);
  const facts = connectionFacts({
    origin: origin.ok ? origin.airport?.countryCode ?? null : null,
    connection: hub.airport.countryCode ?? null,
    destination: destination.ok ? destination.airport?.countryCode ?? null : null,
  });
  if (existing.session) return { ok: true, session: existing.session, existed: true, connection: c, facts };

  const arrivalMs = Date.parse(c.arrival.at!);
  const departureMs = Date.parse(c.departure.at!);
  if (departureMs <= args.nowMs) return REFUSE("already_departed", "The onward flight of this connection has already left.");
  if (departureMs <= arrivalMs) return REFUSE("connection_missed", "On the latest times, the first flight lands after the second one leaves.");
  if (departureMs - arrivalMs > 48 * 3_600_000) return REFUSE("window_too_long", "A layover window cannot exceed 48 hours.");

  let airport = hub.airport;
  if (!airport.id) {
    const up = await upsertAirportProfile(db, args.userId, airport as any);
    if (up.ok && up.id) airport = { ...airport, id: up.id };
  }
  const created = await createSessionWrite(db, {
    userId: args.userId,
    airportId: airport.id ?? null,
    tripId: args.tripId,
    arrivalTime: new Date(arrivalMs).toISOString(),
    departureTime: new Date(departureMs).toISOString(),
    boardingTime: null,
    flightType: facts.flightType,
    immigrationRequired: facts.immigrationRequired,
    checkedBags: facts.checkedBags,
    manualAirportName: airport.name ?? null,
    manualCity: airport.city ?? null,
    manualCountry: airport.country ?? null,
    manualIata: airport.iataCode ?? c.airport,
    connection: { arrivalSegmentId: c.arrivalSegment.id, departureSegmentId: c.departureSegment.id, connectionType: c.connectionType },
  });
  if (!created.ok || !created.session) {
    // A concurrent tap may have won the unique pair; its session is the answer.
    const again = await readLiveSessionForConnection(db, args.userId, args.arrivalSegmentId, args.departureSegmentId);
    if (again.ok && again.session) return { ok: true, session: again.session, existed: true, connection: c, facts };
    logger.warn({ tripId: args.tripId, reason: created.ok ? "no row" : created.message }, "connection session insert failed");
    return REFUSE("write_failed", "Your layover could not be started. Please try again.");
  }
  return { ok: true, session: created.session, existed: false, connection: c, facts };
}
