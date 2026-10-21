/**
 * census-layover L153 and L43 — the onward flight, as Trips last recorded it.
 *
 *   L153  §16 "Flight/gate — cache last confirmed values with stale indicator".
 *         The offline bundle's `flightStatus` was `unavailable("no_flight_feed")`
 *         for every session. It now carries the onward flight's last recorded
 *         OBSERVATION (RECORD_FLIGHT_STATUS: the traveller or an approved feed,
 *         3826), with its source, its instant and a stale bound measured from
 *         that instant — and still refuses to dress the typed schedule up as one.
 *   L43   §5 RETURNING → AIRPORT_REENTERED: "stop landside discovery, refresh
 *         gate/security". After a re-entry check-in the overview publishes
 *         `reentry`: the gate read at this request and the certified record's
 *         security term.
 *
 * Over the REAL router on the in-memory double, with rows shaped as 3826/3827/
 * 2992 write them.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 *   - the bundle changing at all while `layover_flight_connections_enabled` is off;
 *   - a typed schedule (no observation) cached as a flight status;
 *   - another traveller's segment, through a forged link, served as this one's gate;
 *   - a failed read said as "no flight", or a stale bound renewed from now;
 *   - `reentry` published without a re-entry check-in, or missing after one;
 *   - a re-entry check-in moving the deadline, the verdict or the return state.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverDepartureFlightContext.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { OFFLINE_BUNDLE_TTL_MIN } from "../services/airport/LayoverDegradedService.js";
import { readDepartureFlight, reentrySecurityOf } from "../services/airport/LayoverDepartureFlight.js";

let server: http.Server;
let base: string;
const TOKEN = "ldf-token";
const USER = "ldf-user";
const OTHER = "ldf-other";
const SESSION = "ldf-session";
const TRIP = "ldf-trip";
const DEP = "seg-dep";
const ARR = "seg-arr";
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const OBSERVED = iso(NOW - 40 * MIN);

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function segment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEP, trip_id: TRIP, leg_id: null, mode: "flight", created_by: USER, booking_ref: "ABC123",
    carrier_code: "BR", flight_number: "61", departure_airport_iata: "TPE", arrival_airport_iata: "VIE",
    planned_departure_at: iso(NOW + 8 * HOUR), planned_arrival_at: iso(NOW + 21 * HOUR),
    estimated_departure_at: iso(NOW + 8 * HOUR + 35 * MIN), estimated_arrival_at: null,
    departure_terminal: "T2", arrival_terminal: null, departure_gate: "D7", arrival_gate: null,
    flight_status: "delayed", flight_status_source: "traveller", flight_status_observed_at: OBSERVED,
    ...over,
  };
}

const NEVER_OBSERVED = { estimated_departure_at: null, flight_status: "unknown", flight_status_source: null, flight_status_observed_at: null, departure_gate: "D7" };

interface Stage {
  flags?: string[];
  segments?: Record<string, unknown>[];
  session?: Record<string, unknown>;
  checkpoints?: Record<string, unknown>[];
  failures?: Record<string, { message: string }>;
  touched?: string[];
}

function stage(o: Stage = {}) {
  const db = makeLayoverDb(
    {
      feature_flags: ["airport_mode_enabled", ...(o.flags ?? [])].map((flag) => ({ flag, enabled: true })),
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({
        id: SESSION, user_id: USER, trip_id: TRIP, departure_time: iso(NOW + 8 * HOUR),
        arrival_segment_id: ARR, departure_segment_id: DEP, state: "EXECUTING", connection_type: "single_booking",
        detected_source: "trip_itinerary", expires_at: iso(NOW + 9 * HOUR), ...(o.session ?? {}),
      }, { nowMs: NOW })],
      trip_transport_segments: o.segments ?? [segment()],
      layover_checkpoints: o.checkpoints ?? [],
      layover_events: [], layover_plan_stops: [], trip_plan_items: [], layover_crews: [], layover_crew_members: [],
      blocks: [], profiles: [], location_preferences: [], trips: [{ id: TRIP, owner_id: USER }],
    },
    { users: { [TOKEN]: USER }, failures: o.failures ?? {} },
  ) as any;
  const touched = o.touched;
  _setTestClient(touched ? { ...db, from: (t: string) => { touched.push(t); return db.from(t); } } : db, true);
}

async function overview(o: Stage = {}) {
  stage(o);
  const r = await get(`/api/airport/sessions/${SESSION}/overview`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return r.body;
}

const CONNECTIONS = "layover_flight_connections_enabled";
const PERSIST = "layover_decision_persistence_enabled";

function checkpoint(type: "LANDSIDE_EXIT" | "AIRPORT_REENTRY", atMs: number) {
  return { id: `cp-${type}-${atMs}`, session_id: SESSION, checkpoint_type: type, observed_at: iso(atMs), source: "TRAVELLER", confidence: "MEDIUM", dedup_key: `${type}:${atMs}`, expires_at: iso(NOW + 14 * HOUR) };
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── L153 — the offline bundle's flight/gate ──────────────────────────────────

describe("L153 — the offline bundle caches the onward flight's last recorded observation", () => {
  it("connections flag OFF (production today): exactly `no_flight_feed`, and no flight is read", async () => {
    const touched: string[] = [];
    const body = await overview({ touched });
    assert.deepEqual(body.offlineBundle.flightStatus, { available: false, value: null, reason: "no_flight_feed" });
    assert.ok(!touched.includes("trip_transport_segments"), `read: ${touched.join(",")}`);
  });

  it("ON and observed: the gate, terminal, status and stated departure, with WHO recorded it and WHEN", async () => {
    const body = await overview({ flags: [CONNECTIONS] });
    const fs = body.offlineBundle.flightStatus;
    assert.equal(fs.available, true, JSON.stringify(fs));
    assert.equal(fs.reason, null);
    assert.deepEqual(
      { designator: fs.value.designator, gate: fs.value.gate, terminal: fs.value.terminal, status: fs.value.status, source: fs.value.source, observedAt: fs.value.observedAt },
      { designator: "BR61", gate: "D7", terminal: "T2", status: "delayed", source: "traveller", observedAt: OBSERVED },
    );
    assert.equal(fs.value.estimatedDepartureAt, iso(NOW + 8 * HOUR + 35 * MIN));
    assert.equal(fs.value.scheduledDepartureAt, iso(NOW + 8 * HOUR));
  });

  it("the stale bound runs from the OBSERVATION, never from now: a 40-minute-old gate is already past it", async () => {
    const fs = (await overview({ flags: [CONNECTIONS] })).offlineBundle.flightStatus;
    assert.equal(fs.value.staleAfter, iso(Date.parse(OBSERVED) + OFFLINE_BUNDLE_TTL_MIN * MIN));
    assert.ok(Date.parse(fs.value.staleAfter) < Date.now(), "observed 40 min ago, TTL 15: stale on arrival");
  });

  it("a feed observation is labelled as the feed's", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], segments: [segment({ flight_status_source: "feed", flight_status: "boarding" })] })).offlineBundle.flightStatus;
    assert.deepEqual([fs.value.source, fs.value.status], ["feed", "boarding"]);
  });

  it("linked but NEVER observed: the typed schedule and a boarding-pass gate are not cached as a flight status", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], segments: [segment(NEVER_OBSERVED)] })).offlineBundle.flightStatus;
    assert.deepEqual(fs, { available: false, value: null, reason: "no_flight_observation" });
  });

  it("not linked to a trip flight: said as that", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], session: { departure_segment_id: null, arrival_segment_id: null } })).offlineBundle.flightStatus;
    assert.deepEqual(fs, { available: false, value: null, reason: "not_linked_to_a_trip_flight" });
  });

  it("a link to ANOTHER traveller's segment serves none of their flight", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], segments: [segment({ created_by: OTHER, departure_gate: "Z99" })] })).offlineBundle.flightStatus;
    assert.deepEqual(fs, { available: false, value: null, reason: "not_linked_to_a_trip_flight" });
  });

  it("a segment on another trip is not this session's flight either", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], segments: [segment({ trip_id: "some-other-trip" })] })).offlineBundle.flightStatus;
    assert.equal(fs.reason, "not_linked_to_a_trip_flight");
  });

  it("the flight read FAILS: `flight_unreadable`, never 'no flight'", async () => {
    const fs = (await overview({ flags: [CONNECTIONS], failures: { "trip_transport_segments:select": { message: "down" } } })).offlineBundle.flightStatus;
    assert.deepEqual(fs, { available: false, value: null, reason: "flight_unreadable" });
  });

  it("one read per request: the reader is memoised on the session object", async () => {
    const touched: string[] = [];
    const db = makeLayoverDb({
      feature_flags: [{ flag: CONNECTIONS, enabled: true }],
      layover_sessions: [{ id: SESSION, user_id: USER, departure_segment_id: DEP, arrival_segment_id: ARR }],
      trip_transport_segments: [segment()],
    }) as any;
    const spy = { ...db, from: (t: string) => { touched.push(t); return db.from(t); } };
    const s = { id: SESSION, userId: USER, tripId: TRIP };
    const [a, b] = [await readDepartureFlight(spy, s), await readDepartureFlight(spy, s)];
    assert.equal(a, b);
    assert.equal(a.state, "observed");
    assert.equal(touched.filter((t) => t === "trip_transport_segments").length, 1);
  });
});

// ── L43 — REFRESH_GATE_AND_SECURITY ──────────────────────────────────────────

describe("L43 — after a re-entry check-in the overview refreshes gate and security", () => {
  it("re-entered: `reentry` carries the check-in instant, the gate read now, and the security term", async () => {
    const back = NOW - 5 * MIN;
    const body = await overview({ flags: [CONNECTIONS, PERSIST], checkpoints: [checkpoint("LANDSIDE_EXIT", NOW - 3 * HOUR), checkpoint("AIRPORT_REENTRY", back)] });
    assert.equal(body.reentry?.state, "reentered", JSON.stringify(body.reentry));
    assert.equal(body.reentry.reportedAt, iso(back));
    assert.ok(Math.abs(Date.parse(body.reentry.refreshedAt) - Date.now()) < 60_000);
    assert.equal(body.reentry.flight.state, "observed");
    assert.deepEqual([body.reentry.flight.flight.gate, body.reentry.flight.flight.terminal, body.reentry.flight.flight.source], ["D7", "T2", "traveller"]);
    assert.equal(body.reentry.flight.flight.staleAfter, iso(Date.parse(OBSERVED) + OFFLINE_BUNDLE_TTL_MIN * MIN), "the same stale bound the bundle carries");
    assert.deepEqual(body.reentry.security, { state: "no_live_reading" }, "nothing live was folded in, and it says so");
  });

  it("the newest check-in is an EXIT (out in the city): no `reentry`", async () => {
    const body = await overview({ flags: [CONNECTIONS, PERSIST], checkpoints: [checkpoint("AIRPORT_REENTRY", NOW - 3 * HOUR), checkpoint("LANDSIDE_EXIT", NOW - 2 * HOUR)] });
    assert.ok(!("reentry" in body), JSON.stringify(body.reentry));
  });

  it("no check-in at all: no `reentry`", async () => {
    const body = await overview({ flags: [CONNECTIONS, PERSIST] });
    assert.ok(!("reentry" in body));
  });

  it("check-in store OFF (production today): no `reentry`, even with a row present", async () => {
    const body = await overview({ flags: [CONNECTIONS], checkpoints: [checkpoint("AIRPORT_REENTRY", NOW - 5 * MIN)] });
    assert.ok(!("reentry" in body));
  });

  it("check-ins UNREADABLE: said as unknown, never as 'not back yet'", async () => {
    const body = await overview({ flags: [CONNECTIONS, PERSIST], failures: { "layover_checkpoints:select": { message: "down" } } });
    assert.deepEqual(body.reentry, { state: "unknown", reason: "checkpoints_unreadable" });
  });

  it("re-entered with the flight connections flag off: the gate is said to be unread, security still refreshed", async () => {
    const body = await overview({ flags: [PERSIST], checkpoints: [checkpoint("AIRPORT_REENTRY", NOW - 5 * MIN)] });
    assert.equal(body.reentry.state, "reentered");
    assert.deepEqual(body.reentry.flight, { state: "off" });
    assert.deepEqual(body.reentry.security, { state: "no_live_reading" });
  });

  it("a re-entry check-in NEVER relaxes anything: deadline, verdict and return state are the same with and without it", async () => {
    const without = await overview({ flags: [CONNECTIONS, PERSIST] });
    const withIt = await overview({ flags: [CONNECTIONS, PERSIST], checkpoints: [checkpoint("AIRPORT_REENTRY", NOW - 5 * MIN)] });
    assert.equal(withIt.reentry?.state, "reentered", "anti-vacuity: the check-in was seen");
    for (const v of [without.window.hardReturnTime, without.advice.verdict, without.safeReturn?.returnState]) assert.ok(typeof v === "string" && v.length > 0, "anti-vacuity: compared values exist");
    assert.deepEqual(withIt.window.hardReturnTime, without.window.hardReturnTime);
    assert.deepEqual(withIt.advice.verdict, without.advice.verdict);
    assert.deepEqual(withIt.safeReturn?.returnState, without.safeReturn?.returnState);
  });
});

describe("L43 — the security half is the certified record's own live term", () => {
  const rec = (live: unknown) => ({ inputs: { liveConditions: live } }) as any;
  it("a live security reading: its extra minutes, with when it was observed and when it expires", () => {
    assert.deepEqual(
      reentrySecurityOf(rec({ securityWaitExtraMin: 25, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0, reasonCodes: [], observedAt: "2026-10-20T10:00:00.000Z", expiresAt: "2026-10-20T10:30:00.000Z" })),
      { state: "live", extraMinutes: 25, observedAt: "2026-10-20T10:00:00.000Z", expiresAt: "2026-10-20T10:30:00.000Z" },
    );
  });
  it("a negative term is never a discount: 0", () => {
    assert.equal((reentrySecurityOf(rec({ securityWaitExtraMin: -20, observedAt: "2026-10-20T10:00:00.000Z", expiresAt: null })) as any).extraMinutes, 0);
  });
  it("nothing live, or nothing observed, or a non-number: `no_live_reading`", () => {
    assert.deepEqual(reentrySecurityOf(rec(null)), { state: "no_live_reading" });
    assert.deepEqual(reentrySecurityOf(rec({ securityWaitExtraMin: 0, observedAt: null, expiresAt: null })), { state: "no_live_reading" });
    assert.deepEqual(reentrySecurityOf(rec({ securityWaitExtraMin: Number.NaN, observedAt: "2026-10-20T10:00:00.000Z", expiresAt: null })), { state: "no_live_reading" });
  });
});
