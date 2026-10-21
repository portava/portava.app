/**
 * Trips × Layover: the trip's flights and the layovers between them (Layover
 * spec §3 "Trips owns flight segments", §25 "Trips: detect connection; show
 * Layover card/status; pass flight segments into session creation"; census-
 * layover L11, L267).
 *
 *   GET  /trips/:tripId/flight-segments                 the trip's flights
 *   POST /trips/:tripId/flight-segments                 add a flight (local times at each airport)
 *   GET  /trips/:tripId/layover-connections             the connections, their risk, my session
 *   POST /trips/:tripId/layover-connections             start the layover for one connection
 *   POST /trips/:tripId/flight-segments/:id/status      what I see at the airport (gate, delay, ...)
 *
 * The server owns every judgement: which two flights connect, the gap, the
 * risk, the session's times. This file only carries the answers, and keeps the
 * three states apart (shared/tripApi.ts): a refusal is named, an unreachable
 * server is "unavailable", a gate that is off is "off" and draws nothing.
 */
import { readTripJson, sendTripWrite, type ApiRead, type ApiWrite } from '../shared/tripApi.ts';

export type TimeBasis = 'estimated' | 'scheduled' | 'unknown';
export interface KnownTime { at: string | null; basis: TimeBasis }

export interface TripFlight {
  id: string;
  designator: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  scheduledDepartureAt: string | null;
  scheduledArrivalAt: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  departureGate: string | null;
  arrivalGate: string | null;
  status: string;
  bestKnownDeparture: KnownTime;
  bestKnownArrival: KnownTime;
}

export type MissedConnectionRisk = 'on_track' | 'at_risk' | 'missed' | 'unknown';

export interface LayoverConnection {
  key: string;
  status: 'detected' | 'undetermined';
  unknowns: string[];
  airport: string;
  arrivalSegment: TripFlight;
  departureSegment: TripFlight;
  scheduledGapMinutes: number | null;
  gapMinutes: number | null;
  connectionType: 'single_booking' | 'separate_bookings' | 'unknown';
  terminalChange: boolean | null;
  missedConnection: { risk: MissedConnectionRisk; slackMinutes: number | null; processMinutes: number | null; reasons: string[] };
  session: { sessionId: string; status: string; state: string | null } | null;
}

export interface ConnectionsBody { connections: LayoverConnection[]; degraded: boolean; degradedReasons: string[] }

const isConnections = (b: any): boolean => Boolean(b) && Array.isArray(b.connections);
const isFlights = (b: any): boolean => Boolean(b) && Array.isArray(b.segments);

export function fetchLayoverConnections(tripId: string): Promise<ApiRead<ConnectionsBody>> {
  return readTripJson<ConnectionsBody>(`/api/trips/${encodeURIComponent(tripId)}/layover-connections`, isConnections);
}

export function fetchTripFlights(tripId: string): Promise<ApiRead<{ segments: TripFlight[] }>> {
  return readTripJson<{ segments: TripFlight[] }>(`/api/trips/${encodeURIComponent(tripId)}/flight-segments`, isFlights);
}

export interface StartedLayover { session: { id: string }; existed: boolean }

/** Start the layover for one detected connection. The server re-reads both flights; nothing here is trusted. */
export function startLayoverFromConnection(tripId: string, c: Pick<LayoverConnection, 'arrivalSegment' | 'departureSegment'>): Promise<ApiWrite<StartedLayover>> {
  return sendTripWrite<StartedLayover>('POST', `/api/trips/${encodeURIComponent(tripId)}/layover-connections`, {
    arrivalSegmentId: c.arrivalSegment.id,
    departureSegmentId: c.departureSegment.id,
  });
}

export interface FlightEntry {
  flight: string;
  departureAirport: string;
  arrivalAirport: string;
  /** "YYYY-MM-DDTHH:mm" at the departure airport. */
  departureLocal: string;
  /** "YYYY-MM-DDTHH:mm" at the arrival airport. */
  arrivalLocal: string;
  departureTerminal?: string;
  arrivalTerminal?: string;
  bookingRef?: string;
}

const WALL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;
const IATA_RE = /^[A-Za-z]{3}$/;
const FLIGHT_RE = /^\s*(?:[A-Za-z]{3}|[A-Za-z][A-Za-z0-9]|[0-9][A-Za-z])[\s-]?\d{1,4}\s*$/;

/** What is wrong with an entry before it is sent, in words; null when it can be sent. Times stay the traveller's. */
export function flightEntryProblem(e: FlightEntry): string | null {
  if (!FLIGHT_RE.test(e.flight)) return 'Enter the flight as airline code and number, e.g. BA286.';
  if (!IATA_RE.test(e.departureAirport.trim()) || !IATA_RE.test(e.arrivalAirport.trim())) return 'Enter both airports as 3-letter codes, e.g. LHR.';
  if (e.departureAirport.trim().toUpperCase() === e.arrivalAirport.trim().toUpperCase()) return 'A flight lands at a different airport from the one it leaves.';
  if (!WALL_RE.test(e.departureLocal.trim()) || !WALL_RE.test(e.arrivalLocal.trim())) return 'Enter both times as YYYY-MM-DD HH:MM, each in its own airport’s local time.';
  return null;
}

/** Add one flight. `idempotencyKey` is minted once per tap and reused on a retry (shared/tripApi.ts intentKey). */
export function addTripFlight(tripId: string, e: FlightEntry, idempotencyKey: string): Promise<ApiWrite<{ segment: TripFlight }>> {
  const body: Record<string, string> = {
    flight: e.flight.trim(),
    departureAirport: e.departureAirport.trim().toUpperCase(),
    arrivalAirport: e.arrivalAirport.trim().toUpperCase(),
    departureLocal: e.departureLocal.trim().replace(' ', 'T'),
    arrivalLocal: e.arrivalLocal.trim().replace(' ', 'T'),
  };
  for (const k of ['departureTerminal', 'arrivalTerminal', 'bookingRef'] as const) {
    const v = e[k]?.trim();
    if (v) body[k] = v;
  }
  return sendTripWrite<{ segment: TripFlight }>('POST', `/api/trips/${encodeURIComponent(tripId)}/flight-segments`, body, { idempotencyKey });
}

/** The §4.1 state, in words a traveller reads. An unrecorded state says so. */
export const LAYOVER_STATE_WORDS: Record<string, string> = {
  DETECTED: 'Detected', NEEDS_INFO: 'Needs a detail from you', EVALUATING: 'Checking your time', AIRPORT_ONLY: 'Airport only',
  LANDSIDE_AVAILABLE: 'Time to go out', PLAN_SELECTED: 'Plan chosen', EXECUTING: 'Out and about', RETURN_SOON: 'Head back soon',
  RETURN_NOW: 'Head back now', RETURNING: 'Returning to the airport', AIRPORT_REENTERED: 'Back at the airport', BOARDING: 'Boarding',
  COMPLETED: 'Completed', DISRUPTED: 'Flight changed — rechecking', CANCELLED: 'Flight cancelled', ABANDONED: 'Ended', EXPIRED: 'Ended',
};

export function stateWords(state: string | null): string {
  return state ? LAYOVER_STATE_WORDS[state] ?? state : 'Status not recorded';
}

/** The risk, said plainly — with its number, so "tight" is never a mood. */
export function riskWords(m: LayoverConnection['missedConnection']): string {
  switch (m.risk) {
    case 'on_track': return 'Connection on track';
    case 'at_risk': return `Tight connection — ${Math.abs(m.slackMinutes ?? 0)} min short of this airport's transfer buffer`;
    case 'missed': return m.reasons.includes('onward_cancelled') ? 'Your onward flight is cancelled'
      : m.reasons.includes('inbound_cancelled') ? 'Your inbound flight is cancelled'
      : 'On the latest times, this connection is missed';
    default: return 'Connection risk unknown — a time is missing';
  }
}

export function bookingWords(t: LayoverConnection['connectionType']): string {
  return t === 'single_booking' ? 'One booking' : t === 'separate_bookings' ? 'Separate bookings — you may need to collect and re-check bags' : 'Booking not stated';
}

export function gapWords(minutes: number | null): string {
  if (minutes === null) return 'gap unknown';
  const sign = minutes < 0 ? '−' : '';
  const m = Math.abs(minutes);
  return `${sign}${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const UNKNOWN_WORDS: Record<string, string> = {
  inbound_scheduled_arrival_unknown: 'the arriving flight’s scheduled landing',
  onward_scheduled_departure_unknown: 'the next flight’s scheduled departure',
  inbound_arrival_unknown: 'when the arriving flight lands',
  onward_departure_unknown: 'when the next flight leaves',
};
export function unknownWords(unknowns: string[]): string {
  return unknowns.map((u) => UNKNOWN_WORDS[u] ?? u.replace(/_/g, ' ')).join('; ');
}
