/**
 * Layover 165, lane B1-F — flight data and connection detection, the PURE and
 * fake-backed half (the real-schema half is src/test/db/layoverFlightConnections.db.test.ts).
 *
 * Rows: L11 (Trips owns flight segments), L21 (the session's connection
 * columns), L33 (the stored LayoverState), L259 (the flight-subject axis of the
 * replan fan-out), L267 (Trips detects the connection and passes the segments
 * into session creation), L239 (the detection stage has a producer).
 *
 * Run: node --import tsx/esm --test src/test/layoverFlightConnections.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addFlightSegmentPayload, bestKnownArrival, bestKnownDeparture, parseDesignator, recordFlightStatusPayload,
  rowToFlightSegment, type FlightSegment,
} from "../domain/trips/services/TripFlightSegments.js";
import {
  assessMissedConnection, connectionFacts, connectionTypeOf, detectConnections, LAYOVER_CONNECTION_MAX_MINUTES,
} from "../services/airport/LayoverConnectionDetection.js";
import {
  createHttpFlightStatusFeed, eventsForChanges, flightChanges, flightRecordShape, flightStatusFeedFromEnv,
  lifecycleEventFor, NO_FLIGHT_STATUS_FEED, updateFromFeed, validateFlightStatusUpdate,
  FLIGHT_STATUS_FEED_KEY_ENV, FLIGHT_STATUS_FEED_URL_ENV,
} from "../services/airport/LayoverFlightStatus.js";
import {
  flightSubjectMatches, handleEvent, impactedSessions, normalizeEvent, type LayoverEventEnvelope, type ReplanSession,
} from "../services/airport/LayoverEventReplanner.js";
import { computeReturnDeadline } from "../services/airport/LayoverSafetyEngine.js";

const H = 3_600_000;
const T0 = Date.parse("2030-06-01T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function seg(over: Partial<FlightSegment> & { id: string }): FlightSegment {
  return {
    tripId: "trip-1", legId: null, carrierCode: "BA", flightNumber: "286", designator: "BA286",
    departureAirport: "SFO", arrivalAirport: "LHR",
    scheduledDepartureAt: iso(T0), scheduledArrivalAt: iso(T0 + 10 * H),
    estimatedDepartureAt: null, estimatedArrivalAt: null,
    departureTerminal: null, arrivalTerminal: null, departureGate: null, arrivalGate: null,
    status: "unknown", statusSource: null, statusObservedAt: null, bookingRef: null, createdBy: "ana",
    ...over,
  };
}
const inbound = (over: Partial<FlightSegment> = {}) => seg({ id: "in-1", ...over });
const onward = (over: Partial<FlightSegment> = {}) => seg({
  id: "out-1", carrierCode: "BA", flightNumber: "1442", designator: "BA1442", departureAirport: "LHR", arrivalAirport: "EDI",
  scheduledDepartureAt: iso(T0 + 16 * H), scheduledArrivalAt: iso(T0 + 17.5 * H), ...over,
});

const AIRPORT = {
  id: "ap-lhr", iataCode: "LHR", timezone: "Europe/London", verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};

describe("L11 — the Trips flight segment: designators, best-known times, kernel payloads", () => {
  it("parses a designator the way 3826's CHECKs store it: carrier + canonical number, never a bare number", () => {
    assert.deepEqual(parseDesignator("ba 0286"), { carrierCode: "BA", flightNumber: "286" });
    assert.deepEqual(parseDesignator("U2-1234"), { carrierCode: "U2", flightNumber: "1234" });
    assert.deepEqual(parseDesignator("9W123"), { carrierCode: "9W", flightNumber: "123" });
    assert.deepEqual(parseDesignator("BAW286"), { carrierCode: "BAW", flightNumber: "286" });
    assert.equal(parseDesignator("286"), null, "a bare number is not a flight");
    assert.equal(parseDesignator("BA0"), null, "flight 0 does not exist");
    assert.equal(parseDesignator("BA12345"), null);
  });

  it("a best-known time says its basis: the estimate when stated, else the schedule, else UNKNOWN — never a guess", () => {
    const s = inbound();
    assert.deepEqual(bestKnownArrival(s), { at: iso(T0 + 10 * H), basis: "scheduled" });
    assert.deepEqual(bestKnownArrival({ ...s, estimatedArrivalAt: iso(T0 + 11 * H) }), { at: iso(T0 + 11 * H), basis: "estimated" });
    assert.deepEqual(bestKnownDeparture({ ...s, scheduledDepartureAt: null }), { at: null, basis: "unknown" });
  });

  it("a row with no observed status reads 'unknown', never 'scheduled' (a pre-3826 row's column is NULL)", () => {
    const r = rowToFlightSegment({ id: "x", trip_id: "t", mode: "flight", flight_status: null, carrier_code: "BA", flight_number: "1" });
    assert.equal(r.status, "unknown");
    assert.equal(r.designator, "BA1");
    assert.equal(rowToFlightSegment({ id: "x", trip_id: "t", flight_status: "bogus" }).status, "unknown");
  });

  it("ADD_TRANSPORT_SEGMENT's payload is a flight with the itinerary, and OMITS what the traveller did not state", () => {
    const p = addFlightSegmentPayload({
      carrierCode: "BA", flightNumber: "286", departureAirport: "SFO", arrivalAirport: "LHR",
      scheduledDepartureAt: iso(T0), scheduledArrivalAt: iso(T0 + 10 * H), arrivalTerminal: "5", departureGate: "  ",
    });
    assert.equal(p.mode, "flight");
    assert.equal(p.planned_departure_at, iso(T0));
    assert.equal(p.arrival_terminal, "5");
    assert.ok(!("departure_gate" in p), "a blank gate is not a statement");
    assert.ok(!("estimated_departure_at" in p) && !("flight_status" in p), "ADD carries no estimate and no status (3826 refuses them)");
  });

  it("RECORD_FLIGHT_STATUS's payload: a key present is a statement (null = unknown); a key absent says nothing", () => {
    const p = recordFlightStatusPayload("seg", "feed", iso(T0), { estimatedDepartureAt: null, departureGate: "B12" });
    assert.deepEqual(p, { segment_id: "seg", source: "feed", observed_at: iso(T0), estimated_departure_at: null, departure_gate: "B12" });
  });
});

describe("L267 / L11 — detecting a connection from the traveller's own Trips flights", () => {
  it("an inbound landing where the onward leaves, within the layover range, is DETECTED with both segments", () => {
    const [c] = detectConnections([onward(), inbound()]);
    assert.ok(c);
    assert.equal(c.status, "detected");
    assert.equal(c.airport, "LHR");
    assert.equal(c.arrivalSegment.id, "in-1");
    assert.equal(c.departureSegment.id, "out-1");
    assert.equal(c.scheduledGapMinutes, 360);
    assert.equal(c.gapMinutes, 360);
    assert.equal(c.key, "in-1:out-1");
  });

  it("not a connection: a different airport (an airport change), a gap over 24h (a stopover), or an onward that leaves first", () => {
    assert.equal(detectConnections([inbound(), onward({ departureAirport: "LGW" })]).length, 0);
    assert.equal(detectConnections([inbound(), onward({ scheduledDepartureAt: iso(T0 + 10 * H + (LAYOVER_CONNECTION_MAX_MINUTES + 1) * 60_000) })]).length, 0);
    assert.equal(detectConnections([inbound(), onward({ scheduledDepartureAt: iso(T0 + 24 * 60 * 60_000 + 10 * H) })]).length, 1, "exactly 24h is still a layover");
    assert.equal(detectConnections([inbound(), onward({ scheduledDepartureAt: iso(T0 + 9 * H), scheduledArrivalAt: iso(T0 + 9.5 * H) })]).length, 0);
  });

  it("two travellers' flights in one trip are two chains: a connection never joins two people's itineraries", () => {
    const bobOut = onward({ id: "bob-out", createdBy: "bob", scheduledDepartureAt: iso(T0 + 12 * H) });
    const found = detectConnections([inbound(), onward(), bobOut]);
    assert.deepEqual(found.map((c) => c.key), ["in-1:out-1"]);
  });

  it("paired by the SCHEDULE: a late inbound is still paired with the flight it was booked onto (that is the missed connection)", () => {
    const [c] = detectConnections([inbound({ estimatedArrivalAt: iso(T0 + 16.5 * H) }), onward()]);
    assert.equal(c!.status, "detected");
    assert.equal(c!.scheduledGapMinutes, 360);
    assert.equal(c!.gapMinutes, -30, "the best-known gap is negative: it lands after the onward leaves");
  });

  it("UNKNOWN stays unknown: a missing scheduled time makes the connection undetermined and names what is missing", () => {
    const [c] = detectConnections([inbound({ scheduledArrivalAt: null }), onward()]);
    assert.equal(c!.status, "undetermined");
    assert.deepEqual(c!.unknowns.sort(), ["inbound_arrival_unknown", "inbound_scheduled_arrival_unknown"]);
    assert.equal(c!.gapMinutes, null, "no gap is invented");
  });

  it("connection type is only what the booking references say; terminal change only when both terminals are known", () => {
    assert.equal(connectionTypeOf({ bookingRef: "abc123" }, { bookingRef: "ABC123 " }), "single_booking");
    assert.equal(connectionTypeOf({ bookingRef: "ABC123" }, { bookingRef: "XYZ999" }), "separate_bookings");
    assert.equal(connectionTypeOf({ bookingRef: null }, { bookingRef: "XYZ999" }), "unknown");
    assert.equal(detectConnections([inbound({ arrivalTerminal: "5" }), onward({ departureTerminal: "3" })])[0]!.terminalChange, true);
    assert.equal(detectConnections([inbound({ arrivalTerminal: "5" }), onward()])[0]!.terminalChange, null);
  });

  it("a detected session's facts are CONSERVATIVE where the itinerary is silent, and say so", () => {
    const f = connectionFacts({ origin: "US", connection: "GB", destination: "GB" });
    assert.equal(f.flightType, "international");
    assert.equal(f.immigrationRequired, true);
    assert.equal(f.checkedBags, true, "UNKNOWN baggage is charged (baggageChargesBags)");
    assert.ok(f.assumed.includes("baggage_unknown_charged"));
    assert.equal(connectionFacts({ origin: "US", connection: "US", destination: "US" }).flightType, "domestic");
    const unknown = connectionFacts({ origin: null, connection: "GB", destination: "GB" });
    assert.equal(unknown.flightType, "international");
    assert.ok(unknown.assumed.includes("flight_type_international_country_unknown"));
  });
});

describe("missed-connection risk — the engine's own process terms, never a new number", () => {
  const base = {
    airport: AIRPORT, flightType: "international" as const, immigrationRequired: true, checkedBags: true,
    basis: { arrival: "scheduled" as const, departure: "scheduled" as const }, boardingTime: null,
  };
  it("on_track / at_risk / missed against base + immigration + bags (traffic and time-of-day are landside terms)", () => {
    const d = computeReturnDeadline(AIRPORT, { flightType: "international", immigrationRequired: true, checkedBags: true, departureTime: iso(T0 + 16 * H), boardingTime: null });
    const process = d.breakdown.baseBuffer + d.breakdown.immigrationExtra + d.breakdown.bagsExtra + d.breakdown.liveExtra;
    assert.equal(process, 165);
    const ok = assessMissedConnection({ ...base, arrivalTime: iso(T0 + 10 * H), departureTime: iso(T0 + 16 * H) });
    assert.equal(ok.risk, "on_track");
    assert.equal(ok.processMinutes, 165);
    assert.equal(ok.connectionMinutes, 360);
    const tight = assessMissedConnection({ ...base, arrivalTime: iso(T0 + 16 * H - 150 * 60_000), departureTime: iso(T0 + 16 * H) });
    assert.equal(tight.risk, "at_risk");
    assert.equal(tight.slackMinutes, -15);
    const late = assessMissedConnection({ ...base, arrivalTime: iso(T0 + 16.5 * H), departureTime: iso(T0 + 16 * H) });
    assert.equal(late.risk, "missed");
    assert.deepEqual(late.reasons, ["inbound_lands_after_onward_cutoff"]);
  });
  it("a cancelled flight is missed; an unknown time is UNKNOWN, never on_track", () => {
    assert.equal(assessMissedConnection({ ...base, arrivalTime: iso(T0), departureTime: iso(T0 + 6 * H), departureStatus: "cancelled" }).risk, "missed");
    assert.equal(assessMissedConnection({ ...base, arrivalTime: iso(T0), departureTime: iso(T0 + 6 * H), arrivalStatus: "diverted" }).risk, "missed");
    const u = assessMissedConnection({ ...base, arrivalTime: null, departureTime: iso(T0 + 6 * H), basis: { arrival: "unknown", departure: "scheduled" } });
    assert.equal(u.risk, "unknown");
    assert.deepEqual(u.reasons, ["inbound_arrival_unknown"]);
  });
  it("the cutoff is boarding when known: a boarding call earlier than departure shortens the connection", () => {
    const r = assessMissedConnection({ ...base, arrivalTime: iso(T0 + 13 * H), departureTime: iso(T0 + 16 * H), boardingTime: iso(T0 + 15.5 * H) });
    assert.equal(r.connectionMinutes, 150);
    assert.equal(r.risk, "at_risk");
  });
});

describe("L259 — the flight-subject axis of the replan fan-out, by the segment's ROLE", () => {
  const nowMs = T0 + 10.25 * H;
  const rs = (over: Partial<ReplanSession> = {}): ReplanSession => ({
    status: "active", airportRef: "LHR", arrivalFlightRef: "in-1", departureFlightRef: "out-1",
    session: {
      id: "s1", arrivalTime: iso(T0 + 10 * H), departureTime: iso(T0 + 16 * H), boardingTime: null,
      flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
    },
    ...over,
  });
  const ev = (eventType: string, ref: string, payload: Record<string, unknown> = {}): LayoverEventEnvelope => {
    const n = normalizeEvent({
      eventId: "e1", eventType, occurredAt: iso(nowMs - 60_000), source: "flight-status-feed:test", sourceEventId: `${ref}:${eventType}`,
      subjectRefs: [{ kind: "flight", ref }], payload,
    }, { receivedAtMs: nowMs });
    assert.ok(n.ok, JSON.stringify(n));
    return n.event;
  };

  it("arrival_delayed reaches the session ARRIVING on that flight; departure_delayed and gate_changed the one DEPARTING; cancelled either", () => {
    assert.equal(flightSubjectMatches(ev("flight.arrival_delayed", "in-1", { delayMinutes: 40 }), rs()), true);
    assert.equal(flightSubjectMatches(ev("flight.arrival_delayed", "out-1", { delayMinutes: 40 }), rs()), false,
      "the onward flight landing late at its destination is not this layover's business");
    assert.equal(flightSubjectMatches(ev("flight.departure_delayed", "out-1", { delayMinutes: 40 }), rs()), true);
    assert.equal(flightSubjectMatches(ev("flight.departure_delayed", "in-1", { delayMinutes: 40 }), rs()), false);
    assert.equal(flightSubjectMatches(ev("flight.gate_changed", "out-1", { gate: "B12" }), rs()), true);
    assert.equal(flightSubjectMatches(ev("flight.cancelled", "in-1"), rs()), true);
    assert.equal(flightSubjectMatches(ev("flight.cancelled", "other"), rs()), false);
    assert.equal(flightSubjectMatches(ev("flight.cancelled", "out-1"), rs({ arrivalFlightRef: undefined, departureFlightRef: undefined })), false, "an unlinked session is on no flight axis");
  });

  it("impactedSessions reports the flight axis, and a closed session is still not impacted", () => {
    const e = ev("flight.departure_delayed", "out-1", { delayMinutes: 30 });
    assert.deepEqual(impactedSessions(e, [rs()]).map((i) => i.via), ["flight_subject"]);
    assert.equal(impactedSessions(e, [rs({ status: "completed" })]).length, 0);
  });

  it("handleEvent over a flight subject: an arrival delay on the inbound shrinks the window; on the onward it moves nothing", () => {
    const e = ev("flight.arrival_delayed", "in-1", { delayMinutes: 90 });
    const r = handleEvent(e, { airport: AIRPORT, sessions: [rs()], candidates: {}, nowMs });
    assert.equal(r.impacted, 1);
    assert.equal(r.replanned.length, 1);
    assert.ok(r.replanned[0]!.diff.usableMinutesDelta < 0, `usable moved ${r.replanned[0]!.diff.usableMinutesDelta}`);
    const wrongRole = handleEvent(ev("flight.arrival_delayed", "out-1", { delayMinutes: 90 }), { airport: AIRPORT, sessions: [rs()], candidates: {}, nowMs });
    assert.equal(wrongRole.impacted, 0);
  });
});

describe("the flight-status adapter: validation, what moved, the §11 events, the §5 event", () => {
  const nowMs = T0;
  it("validates the update before reading anything: source, instant, a statement, the vocabulary, the identity", () => {
    const ok = { source: "feed" as const, observedAt: iso(nowMs), observation: { status: "delayed" as const }, flight: { carrierCode: "BA", flightNumber: "286", scheduledDepartureAt: iso(T0) } };
    assert.equal(validateFlightStatusUpdate(ok, nowMs), null);
    assert.match(String(validateFlightStatusUpdate({ ...ok, observation: {} }, nowMs)), /states nothing/);
    assert.match(String(validateFlightStatusUpdate({ ...ok, observedAt: iso(nowMs + 10 * 60_000) }, nowMs)), /future/);
    assert.match(String(validateFlightStatusUpdate({ ...ok, observation: { status: "landing" as any } }, nowMs)), /not a flight status/);
    assert.match(String(validateFlightStatusUpdate({ ...ok, flight: { carrierCode: "", flightNumber: "286", scheduledDepartureAt: iso(T0) } }, nowMs)), /names the flight/);
    assert.match(String(validateFlightStatusUpdate({ source: "traveller", observedAt: iso(nowMs), observation: { status: "delayed" } }, nowMs)), /segment and its traveller/);
  });

  it("what moved is measured on BEST-KNOWN times; a cancellation is flight.cancelled and nothing else; a terminal has no §11 event", () => {
    const before = onward();
    const after = { ...before, estimatedDepartureAt: iso(T0 + 16.75 * H), departureGate: "B12", departureTerminal: "5", status: "delayed" as const };
    const c = flightChanges(before, after);
    assert.equal(c.departureMovedMinutes, 45);
    assert.equal(c.arrivalMovedMinutes, null);
    assert.deepEqual(c.departureGate, { from: null, to: "B12" });
    assert.deepEqual(c.departureTerminal, { from: null, to: "5" });
    assert.deepEqual(eventsForChanges(after, c).map((e) => e.eventType), ["flight.departure_delayed", "flight.gate_changed"]);
    assert.equal(eventsForChanges(after, c)[0]!.payload.newDepartureTime, iso(T0 + 16.75 * H));
    const cancelled = { ...before, status: "cancelled" as const };
    assert.deepEqual(eventsForChanges(cancelled, flightChanges(before, cancelled)).map((e) => e.eventType), ["flight.cancelled"]);
  });

  it("the §5 event: cancelled onward → DEPARTURE_CANCELLED; boarding → BOARDING_STARTED; a missed or at-risk connection → MATERIAL_DISRUPTION", () => {
    const none = { from: "unknown" as const, to: "unknown" as const };
    void none;
    const base = { missedConnection: null, before: null, after: null };
    assert.equal(lifecycleEventFor("departure", { ...flightChanges(onward(), onward()), status: { from: "scheduled", to: "cancelled" } }, base), "DEPARTURE_CANCELLED");
    assert.equal(lifecycleEventFor("departure", { ...flightChanges(onward(), onward()), status: { from: "scheduled", to: "boarding" } }, base), "BOARDING_STARTED");
    assert.equal(lifecycleEventFor("arrival", flightChanges(inbound(), inbound()), { ...base, missedConnection: { risk: "missed" } as any }), "MATERIAL_DISRUPTION");
    assert.equal(lifecycleEventFor("arrival", flightChanges(inbound(), inbound()), { ...base, missedConnection: { risk: "on_track" } as any }), null);
    assert.equal(lifecycleEventFor("arrival", flightChanges(inbound(), inbound()), {
      ...base, missedConnection: { risk: "on_track" } as any,
      before: { hardReturnTime: iso(T0 + 13 * H), usableMinutes: 100, returnState: "NORMAL" },
      after: { hardReturnTime: iso(T0 + 13 * H), usableMinutes: 60, returnState: "NORMAL" },
    }), "MATERIAL_DISRUPTION", "40 usable minutes lost is material (the replanner's own threshold)");
  });
});

describe("the approved feed, behind the interface: a contract fixture, no real call", () => {
  const FIXTURE = {
    data: [
      { flight: { iata: "BA1442" }, flight_status: "active",
        departure: { iata: "LHR", terminal: "5", gate: "B12", scheduled: "2030-06-02T00:00:00+00:00", estimated: "2030-06-02T00:45:00+00:00" },
        arrival: { iata: "EDI", terminal: null, gate: null, scheduled: "2030-06-02T01:30:00+00:00", estimated: null } },
      { flight: { iata: "BA286" }, flight_status: "scheduled", departure: { iata: "SFO", scheduled: "2030-06-01T08:00:00+00:00" }, arrival: { iata: "LHR" } },
    ],
  };
  const Q = { carrierCode: "BA", flightNumber: "1442", date: "2030-06-02" };

  it("with no feed bound, every deployment today: refused by name, nothing asked", async () => {
    const r = await NO_FLIGHT_STATUS_FEED.status(Q);
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "PROVIDER_UNBOUND");
    assert.equal(NO_FLIGHT_STATUS_FEED.live, false);
    const env = flightStatusFeedFromEnv(() => undefined);
    assert.equal(env.id, "no-flight-status-feed", "no URL configured: the refusing stand-in, not an HTTP adapter");
  });

  it("an HTTP adapter without its key refuses CREDENTIAL_ABSENT and makes NO request", async () => {
    let calls = 0;
    const feed = createHttpFlightStatusFeed(
      { id: "f", urlTemplate: "https://feed.invalid/flights?f={designator}&d={date}", credentialEnv: FLIGHT_STATUS_FEED_KEY_ENV, mapper: flightRecordShape },
      { readEnv: () => undefined, fetchImpl: (async () => { calls++; throw new Error("no"); }) as any },
    );
    const r = await feed.status(Q);
    assert.equal((r as any).reason, "CREDENTIAL_ABSENT");
    assert.equal(calls, 0);
  });

  it("with a key, the fixture maps to the flight: stated fields kept, unstated null (never defaulted), status read, key in a header", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const feed = flightStatusFeedFromEnv(
      (n) => (n === FLIGHT_STATUS_FEED_URL_ENV ? "https://feed.invalid/v1/flights?flight_iata={designator}&flight_date={date}" : n === FLIGHT_STATUS_FEED_KEY_ENV ? "k-123" : undefined),
      (async (url: string, init: any) => { seen.push({ url, auth: init?.headers?.Authorization }); return new Response(JSON.stringify(FIXTURE), { status: 200 }); }) as any,
    );
    const r = await feed.status(Q);
    assert.ok(r.ok, JSON.stringify(r));
    const v = (r as any).value;
    assert.equal(seen[0]!.url, "https://feed.invalid/v1/flights?flight_iata=BA1442&flight_date=2030-06-02");
    assert.equal(seen[0]!.auth, "Bearer k-123");
    assert.equal(v.status, "departed");
    assert.equal(v.estimatedDepartureAt, "2030-06-02T00:45:00.000Z");
    assert.equal(v.estimatedArrivalAt, null, "the feed stated no arrival estimate: null, not the schedule");
    assert.equal(v.departureGate, "B12");
    assert.equal(v.arrivalTerminal, null);
    const u = updateFromFeed("f", v);
    assert.ok(!("estimatedArrivalAt" in u.observation), "an unstated estimate is OMITTED, so it never erases a traveller's statement");
    assert.equal(u.observation.departureGate, "B12");
    assert.equal(u.flight!.scheduledDepartureAt, "2030-06-02T00:00:00.000Z");
  });

  it("refusals by name: a rejected key, an unreadable body, a flight not in the answer, an unknown status is 'unknown'", async () => {
    const mk = (resp: () => Response) => createHttpFlightStatusFeed(
      { id: "f", urlTemplate: "https://feed.invalid/?k={key}&f={designator}&d={date}", credentialEnv: "K", mapper: flightRecordShape },
      { readEnv: () => "k", fetchImpl: (async () => resp()) as any },
    );
    assert.equal(((await mk(() => new Response("x", { status: 401 })).status(Q)) as any).reason, "PROVIDER_REJECTED");
    assert.equal(((await mk(() => new Response("not json", { status: 200 })).status(Q)) as any).reason, "PROVIDER_MALFORMED");
    assert.equal(((await mk(() => new Response(JSON.stringify({ data: [] }), { status: 200 })).status(Q)) as any).reason, "PROVIDER_MALFORMED");
    const odd = { data: [{ ...FIXTURE.data[0], flight_status: "holding pattern" }] };
    const r = await mk(() => new Response(JSON.stringify(odd), { status: 200 })).status(Q);
    assert.equal((r as any).value.status, "unknown", "a status this code cannot read is unknown, never scheduled");
  });
});
