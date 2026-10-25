/**
 * Layover 165, lane B1-F — flight data and connection detection, against the
 * REAL MIGRATED SCHEMA (the 2026-08-19 baseline + every file in src/migrations,
 * replayed by lane B1-P's pressedLayoverDb on PGlite, or CI's local-db
 * PostgreSQL), through the real supabase-js client and the real routers.
 *
 * Rows: L11 (Trips owns flight segments, written by the kernel from the
 * traveller's own entry), L21 (layover_sessions' connection columns), L33 (the
 * seventeen-member state, stored and moved), L239 (detection → evaluation →
 * plan → execution → return → completion, the detection stage with a
 * producer), L259 (the flight-subject axis of the replan fan-out, indexed),
 * L267 (Trips detects the connection, shows its status, and passes the
 * segments into session creation).
 *
 * THE PRESS: 3826 → 3827 → 3828, then `trip_flight_segments_enabled` and
 * `layover_flight_connections_enabled` ON (both seeded FALSE), over production's
 * flag state. L33's projection also needs 3632's `layover_lifecycle_machine_enabled`.
 * Two more arms in this file: the flags OFF (every new surface refuses and the
 * old ones answer as before) and the migrations ABSENT (the chain without
 * 3826-3828: the old surfaces work unchanged).
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<node_modules/@electric-sql with pglite + pglite-postgis> \
 *     node --import tsx/esm --test src/test/db/layoverFlightConnections.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import { resetSchemaCapabilityMemo } from "../../lib/capability/schemaCapability.js";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags } from "./pressedLayoverApp.js";
import { applyFlightStatusUpdate } from "../../services/airport/LayoverFlightStatus.js";

const H = 3_600_000;
const FLAGS_ON = { trip_flight_segments_enabled: true, layover_flight_connections_enabled: true, airport_mode_enabled: true, layover_lifecycle_machine_enabled: true };

interface Reply { status: number; body: any; raw: string }
interface App { call(method: string, path: string, user: PressedUser | null, body?: unknown, headers?: Record<string, string>): Promise<Reply>; close(): Promise<void> }

/** The layover routers plus the two this lane adds, under /api, exactly as routes/index.ts mounts them. */
async function startApp(db: PressedDb): Promise<App> {
  process.env["SESSION_SECRET"] ??= "pressed-layover-session-secret";
  const mods = await Promise.all([
    import("../../routes/airport.js"), import("../../routes/layoverConnections.js"), import("../../server/trips/flightSegmentRoute.js"),
  ]);
  resetSchemaCapabilityMemo();
  _setTestClient(db.client, true);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  for (const m of mods) app.use("/api", (m as any).default);
  const server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    call: (method, path, user, body, headers = {}) => new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = http.request({
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let raw = ""; res.setEncoding("utf8"); res.on("data", (c) => { raw += c; });
        res.on("end", () => { let b: any; try { b = raw ? JSON.parse(raw) : null; } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b, raw }); });
      });
      r.on("error", reject); if (payload) r.write(payload); r.end();
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); _setTestClient(null as any, false); }),
  };
}

/** "YYYY-MM-DDTHH:mm" in `tz`. (Each describe below types a DIFFERENT airport for its manual session: lib/canonicalLocations keeps an in-process cache of canonical city ids, and a second database in this process would be handed the first one's id.) */
function wall(tz: string, ms: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/**
 * Every (zone, offset from t0) this file types as an airport-local wall time.
 * A wall time read off an instant always EXISTS, but on a DST fall-back it is
 * AMBIGUOUS: 01:30 in London on 2026-10-25 is both 00:30Z (BST) and 01:30Z
 * (GMT), and the server can only pick one. With t0 = now + 5 min, any run
 * whose t0 + offset fell in a repeated hour got the other instant back and
 * failed P1/P3/P4/P7b by exactly one hour (CI, every PR, 2026-10-24 ~23:00Z).
 * A test of the conversion must not type a local time that has two answers.
 */
const TYPED_WALL_TIMES: ReadonlyArray<readonly [string, number]> = [
  ["America/Los_Angeles", -9 * H],
  ["Europe/London", H], ["Europe/London", 1.5 * H], ["Europe/London", 2 * H], ["Europe/London", 3 * H],
  ["Europe/London", 7 * H], ["Europe/London", 8.5 * H],
];
/** True when no OTHER instant shows the same minute on `tz`'s clock (offset changes are 30, 60 or 120 minutes). */
function unambiguousWall(tz: string, ms: number): boolean {
  const w = wall(tz, ms);
  return [30, 60, 120].every((m) => wall(tz, ms - m * 60_000) !== w && wall(tz, ms + m * 60_000) !== w);
}
/** The first minute at or after `from` (in 15-minute steps) at which every typed wall time has exactly one instant. */
function unambiguousT0(from: number): number {
  let t = minute(from);
  while (!TYPED_WALL_TIMES.every(([tz, k]) => unambiguousWall(tz, t + k))) t += 15 * 60_000;
  return t;
}
const iso = (ms: number) => new Date(ms).toISOString();

async function createTrip(db: PressedDb, owner: PressedUser, members: PressedUser[] = []): Promise<string> {
  const tripId = randomUUID();
  const r = await db.query<any>(`SELECT public.trip_kernel_execute(jsonb_build_object('trip_id', '${tripId}', 'actor_user_id', '${owner.id}', 'command_id', gen_random_uuid(), 'idempotency_key', 'create-${tripId}', 'type', 'CREATE_TRIP', 'payload', jsonb_build_object('title', 'Edinburgh', 'destination_city', 'Edinburgh', 'destination_country', 'GB'))) AS r`);
  assert.equal(r[0].r.ok, true, JSON.stringify(r[0].r));
  for (const m of members) await db.exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${m.id}', 'member', 'accepted') ON CONFLICT DO NOTHING`);
  return tripId;
}

/** Inbound SFO→LHR landing at `t0 + 1h`; onward LHR→EDI leaving at `t0 + 7h`. Same booking. Entered through the Trips route. */
async function enterFlights(app: App, user: PressedUser, tripId: string, t0: number, over: { inbound?: Record<string, unknown>; onward?: Record<string, unknown> } = {}) {
  const a = await app.call("POST", `/api/trips/${tripId}/flight-segments`, user, {
    flight: "BA 0286", departureAirport: "sfo", arrivalAirport: "LHR",
    departureLocal: wall("America/Los_Angeles", t0 - 9 * H), arrivalLocal: wall("Europe/London", t0 + H),
    arrivalTerminal: "5", bookingRef: "abc123", ...over.inbound,
  }, { "idempotency-key": `in-${tripId}-${user.id}` });
  assert.equal(a.status, 201, a.raw);
  const b = await app.call("POST", `/api/trips/${tripId}/flight-segments`, user, {
    flight: "BA1442", departureAirport: "LHR", arrivalAirport: "EDI",
    departureLocal: wall("Europe/London", t0 + 7 * H), arrivalLocal: wall("Europe/London", t0 + 8.5 * H),
    departureTerminal: "5", bookingRef: "ABC123", ...over.onward,
  }, { "idempotency-key": `out-${tripId}-${user.id}` });
  assert.equal(b.status, 201, b.raw);
  return { inbound: a.body.segment, onward: b.body.segment };
}

const sessionRow = async (db: PressedDb, id: string) => (await db.query<any>(`SELECT * FROM public.layover_sessions WHERE id = '${id}'`))[0];
const segmentRow = async (db: PressedDb, id: string) => (await db.query<any>(`SELECT * FROM public.trip_transport_segments WHERE id = '${id}'`))[0];

describe("B1-F — the test clock never types an ambiguous local time", () => {
  it("C1 the guard recognises the repeated hour and moves t0 past it; an ordinary t0 is left alone", () => {
    assert.equal(unambiguousWall("Europe/London", Date.parse("2026-10-25T00:30:00Z")), false, "01:30 BST, repeated as 01:30 GMT");
    assert.equal(unambiguousWall("Europe/London", Date.parse("2026-10-25T01:30:00Z")), false, "01:30 GMT, the repeat");
    assert.equal(unambiguousWall("America/Los_Angeles", Date.parse("2026-11-01T08:30:00Z")), false);
    assert.equal(unambiguousWall("Europe/London", Date.parse("2026-10-25T02:30:00Z")), true);
    for (const now of ["2026-10-24T23:30:00Z", "2026-10-24T17:00:00Z", "2026-11-01T00:00:00Z", "2027-03-28T00:30:00Z", "2027-10-30T23:59:00Z"]) {
      const t = unambiguousT0(Date.parse(now) + 5 * 60_000);
      assert.ok(t >= Date.parse(now) + 5 * 60_000 && t - Date.parse(now) < 12 * H, now);
      for (const [tz, k] of TYPED_WALL_TIMES) assert.ok(unambiguousWall(tz, t + k), `${now}: ${tz} ${wall(tz, t + k)}`);
    }
    assert.equal(unambiguousT0(Date.parse("2026-07-01T12:00:00Z")), Date.parse("2026-07-01T12:00:00Z"));
  });
});

describe("B1-F flight data and connections — PRESSED (3826/3827/3828 + flags ON)", { skip: PRESSED_SKIP_REASON }, () => {
  let db: PressedDb; let app: App;
  let ana: PressedUser, bob: PressedUser, cy: PressedUser, eve: PressedUser;
  const seeds: Record<string, boolean | "absent"> = {};
  const t0 = unambiguousT0(Date.now() + 5 * 60_000);
  let anaTrip = "", anaIn: any, anaOut: any, anaSession = "";
  let bobTrip = "", bobIn: any, bobOut: any, bobSession = "", cySession = "";

  before(async () => {
    db = await openPressedLayoverDb();
    for (const f of ["trip_flight_segments_enabled", "layover_flight_connections_enabled"]) seeds[f] = await db.flag(f);
    await productionBaseFlags(db);
    await db.setFlags(FLAGS_ON);
    app = await startApp(db);
    ana = await db.seedUser("ana"); bob = await db.seedUser("bob"); cy = await db.seedUser("cy"); eve = await db.seedUser("eve");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("P0 the press: both flags are seeded FALSE by their own migrations (3826, 3827)", () => {
    assert.equal(seeds["trip_flight_segments_enabled"], false);
    assert.equal(seeds["layover_flight_connections_enabled"], false);
  });

  it("P1 L11 — a traveller's own flight entry becomes a Trips flight segment, written by the kernel, every unknown explicit", async () => {
    anaTrip = await createTrip(db, ana);
    ({ inbound: anaIn, onward: anaOut } = await enterFlights(app, ana, anaTrip, t0));
    const row = await segmentRow(db, anaIn.id);
    assert.equal(row.mode, "flight");
    assert.equal(row.carrier_code, "BA");
    assert.equal(row.flight_number, "286", "canonical: no leading zero");
    assert.equal(row.departure_airport_iata, "SFO");
    assert.equal(Date.parse(row.planned_departure_at), t0 - 9 * H, "SFO's local time converted in America/Los_Angeles");
    assert.equal(Date.parse(row.planned_arrival_at), t0 + H, "LHR's local time converted in Europe/London");
    assert.equal(row.arrival_terminal, "5");
    assert.equal(row.flight_status, "unknown", "nothing observed: unknown, not scheduled");
    assert.equal(row.estimated_arrival_at, null, "no estimate stated: NULL, never the schedule");
    assert.equal(row.created_by, ana.id);
    const ev = await db.query<any>(`SELECT type, payload_json->>'command_type' AS cmd, payload_json->>'family' AS fam FROM public.trip_events WHERE trip_id = '${anaTrip}' ORDER BY sequence`);
    assert.deepEqual(ev.map((e) => [e.type, e.cmd, e.fam]).slice(1), [["trip.transport_segment_added", "ADD_TRANSPORT_SEGMENT", "transport"], ["trip.transport_segment_added", "ADD_TRANSPORT_SEGMENT", "transport"]]);
    const list = await app.call("GET", `/api/trips/${anaTrip}/flight-segments`, ana);
    assert.equal(list.status, 200, list.raw);
    assert.deepEqual(list.body.segments.map((s: any) => s.designator), ["BA286", "BA1442"]);
    assert.equal(list.body.segments[0].bestKnownArrival.basis, "scheduled");
  });

  it("P2 L11 — refused by name: an airport with no known zone, a flight that lands before it leaves, a non-member; a retry is the same command", async () => {
    const bad = await app.call("POST", `/api/trips/${anaTrip}/flight-segments`, ana, { flight: "BA1", departureAirport: "QQQ", arrivalAirport: "LHR", departureLocal: wall("UTC", t0), arrivalLocal: wall("Europe/London", t0 + H) });
    assert.equal(bad.status, 400, bad.raw);
    assert.match(bad.body.message, /time zone/);
    const inverted = await app.call("POST", `/api/trips/${anaTrip}/flight-segments`, ana, { flight: "BA2", departureAirport: "LHR", arrivalAirport: "EDI", departureLocal: wall("Europe/London", t0 + 3 * H), arrivalLocal: wall("Europe/London", t0 + 2 * H) });
    assert.equal(inverted.status, 400, inverted.raw);
    const stranger = await app.call("GET", `/api/trips/${anaTrip}/flight-segments`, eve);
    assert.equal(stranger.status, 403, stranger.raw);
    const retry = await app.call("POST", `/api/trips/${anaTrip}/flight-segments`, ana, {
      flight: "BA1442", departureAirport: "LHR", arrivalAirport: "EDI",
      departureLocal: wall("Europe/London", t0 + 7 * H), arrivalLocal: wall("Europe/London", t0 + 8.5 * H), departureTerminal: "5", bookingRef: "ABC123",
    }, { "idempotency-key": `out-${anaTrip}-${ana.id}` });
    assert.equal(retry.status, 200, retry.raw);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.segment.id, anaOut.id, "same key, same segment: no second flight");
    const n = await db.query<any>(`SELECT count(*)::int AS n FROM public.trip_transport_segments WHERE trip_id = '${anaTrip}'`);
    assert.equal(n[0].n, 2);
  });

  it("P3 L267 — Trips detects the connection: the two segments, the gap, what the bookings say, the risk, and no session yet", async () => {
    const r = await app.call("GET", `/api/trips/${anaTrip}/layover-connections`, ana);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.connections.length, 1);
    const c = r.body.connections[0];
    assert.equal(c.status, "detected");
    assert.equal(c.airport, "LHR");
    assert.equal(c.arrivalSegment.id, anaIn.id);
    assert.equal(c.departureSegment.id, anaOut.id);
    assert.equal(c.scheduledGapMinutes, 360);
    assert.equal(c.connectionType, "single_booking");
    assert.equal(c.terminalChange, false);
    assert.equal(c.missedConnection.risk, "on_track");
    assert.ok(c.missedConnection.processMinutes > 0, "the process terms are published");
    assert.equal(c.session, null);
  });

  it("P4 L21 L267 — the segments are passed into session creation: a DETECTED session linked to both, idempotent per connection", async () => {
    const r = await app.call("POST", `/api/trips/${anaTrip}/layover-connections`, ana, { arrivalSegmentId: anaIn.id, departureSegmentId: anaOut.id });
    assert.equal(r.status, 201, r.raw);
    anaSession = r.body.session.id;
    assert.equal(Date.parse(r.body.session.arrivalTime), t0 + H, "the session's times are the segments', not typed");
    assert.equal(Date.parse(r.body.session.departureTime), t0 + 7 * H);
    const row = await sessionRow(db, anaSession);
    assert.equal(row.arrival_segment_id, anaIn.id);
    assert.equal(row.departure_segment_id, anaOut.id);
    assert.equal(row.state, "DETECTED", "§5's first state");
    assert.equal(row.detected_source, "trip_itinerary");
    assert.equal(row.connection_type, "single_booking");
    assert.equal(Date.parse(row.expires_at), Date.parse(row.departure_time), "expires_at is the expiry sweep's own predicate");
    assert.equal(row.trip_id, anaTrip);
    assert.equal(row.flight_type, "international", "SFO → LHR → EDI crosses a border");
    assert.equal(row.checked_bags, true, "UNKNOWN baggage is charged, never assumed absent");
    const again = await app.call("POST", `/api/trips/${anaTrip}/layover-connections`, ana, { arrivalSegmentId: anaIn.id, departureSegmentId: anaOut.id });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.existed, true);
    assert.equal(again.body.session.id, anaSession);
    await assert.rejects(
      db.exec(`INSERT INTO public.layover_sessions (user_id, arrival_time, departure_time, arrival_segment_id, departure_segment_id, detected_source) VALUES ('${ana.id}', now(), now() + interval '5 hours', '${anaIn.id}', '${anaOut.id}', 'trip_itinerary')`),
      (e: any) => e?.code === "23505", "3827's unique pair: one live session per traveller per connection",
    );
    const shown = await app.call("GET", `/api/trips/${anaTrip}/layover-connections`, ana);
    assert.deepEqual(shown.body.connections[0].session, { sessionId: anaSession, status: "active", state: "DETECTED" }, "L267: Trips shows the layover's status");
    const wrong = await app.call("POST", `/api/trips/${anaTrip}/layover-connections`, ana, { arrivalSegmentId: anaOut.id, departureSegmentId: anaIn.id });
    assert.equal(wrong.status, 400, "the server re-detects the pair; a client's word is not taken");
    assert.equal(wrong.body.reason, "not_a_connection");
  });

  it("P5 L33 L21 — server-authoritative: a typed session is stamped DETECTED / manual; a client cannot write the state or the link (42501)", async () => {
    const manual = await app.call("POST", "/api/airport/sessions", ana, { iata: "SIN", arrivalTime: iso(t0), departureTime: iso(t0 + 6 * H), flightType: "international" });
    assert.equal(manual.status, 201, manual.raw);
    const m = await sessionRow(db, manual.body.session.id);
    assert.equal(m.state, "DETECTED");
    assert.equal(m.detected_source, "manual");
    assert.equal(m.arrival_segment_id, null);
    // Production before 3620 hands the client role UPDATE on its own rows (0127's FOR ALL policy). Simulate that grant.
    await db.exec("GRANT UPDATE ON public.layover_sessions TO authenticated");
    try {
      await assert.rejects(db.asUser(ana.id, `UPDATE public.layover_sessions SET state = 'COMPLETED' WHERE id = '${anaSession}' RETURNING id`), (e: any) => e?.code === "42501" && /server only/.test(String(e?.message)));
      await assert.rejects(db.asUser(ana.id, `UPDATE public.layover_sessions SET departure_segment_id = NULL WHERE id = '${anaSession}' RETURNING id`), (e: any) => e?.code === "42501");
      await assert.rejects(db.asUser(ana.id, `UPDATE public.layover_sessions SET confidence_band = 'HIGH' WHERE id = '${anaSession}' RETURNING id`), (e: any) => e?.code === "42501", "3828's guard");
      const fine = await db.asUser(ana.id, `UPDATE public.layover_sessions SET share_city_status = true WHERE id = '${manual.body.session.id}' RETURNING id`);
      assert.equal(fine.length, 1, "the guard is column-specific: other columns are 0127's business");
    } finally {
      await db.exec("REVOKE UPDATE ON public.layover_sessions FROM authenticated");
    }
    assert.equal((await sessionRow(db, anaSession)).state, "DETECTED");
  });

  it("P6 L239 L33 — detection → evaluation → plan → execution → return → completion over the real router, each stage's state stored", async () => {
    const states: string[] = [(await sessionRow(db, anaSession)).state];
    // evaluation
    const ev = await app.call("GET", `/api/airport/sessions/${anaSession}/safety`, ana);
    assert.equal(ev.status, 200, ev.raw);
    assert.ok(ev.body.usableMinutes > 0, ev.raw);
    const ov = await app.call("GET", `/api/airport/sessions/${anaSession}/overview`, ana);
    assert.equal(ov.status, 200, ov.raw);
    assert.ok(ov.body.lifecycle, "the lifecycle machine is ON");
    const placed = (await sessionRow(db, anaSession)).state;
    assert.equal(placed, ov.body.lifecycle.state, "L33: the graph's placement is the stored state");
    assert.notEqual(placed, "DETECTED");
    states.push(placed);
    // plan
    const plan = await app.call("POST", `/api/airport/sessions/${anaSession}/stops`, ana, { title: "Dishoom", durationMin: 60, travelMin: 40, insideAirport: false, lat: 51.47, lng: -0.45 });
    assert.equal(plan.status, 200, plan.raw);
    const stopId = plan.body.stops[0].id;
    // execution
    const exec = await app.call("PATCH", `/api/airport/sessions/${anaSession}/stops/${stopId}`, ana, { durationMin: 75 });
    assert.equal(exec.status, 200, exec.raw);
    // return
    const ret = await app.call("POST", `/api/airport/sessions/${anaSession}/return-now`, ana, {});
    assert.equal(ret.status, 200, ret.raw);
    assert.equal(ret.body.returnContract.hardReturnTime, ev.body.hardReturnTime, "the deadline evaluated is the deadline returned by");
    states.push((await sessionRow(db, anaSession)).state);
    // completion
    const done = await app.call("DELETE", `/api/airport/sessions/${anaSession}?outcome=completed`, ana);
    assert.equal(done.status, 200, done.raw);
    const end = await sessionRow(db, anaSession);
    states.push(end.state);
    assert.equal(end.status, "completed");
    assert.deepEqual([states[0], states[2], states[3]], ["DETECTED", "RETURNING", "COMPLETED"], JSON.stringify(states));
    const trail = (await db.query<any>(`SELECT event_type FROM public.layover_events WHERE session_id = '${anaSession}' ORDER BY created_at`)).map((e) => e.event_type);
    for (const t of ["session_created", "plan_stop_added", "plan_stop_updated", "safe_return_aborted", "session_completed"]) assert.ok(trail.includes(t), `${t} missing from ${JSON.stringify(trail)}`);
  });

  it("P7 L11 — the traveller's disruption report (the existing route, source traveller) is recorded on the Trips flight it is linked to", async () => {
    bobTrip = await createTrip(db, bob, [cy]);
    ({ inbound: bobIn, onward: bobOut } = await enterFlights(app, bob, bobTrip, t0));
    const sb = await app.call("POST", `/api/trips/${bobTrip}/layover-connections`, bob, { arrivalSegmentId: bobIn.id, departureSegmentId: bobOut.id });
    assert.equal(sb.status, 201, sb.raw); bobSession = sb.body.session.id;
    const sc = await app.call("POST", `/api/trips/${bobTrip}/layover-connections`, cy, { arrivalSegmentId: bobIn.id, departureSegmentId: bobOut.id });
    assert.equal(sc.status, 201, sc.raw); cySession = sc.body.session.id;
    assert.notEqual(cySession, bobSession, "a crew-mate on the same flights has their own session");
    const newDep = iso(t0 + 7.5 * H);
    const d = await app.call("POST", `/api/airport/sessions/${bobSession}/disruption`, bob, { kind: "delay", newDepartureTime: newDep });
    assert.equal(d.status, 200, d.raw);
    assert.equal(d.body.disruption.source, "traveller");
    assert.equal(d.body.flightSegment?.recorded, true, d.raw);
    assert.equal(d.body.flightSegment.segmentId, bobOut.id);
    const seg = await segmentRow(db, bobOut.id);
    assert.equal(Date.parse(seg.estimated_departure_at), Date.parse(newDep));
    assert.equal(seg.flight_status, "delayed");
    assert.equal(seg.flight_status_source, "traveller");
    assert.equal(Date.parse((await sessionRow(db, cySession)).departure_time), t0 + 7 * H, "a traveller's report never moves a crew-mate's deadline");
  });

  it("P7b L11 — the traveller's own flight update (Trips status route): recorded as source traveller; only THEIR linked session follows; a user may not claim to be a feed", async () => {
    const before = Date.parse(String((await sessionRow(db, bobSession)).arrival_time));
    const r = await app.call("POST", `/api/trips/${bobTrip}/flight-segments/${bobIn.id}/status`, cy, { estimatedArrivalLocal: wall("Europe/London", t0 + 1.5 * H), arrivalGate: "C4" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.outcome.changes.arrivalMovedMinutes, 30);
    assert.deepEqual(r.body.outcome.sessions.map((x: any) => x.sessionId), [cySession], "only the reporter's own session");
    assert.equal(Date.parse(String((await sessionRow(db, cySession)).arrival_time)), t0 + 1.5 * H);
    assert.equal(Date.parse(String((await sessionRow(db, bobSession)).arrival_time)), before, "a traveller's report never moves a crew-mate's window");
    const seg = await segmentRow(db, bobIn.id);
    assert.equal(seg.flight_status_source, "traveller");
    assert.equal(seg.arrival_gate, "C4");
    const forged = await db.query<any>(`SELECT public.trip_kernel_execute(jsonb_build_object('trip_id', '${bobTrip}', 'actor_user_id', '${cy.id}', 'command_id', gen_random_uuid(), 'idempotency_key', 'forge-1', 'type', 'RECORD_FLIGHT_STATUS', 'payload', jsonb_build_object('segment_id', '${bobIn.id}', 'source', 'feed', 'observed_at', now(), 'flight_status', 'landed'))) AS r`);
    assert.equal(forged[0].r.ok, false);
    assert.match(forged[0].r.detail, /source must be traveller for a user/);
    const outsider = await app.call("POST", `/api/trips/${bobTrip}/flight-segments/${bobIn.id}/status`, eve, { status: "delayed" });
    assert.equal(outsider.status, 403, outsider.raw);
  });

  it("P8 L259 L11 — an approved feed's update fans out by FLIGHT SUBJECT: every linked session recalculated, deadlines moved, the replan run", async () => {
    const nowMs = Date.now();
    const r = await applyFlightStatusUpdate(db.client, {
      source: "feed", feedId: "contract-fixture", observedAt: iso(nowMs),
      flight: { carrierCode: "BA", flightNumber: "1442", scheduledDepartureAt: iso(t0 + 7 * H) },
      observation: { estimatedDepartureAt: iso(t0 + 8 * H), departureGate: "A10", status: "delayed" },
    }, { nowMs });
    assert.ok(r.ok, JSON.stringify(r));
    const seg = r.segments.find((s) => s.segmentId === bobOut.id)!;
    assert.ok(seg && seg.recorded, JSON.stringify(r.segments).slice(0, 600));
    assert.equal(seg.changes!.departureMovedMinutes, 30, "measured from the best-known 7.5h (Bob's report) to 8h");
    const delayed = seg.replan.find((x) => x.eventType === "flight.departure_delayed")!;
    assert.ok(delayed.report.ok, JSON.stringify(delayed.report));
    assert.equal((delayed.report as any).impacted, 2, "the replan port found BOTH linked sessions through the flight axis");
    assert.deepEqual(seg.sessions.map((s) => s.sessionId).sort(), [bobSession, cySession].sort());
    for (const s of seg.sessions) {
      assert.equal(s.synced, true, JSON.stringify(s));
      assert.equal(s.role, "departure");
      assert.ok(Date.parse(s.after!.hardReturnTime) > Date.parse(s.before!.hardReturnTime), "the return deadline moved later with the departure");
      assert.equal(s.missedConnection!.risk, "on_track");
    }
    for (const id of [bobSession, cySession]) assert.equal(Date.parse((await sessionRow(db, id)).departure_time), t0 + 8 * H);
    for (const id of [bobSession, cySession]) assert.equal((await sessionRow(db, id)).state, "DISRUPTED", "§5: a delay that moves the deadline materially is a disruption (Bob's own report already made his one)");
    const row = await segmentRow(db, bobOut.id);
    assert.equal(row.flight_status_source, "feed");
    assert.equal(row.departure_gate, "A10");
    // the feed matched every Trips segment carrying BA1442 at that schedule — Ana's too, and it touched no ended session
    assert.ok(r.segments.some((s) => s.segmentId === anaOut.id && s.recorded && s.sessions.length === 0));
  });

  it("P9 — an observation older than the one the flight holds is refused (TRIP_FLIGHT_STATUS_STALE) and moves nothing", async () => {
    const nowMs = Date.now();
    const before = (await sessionRow(db, bobSession)).departure_time;
    const r = await applyFlightStatusUpdate(db.client, {
      source: "feed", feedId: "contract-fixture", observedAt: iso(nowMs - 30 * 60_000),
      flight: { carrierCode: "BA", flightNumber: "1442", scheduledDepartureAt: iso(t0 + 7 * H) },
      observation: { estimatedDepartureAt: iso(t0 + 6 * H) },
    }, { nowMs });
    assert.ok(r.ok);
    const seg = r.segments.find((s) => s.segmentId === bobOut.id)!;
    assert.equal(seg.recorded, false);
    assert.equal(seg.refusal, "TRIP_FLIGHT_STATUS_STALE");
    assert.equal(Date.parse(String((await sessionRow(db, bobSession)).departure_time)), Date.parse(String(before)));
  });

  it("P10 L33 — missed-connection risk and §5: an inbound now landing after the onward leaves is MISSED, the schedule is not forced, the state is DISRUPTED", async () => {
    const nowMs = Date.now();
    const r = await applyFlightStatusUpdate(db.client, {
      source: "feed", feedId: "contract-fixture", observedAt: iso(nowMs),
      flight: { carrierCode: "BA", flightNumber: "286", scheduledDepartureAt: iso(t0 - 9 * H) },
      observation: { estimatedArrivalAt: iso(t0 + 8.5 * H), status: "delayed" },
    }, { nowMs });
    assert.ok(r.ok, JSON.stringify(r));
    const seg = r.segments.find((s) => s.segmentId === bobIn.id)!;
    assert.ok(seg.recorded, JSON.stringify(seg).slice(0, 400));
    for (const s of seg.sessions) {
      assert.equal(s.role, "arrival");
      assert.equal(s.synced, false);
      assert.equal(s.syncRefusal, "inbound_lands_after_onward_departs");
      assert.equal(s.missedConnection!.risk, "missed", JSON.stringify(s.missedConnection));
      assert.ok(s.state?.ok && (s.state.to === "DISRUPTED" || (s.state.from === "DISRUPTED" && s.state.refusal === "no_edge")), JSON.stringify(s.state));
    }
    assert.equal((await sessionRow(db, cySession)).state, "DISRUPTED");
    const view = await app.call("GET", `/api/trips/${bobTrip}/layover-connections`, cy);
    assert.equal(view.body.connections[0].missedConnection.risk, "missed");
    assert.equal(view.body.connections[0].session.state, "DISRUPTED", "L267: the Trips card shows the disrupted state");
  });

  it("P11 L33 — the onward cancelled: DEPARTURE_CANCELLED → CANCELLED (the lifecycle), while the session stays live for recovery", async () => {
    const nowMs = Date.now();
    const r = await applyFlightStatusUpdate(db.client, {
      source: "feed", feedId: "contract-fixture", observedAt: iso(nowMs),
      flight: { carrierCode: "BA", flightNumber: "1442", scheduledDepartureAt: iso(t0 + 7 * H) },
      observation: { status: "cancelled" },
    }, { nowMs });
    assert.ok(r.ok);
    const seg = r.segments.find((s) => s.segmentId === bobOut.id)!;
    assert.deepEqual(seg.replan.map((x) => x.eventType), ["flight.cancelled"]);
    for (const id of [bobSession, cySession]) {
      const row = await sessionRow(db, id);
      assert.equal(row.state, "CANCELLED");
      assert.equal(row.status, "active", "a cancelled departure is a traveller still mid-layover (L-CL02c)");
    }
    const ov = await app.call("GET", `/api/airport/sessions/${bobSession}/overview`, bob);
    assert.equal(ov.status, 200, ov.raw);
    assert.equal((await sessionRow(db, bobSession)).state, "CANCELLED", "the projection does not overwrite what a flight observation established");
  });

  it("P12 L259 — the flight-subject reads are served by 3827's indexes", async () => {
    // Give the planner a selective population. On a six-row fixture PostgreSQL
    // legitimately prefers the status index; that says nothing about this index.
    const population = await db.seedUser("flight-index-population");
    await db.exec(`INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time,status) SELECT '${population.id}',now(),now()+interval '6 hours','active' FROM generate_series(1,10000); ANALYZE public.layover_sessions;`);
    for (const [col, idx] of [["arrival_segment_id", "layover_sessions_arrival_segment_idx"], ["departure_segment_id", "layover_sessions_departure_segment_idx"]]) {
      const plan = String(await (db as any).explain(`SELECT * FROM public.layover_sessions WHERE ${col} IN ('${bobOut.id}', '${bobIn.id}') AND status = 'active'`));
      assert.match(plan, new RegExp(`"Index Name":\\s*"${idx}"`), `${col}: ${plan.slice(0, 300)}`);
      assert.match(plan, new RegExp(`"Index Cond":\\s*"\\(${col} = ANY`), `the index is SEARCHED on ${col}, not merely scanned: ${plan.slice(0, 400)}`);
    }
    const p = await (db as any).explain(`SELECT * FROM public.trip_transport_segments WHERE mode = 'flight' AND carrier_code = 'BA' AND flight_number = '1442' AND planned_departure_at BETWEEN now() AND now() + interval '1 day'`);
    assert.match(String(p), /"Index Name":\s*"idx_trip_transport_segments_flight"/);
    assert.match(String(p), /"Index Cond":\s*"\(\(carrier_code = 'BA'::text\) AND \(flight_number = '1442'::text\)/, `the feed's identity is searched on the designator: ${String(p).slice(0, 400)}`);
  });

  it("P13 L21 (3828) — the active snapshot and its confidence band follow the newest persisted computation", async () => {
    await db.setFlags({ layover_decision_persistence_enabled: true });
    const t1 = unambiguousT0(Date.now() + 5 * 60_000);
    const trip = await createTrip(db, eve);
    const { inbound, onward } = await enterFlights(app, eve, trip, t1);
    const s = await app.call("POST", `/api/trips/${trip}/layover-connections`, eve, { arrivalSegmentId: inbound.id, departureSegmentId: onward.id });
    assert.equal(s.status, 201, s.raw);
    const sid = s.body.session.id;
    const o1 = await app.call("GET", `/api/airport/sessions/${sid}/overview`, eve);
    assert.equal(o1.status, 200, o1.raw);
    const comps = async () => db.query<any>(`SELECT snapshot_id, snapshot_version, confidence FROM public.layover_certified_computations WHERE session_id = '${sid}' ORDER BY snapshot_version`);
    let c = await comps();
    assert.ok(c.length >= 1, "persistence ON stores the certification");
    let row = await sessionRow(db, sid);
    assert.equal(row.active_snapshot_id, c[c.length - 1].snapshot_id);
    assert.equal(row.confidence_band, c[c.length - 1].confidence);
    const p = await app.call("PATCH", `/api/airport/sessions/${sid}`, eve, { departureTime: iso(t1 + 6.5 * H) });
    assert.equal(p.status, 200, p.raw);
    await app.call("GET", `/api/airport/sessions/${sid}/overview`, eve);
    c = await comps();
    assert.ok(c.length >= 2, `a recomputation is a new snapshot (${c.length})`);
    row = await sessionRow(db, sid);
    assert.equal(row.active_snapshot_id, c[c.length - 1].snapshot_id, "the pointer moved to the newest version");
    await db.setFlags({ layover_decision_persistence_enabled: false });
  });
});

describe("B1-F — the flags OFF: nothing new answers, nothing new is written, the old surfaces are as they were", { skip: PRESSED_SKIP_REASON }, () => {
  let db: PressedDb; let app: App; let ana: PressedUser;
  before(async () => {
    db = await openPressedLayoverDb();
    await productionBaseFlags(db);
    await db.setFlags({ trip_flight_segments_enabled: false, layover_flight_connections_enabled: false, airport_mode_enabled: true });
    app = await startApp(db);
    ana = await db.seedUser("ana");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("O1 every new route refuses feature_disabled and writes nothing; the disruption route carries no flightSegment", async () => {
    const trip = await createTrip(db, ana);
    const t0 = unambiguousT0(Date.now() + 5 * 60_000);
    const add = await app.call("POST", `/api/trips/${trip}/flight-segments`, ana, { flight: "BA1", departureAirport: "LHR", arrivalAirport: "EDI", departureLocal: wall("Europe/London", t0 + H), arrivalLocal: wall("Europe/London", t0 + 2 * H) });
    assert.equal(add.status, 404, add.raw);
    assert.equal(add.body.error, "feature_disabled");
    assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM public.trip_transport_segments WHERE trip_id = '${trip}'`))[0].n, 0);
    const get = await app.call("GET", `/api/trips/${trip}/layover-connections`, ana);
    assert.equal(get.status, 404, get.raw);
    const s = await app.call("POST", "/api/airport/sessions", ana, { iata: "HKG", arrivalTime: iso(t0), departureTime: iso(t0 + 6 * H), flightType: "international" });
    assert.equal(s.status, 201, s.raw);
    const d = await app.call("POST", `/api/airport/sessions/${s.body.session.id}/disruption`, ana, { kind: "delay", delayMinutes: 20 });
    assert.equal(d.status, 200, d.raw);
    assert.ok(!("flightSegment" in d.body), "byte-identical: no flightSegment key while the flag is off");
    const r = await applyFlightStatusUpdate(db.client, { source: "feed", observedAt: iso(Date.now()), flight: { carrierCode: "BA", flightNumber: "1", scheduledDepartureAt: iso(t0) }, observation: { status: "delayed" } }, { nowMs: Date.now() });
    assert.deepEqual(r, { ok: false, reason: "feature_disabled", message: "Flight-status updates are not enabled" });
  });
});

describe("B1-F — the migrations ABSENT (the chain without 3826-3828): the old surfaces work unchanged", { skip: PRESSED_SKIP_REASON || (process.env["PRESSED_BASE"] ? "§83: production has 3826-3828 and both flags ON, so the absent-and-unflagged arm is not a production state" : false) }, () => {
  let db: PressedDb; let app: App; let ana: PressedUser;
  before(async () => {
    db = await openPressedLayoverDb({ without: ["3826", "3827", "3828"] });
    await productionBaseFlags(db);
    await db.setFlags({ airport_mode_enabled: true });
    app = await startApp(db);
    ana = await db.seedUser("ana");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("A1 a typed session is created as before; the flight routes answer feature_disabled (no flag row); the kernel has no RECORD_FLIGHT_STATUS", async () => {
    const t0 = minute(Date.now()) + 5 * 60_000;
    const s = await app.call("POST", "/api/airport/sessions", ana, { iata: "ICN", arrivalTime: iso(t0), departureTime: iso(t0 + 6 * H), flightType: "international" });
    assert.equal(s.status, 201, s.raw);
    const row = await sessionRow(db, s.body.session.id);
    assert.ok(!("state" in row) && !("arrival_segment_id" in row), "no 3827 column");
    const trip = await createTrip(db, ana);
    assert.equal((await app.call("GET", `/api/trips/${trip}/layover-connections`, ana)).status, 404);
    assert.equal((await app.call("GET", `/api/trips/${trip}/flight-segments`, ana)).status, 404);
    const k = await db.query<any>(`SELECT position('RECORD_FLIGHT_STATUS' in pg_get_functiondef('public.trip_kernel_execute'::regproc)) AS p`);
    assert.equal(Number(k[0].p), 0);
  });
});
