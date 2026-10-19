/**
 * census-layover L239 / L267 (Layover 165, lane B1-F) — the six stages over the
 * real router, with DETECTION's producer: the traveller's own Trips flights.
 *
 *   detection    GET  /trips/:id/layover-connections → POST /trips/:id/layover-connections
 *   evaluation   GET  /airport/sessions/:id/safety
 *   plan         POST /airport/sessions/:id/stops
 *   execution    PATCH /airport/sessions/:id/stops/:stopId
 *   return       POST /airport/sessions/:id/return-now
 *   completion   DELETE /airport/sessions/:id
 *
 * The fake-backed tier (runs on every `npm test`). The same walk on the REAL
 * migrated schema, with the stored §4.1 state at each stage, is
 * src/test/db/layoverFlightConnections.db.test.ts P6.
 *
 * Run (loopback; unsandboxed): SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverFlightConnectionsRoutes.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import connectionsRouter from "../routes/layoverConnections.js";
import { makeLayoverDb, airportRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "flight-token";
const ANA = "ana-1";
const TRIP = "11111111-1111-4111-8111-111111111111";
const IN = "22222222-2222-4222-8222-222222222222";
const OUT = "33333333-3333-4333-8333-333333333333";
const H = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function flight(id: string, over: Record<string, unknown>) {
  return {
    id, trip_id: TRIP, leg_id: null, mode: "flight", carrier_code: "BA", flight_number: "286",
    departure_airport_iata: "SFO", arrival_airport_iata: "LHR",
    planned_departure_at: null, planned_arrival_at: null, estimated_departure_at: null, estimated_arrival_at: null,
    departure_terminal: null, arrival_terminal: null, departure_gate: null, arrival_gate: null,
    flight_status: "unknown", flight_status_source: null, flight_status_observed_at: null, booking_ref: "ABC123", created_by: ANA,
    ...over,
  };
}

function stage(flags: Record<string, boolean> = { layover_flight_connections_enabled: true }) {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      ...Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })),
    ],
    airport_profiles: [airportRow({ id: "ap-lhr", iata_code: "LHR", name: "London Heathrow", city: "London", country: "United Kingdom", country_code: "GB", timezone: "Europe/London", verified: true })],
    trip_members: [{ trip_id: TRIP, user_id: ANA, role: "owner", status: "accepted" }],
    trip_transport_segments: [
      flight(IN, { planned_departure_at: new Date(now - 9 * H).toISOString(), planned_arrival_at: new Date(now + 10 * 60_000).toISOString(), arrival_terminal: "5" }),
      flight(OUT, { flight_number: "1442", departure_airport_iata: "LHR", arrival_airport_iata: "EDI", planned_departure_at: new Date(now + 12 * H).toISOString(), planned_arrival_at: new Date(now + 13.5 * H).toISOString(), departure_terminal: "5" }),
    ],
    layover_sessions: [],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    trip_plan_items: [], trips: [{ id: TRIP, owner_id: ANA }],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: ANA } }) as any, true);
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": Buffer.byteLength(raw) },
    }, (res) => {
      let acc = ""; res.setEncoding("utf8"); res.on("data", (c) => { acc += c; });
      res.on("end", () => { let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject); if (raw) req.write(raw); req.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  app.use("/api", connectionsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); _setTestClient(null as any, false); });

describe("census L239 — detection has a producer: one layover walks all six stages over the real router", () => {
  it("detection (from the traveller's own Trips flights) → evaluation → plan → execution → return → completion", async () => {
    stage();
    // ── 1. DETECTION ──────────────────────────────────────────────────────────
    const detected = await send("GET", `/api/trips/${TRIP}/layover-connections`);
    assert.equal(detected.status, 200, JSON.stringify(detected.body));
    assert.equal(detected.body.connections.length, 1);
    const c = detected.body.connections[0];
    assert.equal(c.status, "detected");
    assert.equal(c.airport, "LHR");
    assert.equal(c.session, null);
    const started = await send("POST", `/api/trips/${TRIP}/layover-connections`, { arrivalSegmentId: IN, departureSegmentId: OUT });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const sid = started.body.session.id;
    const row = tables.layover_sessions.find((s) => s.id === sid);
    assert.equal(row.arrival_segment_id, IN, "the segments were passed into session creation");
    assert.equal(row.departure_segment_id, OUT);
    assert.equal(row.state, "DETECTED");
    assert.equal(row.detected_source, "trip_itinerary");
    assert.equal(row.arrival_time, tables.trip_transport_segments[0].planned_arrival_at, "the session's arrival IS the flight's");
    // ── 2. EVALUATION ─────────────────────────────────────────────────────────
    const evaluated = await send("GET", `/api/airport/sessions/${sid}/safety`);
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.ok(evaluated.body.usableMinutes > 0);
    // ── 3. PLAN ───────────────────────────────────────────────────────────────
    const planned = await send("POST", `/api/airport/sessions/${sid}/stops`, { title: "Dishoom", durationMin: 60, travelMin: 45, insideAirport: false, lat: 51.47, lng: -0.45 });
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    const stopId = planned.body.stops[0].id;
    // ── 4. EXECUTION ──────────────────────────────────────────────────────────
    const executed = await send("PATCH", `/api/airport/sessions/${sid}/stops/${stopId}`, { durationMin: 90 });
    assert.equal(executed.status, 200);
    assert.equal(tables.layover_plan_stops[0].duration_min, 90);
    // ── 5. RETURN ─────────────────────────────────────────────────────────────
    const returned = await send("POST", `/api/airport/sessions/${sid}/return-now`, {});
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.returnContract.hardReturnTime, evaluated.body.hardReturnTime);
    assert.deepEqual(returned.body.cancelledStopIds, [stopId]);
    // ── 6. COMPLETION ─────────────────────────────────────────────────────────
    const completed = await send("DELETE", `/api/airport/sessions/${sid}?outcome=completed`);
    assert.equal(completed.status, 200);
    assert.equal(tables.layover_sessions.find((s) => s.id === sid).status, "completed");
    const trail = tables.layover_events.filter((e) => e.session_id === sid).map((e) => e.event_type);
    for (const t of ["session_created", "plan_stop_added", "plan_stop_updated", "safe_return_aborted", "session_completed"]) assert.ok(trail.includes(t), `${t} missing: ${JSON.stringify(trail)}`);
  });

  it("the Trips card shows the session's status once started, and a second start returns the same session", async () => {
    stage();
    const a = await send("POST", `/api/trips/${TRIP}/layover-connections`, { arrivalSegmentId: IN, departureSegmentId: OUT });
    assert.equal(a.status, 201);
    const b = await send("POST", `/api/trips/${TRIP}/layover-connections`, { arrivalSegmentId: IN, departureSegmentId: OUT });
    assert.equal(b.status, 200);
    assert.equal(b.body.existed, true);
    assert.equal(b.body.session.id, a.body.session.id);
    const shown = await send("GET", `/api/trips/${TRIP}/layover-connections`);
    assert.deepEqual(shown.body.connections[0].session, { sessionId: a.body.session.id, status: "active", state: "DETECTED" });
  });

  it("refusals: the flag off (feature_disabled, nothing read), a non-member, a pair that is not a connection, unreadable flights", async () => {
    stage({ layover_flight_connections_enabled: false });
    assert.equal((await send("GET", `/api/trips/${TRIP}/layover-connections`)).status, 404);
    assert.equal((await send("POST", `/api/trips/${TRIP}/layover-connections`, { arrivalSegmentId: IN, departureSegmentId: OUT })).status, 404);
    assert.equal(tables.layover_sessions.length, 0);
    stage();
    tables.trip_members.length = 0; tables.trips[0].owner_id = "someone-else"; // not a member, not the owner
    assert.equal((await send("GET", `/api/trips/${TRIP}/layover-connections`)).status, 403);
    stage();
    const backwards = await send("POST", `/api/trips/${TRIP}/layover-connections`, { arrivalSegmentId: OUT, departureSegmentId: IN });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.body.reason, "not_a_connection");
    stage();
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: ANA }, failures: { "trip_transport_segments:select": { message: "boom" } } }) as any, true);
    const unread = await send("GET", `/api/trips/${TRIP}/layover-connections`);
    assert.equal(unread.status, 503, "a failed read is never 'no connections'");
  });

  it("the disruption route: flag off → no flightSegment key (byte-identical); flag on, a typed session → recorded: false, not linked", async () => {
    stage({ layover_flight_connections_enabled: false });
    const now = Date.now();
    tables.layover_sessions.push({ id: "typed-1", user_id: ANA, airport_id: "ap-lhr", status: "active", arrival_time: new Date(now - 60_000).toISOString(), departure_time: new Date(now + 6 * H).toISOString(), boarding_time: null, flight_type: "international", immigration_required: true, checked_bags: false, wants_to_leave: true });
    const off = await send("POST", "/api/airport/sessions/typed-1/disruption", { kind: "delay", delayMinutes: 20 });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.ok(!("flightSegment" in off.body));
    tables.feature_flags.push({ flag: "layover_flight_connections_enabled", enabled: true });
    tables.feature_flags = tables.feature_flags.filter((f) => !(f.flag === "layover_flight_connections_enabled" && f.enabled === false));
    _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: ANA } }) as any, true);
    const on = await send("POST", "/api/airport/sessions/typed-1/disruption", { kind: "delay", delayMinutes: 25 });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual(on.body.flightSegment, { recorded: false, reason: "not_linked_to_a_trip_flight" });
  });
});
