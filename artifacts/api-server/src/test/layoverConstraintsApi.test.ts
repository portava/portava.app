/**
 * LAY-01 over the REAL router — `GET` / `PUT /airport/sessions/:id/constraints`,
 * the constraint fields on `POST /airport/sessions`, the refusal on `PATCH`,
 * and the gate published on `/overview` and `/safety`.
 *
 * census-layover L172 (`updateConstraint(sessionId, patch)`), L22, L35, L49,
 * L229 — as a traveller's requests, not as function calls. The engine and the
 * store have their own suites (`layoverConstraintGate.test.ts`,
 * `services/layover/__tests__/layoverConstraintStore.test.ts`); this one exists
 * because a helper with no route is not a feature.
 *
 * ── WHAT COULD MAKE IT PASS WITHOUT THE PROPERTY ────────────────────────────
 *  * A 200 that changed nothing. Every write is followed by a read of the
 *    TABLE and by a second request that must see the change.
 *  * A window on which bags never matter. The decisive layover length is found
 *    at run time against the real clock and the suite refuses to run without it.
 *  * An outage rendered as "nothing declared". The unreadable store is staged
 *    and must be a 503 on the constraints read while `/overview` keeps
 *    answering with the cautious arithmetic.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverConstraintsApi.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import layoverConstraintsRouter from "../routes/layoverConstraints.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { airportRowToProfile } from "../services/airport/AirportProfileService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";

const TOKEN = "constraints-token";
const USER = "constraints-user";
const OTHER_TOKEN = "other-token";
const OTHER = "other-user";
const SESSION = "session-constraints-api";
const AIRPORT = airportRowToProfile(airportRow({ verified: false }));

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

/**
 * A layover length, measured against the REAL clock the routes read, on which
 * one bag flips the verdict — and the middle of the band it holds over, so a
 * few milliseconds between this search and the request cannot move it.
 */
function decisiveMinutes(nowMs: number): number {
  const flips = (m: number) => {
    const s = {
      id: "probe", arrivalTime: new Date(nowMs).toISOString(), departureTime: new Date(nowMs + m * 60_000).toISOString(),
      boardingTime: null, flightType: "international" as const, immigrationRequired: true, wantsToLeave: true,
    };
    const a = certifySessionFeasibility(AIRPORT, { ...s, checkedBags: false } as never, { nowMs }).verdict;
    const b = certifySessionFeasibility(AIRPORT, { ...s, checkedBags: true } as never, { nowMs }).verdict;
    return a !== b && a !== "no" && b !== "no";
  };
  for (let m = 200; m < 900; m += 1) {
    if (!flips(m)) continue;
    let end = m;
    while (flips(end + 1)) end += 1;
    if (end - m >= 10) return Math.floor((m + end) / 2);
    m = end;
  }
  throw new Error("fixture: no window found where checked bags move the verdict");
}

function stage(opts: {
  storage?: boolean;
  entryPolicy?: boolean;
  minutes?: number;
  session?: Record<string, unknown>;
  constraints?: Array<Record<string, unknown>>;
  failures?: Record<string, { message: string; code?: string }>;
  airportMode?: boolean;
  /** `layover_snapshot_consumers_enabled` (migration 3465) — the snapshot door. */
  snapshotConsumers?: boolean;
  /**
   * Stage a curated corridor that PERMITS entry (US passport → TW) with entry
   * intelligence on. Without it every verdict in this file tops out at
   * `entry_unverified`, and "open" would be asserted by nothing.
   */
  entryPermitted?: boolean;
  stops?: Array<Record<string, unknown>>;
} = {}) {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: opts.airportMode !== false },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      ...(opts.storage !== undefined ? [{ flag: "layover_constraints_enabled", enabled: opts.storage }] : []),
      ...(opts.entryPolicy !== undefined ? [{ flag: "layover_entry_forbid_landside_enabled", enabled: opts.entryPolicy }] : []),
      ...(opts.snapshotConsumers !== undefined ? [{ flag: "layover_snapshot_consumers_enabled", enabled: opts.snapshotConsumers }] : []),
      ...(opts.entryPermitted ? [{ flag: "passport_entry_intelligence_enabled", enabled: true }] : []),
    ],
    ...(opts.entryPermitted ? {
      traveler_passports: [{ user_id: USER, issuing_country: "US", is_primary: true, created_at: "2026-01-01T00:00:00.000Z" }],
      entry_requirements: [{
        id: "corr-visa-free", passport_country: "US", destination_country: "TW", status: "visa_free",
        allowed_stay_days: null, passport_validity_rule: null, fee_text: null, processing_time_text: null,
        official_source_url: null, notes: null, confidence: "high", last_verified_at: "2026-09-01T00:00:00.000Z",
      }],
    } : {}),
    airport_profiles: [airportRow({ verified: false })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(now).toISOString(),
        departure_time: new Date(now + (opts.minutes ?? 12 * 60) * 60_000).toISOString(),
        flight_type: "international", immigration_required: true, checked_bags: false,
        ...opts.session,
      }),
    ],
    layover_plan_stops: (opts.stops ?? []).map((s, i) => ({
      id: `stop-${i}`, session_id: SESSION, stop_order: i, description: null, place_id: null, recommendation_id: null,
      lat: null, lng: null, location_label: null, source: "user", created_at: new Date(now + i).toISOString(), ...s,
    })),
    layover_recommendations: [],
    layover_events: [],
    trip_plan_items: [], trips: [], trip_members: [],
    blocks: [], profiles: [], location_preferences: [],
  };
  if (opts.constraints) tables.layover_constraints = opts.constraints.map((r) => ({ session_id: SESSION, ...r }));
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER, [OTHER_TOKEN]: OTHER }, failures: opts.failures }) as any, true);
  return tables;
}

function send(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

const CONSTRAINTS = `/api/airport/sessions/${SESSION}/constraints`;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  // Mounted in the order `routes/index.ts` mounts them.
  app.use("/api", airportRouter);
  app.use("/api", layoverConstraintsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /airport/sessions/:id/constraints", () => {
  it("storage OFF: says so, offers only the baggage field, and publishes the certified gate", async () => {
    stage();
    const r = await send("GET", CONSTRAINTS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.storage, "session_booleans_only");
    assert.deepEqual(r.body.declarable, ["baggageMode"]);
    assert.equal(r.body.constraints, null);
    assert.equal(r.body.baggageCharged, false);
    // THIS CASE ASSERTED BLOCKER 1. Both flags off, twelve hours, a border
    // nobody has checked: it expected `landsideGate.open === true` and
    // `layoverState === "LANDSIDE_AVAILABLE"`, which the app drew as a green
    // "You can go out" under "Time is fine — entry unconfirmed".
    assert.equal(r.body.verdict, "entry_unverified");
    assert.equal(r.body.landsideGate.open, false);
    assert.equal(r.body.landsideGate.status, "caution");
    assert.deepEqual(r.body.landsideGate.closedBy, []);
    assert.deepEqual(r.body.landsideGate.cautions, ["entry_unconfirmed"]);
    assert.equal(r.body.landsideGate.constraintsRead, "legacy");
    assert.equal(r.body.layoverState, null);
    assert.equal(r.body.layoverStateUnavailableReason, "landside_unconfirmed");
    assert.equal(r.body.question, null);
    assert.match(r.body.snapshotId, /^snap:/);
    assert.equal("layover_constraints" in tables, false, "the store was read with the flag off");
  });

  it("storage ON: the latest declared version, and every field declarable", async () => {
    stage({ storage: true, constraints: [
      { version: 1, baggage_mode: "UNKNOWN", recheck_required: null, airport_change_required: null },
      { version: 2, baggage_mode: "CARRY_ON_ONLY", recheck_required: true, airport_change_required: false },
    ] });
    const r = await send("GET", CONSTRAINTS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.storage, "versioned");
    assert.deepEqual(r.body.declarable, ["baggageMode", "recheckRequired", "airportChangeRequired"]);
    assert.equal(r.body.constraints.version, 2);
    assert.equal(r.body.constraints.baggageMode, "CARRY_ON_ONLY");
    assert.equal(r.body.constraints.recheckRequired, true);
    assert.ok(r.body.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
  });

  it("an UNREADABLE store is a 503 with retry here — and /overview still answers, cautiously", async () => {
    stage({ storage: true, failures: { "layover_constraints:select": { message: "relation \"layover_constraints\" does not exist" } } });
    const r = await send("GET", CONSTRAINTS);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);

    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.equal(ov.body.landsideGate.constraintsRead, "unreadable");
    assert.equal(ov.body.window.breakdown.bagsExtra, 15, "an unreadable declaration was computed as 'no checked bags'");
  });

  it("BLOCKER 2 — an unreadable store on a 12 h layover with a CONFIRMED border: closed on every surface", async () => {
    // "Cautiously" above meant the bag term. The GATE stayed open: on a long
    // window no bag term can change the verdict, so nothing closed it, and the
    // unread set's airport change was read as `null` = no.
    const failures = { "layover_constraints:select": { message: "connection reset" } };
    stage({ storage: true, entryPermitted: true, failures, stops: [{ title: "Night market", duration_min: 30, travel_min: 20, inside_airport: false }] });
    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.equal(ov.body.advice.verdict, "no");
    assert.equal(ov.body.landsideGate.open, false);
    assert.ok(ov.body.landsideGate.closedBy.includes("constraints_unreadable"), JSON.stringify(ov.body.landsideGate));
    assert.equal(ov.body.landsideGate.entryPermissionState, "CONFIRMED_ALLOWED");
    assert.equal(ov.body.layoverState, "AIRPORT_ONLY");
    assert.equal(ov.body.planFit.fit, "blocked");
    assert.equal(ov.body.planFit.fitsWindow, false);
    assert.ok(ov.body.planFit.landside.closedBy.includes("constraints_unreadable"));
    const safety = await send("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(safety.body.overallRating, "not_recommended");
    assert.equal(safety.body.landsideGate.open, false);
    const recs = await send("GET", `/api/airport/sessions/${SESSION}/recommendations`);
    assert.equal(recs.status, 200, JSON.stringify(recs.body));
    assert.equal(recs.body.recommendations.filter((x: any) => !x.insideAirport).length, 0, "landside recommendations were served on an unreadable store");

    // CONTROL — the SAME world with the store readable and every question
    // answered is the affirmative path, end to end. Without this the block
    // above would pass on a gate that closes everything.
    stage({
      storage: true, entryPermitted: true,
      constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: false, airport_change_required: false }],
      stops: [{ title: "Night market", duration_min: 30, travel_min: 20, inside_airport: false }],
    });
    const good = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(good.body.advice.verdict, "yes", JSON.stringify(good.body.advice));
    assert.equal(good.body.landsideGate.open, true);
    assert.equal(good.body.layoverState, "PLAN_SELECTED");
    assert.equal(good.body.planFit.fit, "fits");
    assert.equal(good.body.planFit.fitsWindow, true);
    const card = await send("GET", CONSTRAINTS);
    assert.equal(card.body.layoverState, "PLAN_SELECTED");
    assert.equal(card.body.verdict, "yes");
  });

  it("is the traveller's own: 404 for another user's session, 401 with no token, 404 when Layover is off", async () => {
    stage({ storage: true });
    assert.equal((await send("GET", CONSTRAINTS, undefined, OTHER_TOKEN)).status, 404);
    assert.equal((await send("GET", CONSTRAINTS, undefined, null)).status, 401);
    assert.equal((await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN" }, OTHER_TOKEN)).status, 404);
    assert.equal((tables.layover_constraints ?? []).length, 0, "another user's PUT wrote a version");
    stage({ storage: true, airportMode: false });
    const off = await send("GET", CONSTRAINTS);
    assert.equal(off.status, 404);
    assert.equal(off.body.error, "feature_disabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PUT /airport/sessions/:id/constraints — L172", () => {
  it("storage ON: appends a version, mirrors the boolean, and the next read sees it", async () => {
    stage({ storage: true });
    const put = await send("PUT", CONSTRAINTS, { baggageMode: "COLLECT_RECHECK", recheckRequired: true });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.stored, "versioned");
    assert.deepEqual(put.body.unsaved, []);
    assert.equal(put.body.sessionSynced, true);
    assert.equal(put.body.constraints.version, 1);
    assert.ok(["stored", "off", "not_stored"].includes(put.body.persisted.state), JSON.stringify(put.body.persisted));

    assert.equal(tables.layover_constraints.length, 1);
    assert.equal(tables.layover_constraints[0].baggage_mode, "COLLECT_RECHECK");
    assert.equal(tables.layover_constraints[0].snapshot_id, put.body.snapshotId, "the stored version cites a different computation from the one published");
    assert.equal(tables.layover_sessions[0].checked_bags, true);

    const get = await send("GET", CONSTRAINTS);
    assert.equal(get.body.constraints.version, 1);
    assert.equal(get.body.baggageCharged, true);

    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.body.window.breakdown.bagsExtra, 15);
    assert.ok(ov.body.advice.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
    assert.equal(ov.body.session.constraints.set.version, 1);
  });

  it("L49 / L229 — UNKNOWN on a decisive window: one question, NEEDS_INFO, landside closed on every surface; answering re-opens it", async () => {
    // The two connection questions are answered in the same declaration, so the
    // bag mode is the ONE unknown. (Left unstated they are unknowns of their
    // own now; the next case is that.) A confirmed border, so "re-opens" below
    // can mean OPEN and not merely "no longer closed".
    stage({ storage: true, entryPermitted: true, minutes: decisiveMinutes(Date.now()) });
    const put = await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN", recheckRequired: false, airportChangeRequired: false });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.verdict, "no");
    assert.equal(put.body.confidence, "INSUFFICIENT");
    assert.equal(put.body.layoverState, "NEEDS_INFO");
    assert.equal(put.body.landsideGate.open, false);
    assert.deepEqual(put.body.landsideGate.closedBy, ["baggage_unknown"]);
    assert.equal(put.body.question.field, "baggageMode");
    assert.ok(put.body.question.options.length >= 2);
    assert.ok(put.body.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"));
    assert.deepEqual(tables.layover_constraints[0].critical_unknowns, ["baggage_mode"]);

    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.body.advice.verdict, "no");
    assert.equal(ov.body.layoverState, "NEEDS_INFO");
    assert.equal(ov.body.landsideGate.needsInfo, "baggageMode");
    const safety = await send("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(safety.body.overallRating, "not_recommended");
    assert.equal(safety.body.landsideGate.open, false);
    const recs = await send("GET", `/api/airport/sessions/${SESSION}/recommendations`);
    assert.equal(recs.status, 200, JSON.stringify(recs.body));
    assert.equal(recs.body.recommendations.filter((x: any) => !x.insideAirport).length, 0);

    // The one answer.
    const answered = await send("PUT", CONSTRAINTS, { baggageMode: "CHECKED_THROUGH" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.verdict, "yes", "fixture: the decisive window is not `yes` once the bag is checked through");
    assert.equal(answered.body.landsideGate.open, true);
    assert.equal(answered.body.question, null);
    assert.equal(answered.body.layoverState, "LANDSIDE_AVAILABLE");
    assert.notEqual(answered.body.confidence, "INSUFFICIENT");
    assert.equal(tables.layover_constraints.length, 2, "the answer overwrote the question instead of appending");
    assert.equal((await send("GET", `/api/airport/sessions/${SESSION}/overview`)).body.landsideGate.open, true);
  });

  it("BLOCKER 4 — \"Not sure\" on the airport change: closed, asked, and each answer resolves it", async () => {
    stage({ storage: true, entryPermitted: true, stops: [{ title: "Night market", duration_min: 30, travel_min: 20, inside_airport: false }] });
    // What the card's "Not sure" chip sends.
    const put = await send("PUT", CONSTRAINTS, { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: null });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.verdict, "no", "\"Not sure\" about an airport change was certified as \"no airport change\"");
    assert.equal(put.body.landsideGate.open, false);
    assert.deepEqual(put.body.landsideGate.closedBy, ["airport_change_unknown"]);
    assert.equal(put.body.layoverState, "NEEDS_INFO");
    assert.equal(put.body.question.field, "airportChangeRequired");
    assert.match(put.body.question.prompt, /different airport/i);
    assert.deepEqual(put.body.question.options.map((o: any) => o.value), [false, true]);
    assert.deepEqual(tables.layover_constraints[0].critical_unknowns, ["airport_change_required"]);
    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.body.planFit.fit, "blocked");
    assert.deepEqual(ov.body.planFit.landside.closedBy, ["airport_change_unknown"]);
    const stops = await send("GET", `/api/airport/sessions/${SESSION}/stops`);
    assert.equal(stops.body.planFit.fit, "blocked", "GET /stops and GET /overview disagree about the same plan");

    const no = await send("PUT", CONSTRAINTS, { airportChangeRequired: false });
    assert.equal(no.body.verdict, "yes", JSON.stringify(no.body));
    assert.equal(no.body.landsideGate.open, true);
    assert.equal(no.body.question, null);
    assert.equal((await send("GET", `/api/airport/sessions/${SESSION}/stops`)).body.planFit.fit, "fits");

    const yes = await send("PUT", CONSTRAINTS, { airportChangeRequired: true });
    assert.deepEqual(yes.body.landsideGate.closedBy, ["airport_change"]);
    assert.equal(yes.body.layoverState, "AIRPORT_ONLY");
    assert.equal(yes.body.question, null);
  });

  it("SHOULD-FIX 5 — the plan surfaces consult the gate: refused border, and the cautionary middle", async () => {
    const landsideStop = { title: "Night market", duration_min: 30, travel_min: 20, inside_airport: false };
    // Pre-existing `entry_refused`: hours of usable time, and a border that says no.
    stage({ entryPermitted: true, stops: [landsideStop] });
    tables.entry_requirements[0].status = "visa_required";
    const refused = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(refused.body.advice.verdict, "no");
    assert.deepEqual(refused.body.landsideGate.closedBy, ["entry_refused"]);
    assert.ok(refused.body.planFit.usableMinutes > 300, "fixture: the clock must not be what refuses this plan");
    assert.equal(refused.body.planFit.clockFit, "fits");
    assert.equal(refused.body.planFit.fit, "blocked", "a plan through the city `fits` under a refused border");
    assert.equal(refused.body.planFit.fitsWindow, false);

    // POST /stops answers with the same gated fit, not the clock's.
    const added = await send("POST", `/api/airport/sessions/${SESSION}/stops`, { title: "Temple", durationMin: 20, travelMin: 15, insideAirport: false });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.planFit.fit, "blocked");

    // Both flags off, border unchecked: not forbidden, and not a green `fits`.
    stage({ stops: [landsideStop] });
    const held = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(held.body.advice.verdict, "entry_unverified");
    assert.equal(held.body.planFit.fit, "unconfirmed");
    assert.equal(held.body.planFit.fitsWindow, false);
    assert.deepEqual(held.body.planFit.landside.cautions, ["entry_unconfirmed"]);
    // An airside-only plan is not the landside gate's business.
    stage({ stops: [{ title: "Lounge", duration_min: 30, travel_min: 0, inside_airport: true }] });
    assert.equal((await send("GET", `/api/airport/sessions/${SESSION}/overview`)).body.planFit.fit, "fits");
  });

  it("SHOULD-FIX 9 — an identical PUT is a no-op: one version, and the answer says `unchanged`", async () => {
    stage({ storage: true });
    const body = { baggageMode: "COLLECT_RECHECK", recheckRequired: true, airportChangeRequired: false };
    const first = await send("PUT", CONSTRAINTS, body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.unchanged, false);
    const events = tables.layover_events.length;
    const second = await send("PUT", CONSTRAINTS, body);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.unchanged, true);
    assert.equal(second.body.stored, "versioned");
    assert.equal(tables.layover_constraints.length, 1, "an identical declaration appended a second version");
    assert.equal(tables.layover_events.length, events, "an identical declaration wrote a second audit event");
    assert.equal(second.body.constraints.version, 1);
    // Not the snapshot id: each request certifies at its own instant. That the
    // two are the SAME computation at a fixed instant is asserted at the
    // service level (layoverConstraintStore.test.ts, same heading).
    assert.deepEqual(second.body.landsideGate, first.body.landsideGate);
    assert.equal(second.body.verdict, first.body.verdict);
  });

  it("the snapshot door ON says what OFF says: the declared set reaches the record either way", async () => {
    // `declareLayoverConstraints` and the GET ask `consumerLayoverRecord` first
    // (layoverSnapshotConsumers.test.ts C1). A snapshot that certified the
    // session WITHOUT its declared set would answer "landside open" here.
    const answers: Array<Record<string, unknown>> = [];
    for (const snapshotConsumers of [false, true]) {
      stage({ storage: true, minutes: decisiveMinutes(Date.now()), snapshotConsumers });
      const put = await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN" });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const get = await send("GET", CONSTRAINTS);
      assert.equal(get.status, 200, JSON.stringify(get.body));
      for (const body of [put.body, get.body]) {
        answers.push({
          verdict: body.verdict, confidence: body.confidence, layoverState: body.layoverState,
          landsideGate: body.landsideGate, reasonCodes: body.reasonCodes, question: body.question,
          constraints: { ...body.constraints, declaredAt: null },
        });
      }
    }
    assert.equal((answers[0].landsideGate as any).open, false);
    // `baggageMode: "UNKNOWN"` alone leaves both connection questions unstated,
    // so all three unknowns close it and the airport change is the one asked.
    assert.deepEqual((answers[0].landsideGate as any).closedBy, ["airport_change_unknown", "baggage_unknown", "recheck_unknown"]);
    assert.equal((answers[0].landsideGate as any).needsInfo, "airportChangeRequired");
    for (const a of answers.slice(1)) assert.deepEqual(a, answers[0]);
  });

  it("L224 — an airport change closes landside and reads AIRPORT_ONLY", async () => {
    stage({ storage: true });
    const put = await send("PUT", CONSTRAINTS, { baggageMode: "CARRY_ON_ONLY", airportChangeRequired: true });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.landsideGate.closedBy, ["airport_change"]);
    assert.equal(put.body.layoverState, "AIRPORT_ONLY");
    assert.ok(put.body.reasonCodes.includes("AIRPORT_CHANGE_REQUIRED"));
  });

  it("storage OFF: the mode is kept as the cautious boolean and what cannot be kept is named", async () => {
    stage();
    const put = await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN", recheckRequired: true });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.stored, "session_booleans_only");
    assert.deepEqual(put.body.unsaved, ["recheckRequired"]);
    assert.equal(put.body.constraints, null);
    assert.equal(tables.layover_sessions[0].checked_bags, true, "'not sure' was stored as 'no checked bags'");
    assert.equal("layover_constraints" in tables, false);
    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.body.window.breakdown.bagsExtra, 15);

    const only = await send("PUT", CONSTRAINTS, { airportChangeRequired: true });
    assert.equal(only.status, 409, JSON.stringify(only.body));
    assert.equal(only.body.error, "conflict");
  });

  it("refuses what it cannot keep, by name: an unknown field, an unknown mode, an empty body", async () => {
    stage({ storage: true });
    for (const body of [
      { mobilityProfile: "REDUCED" },
      // A VALID field beside one this route cannot keep: accepting the first
      // and dropping the second would report ok for half an edit.
      { baggageMode: "CARRY_ON_ONLY", mobilityProfile: "REDUCED" },
      { baggageMode: "TELEPORTED" },
      {},
      { baggageMode: null },
    ]) {
      const r = await send("PUT", CONSTRAINTS, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "invalid_payload");
    }
    assert.equal((tables.layover_constraints ?? []).length, 0);
  });

  it("a refused write is a retryable 503, not a 200 and not a 404", async () => {
    stage({ storage: true, failures: { "layover_constraints:insert": { message: "permission denied" } } });
    const r = await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.retryable, true);
    assert.equal(tables.layover_sessions[0].checked_bags, false);
  });

  it("a closed layover cannot be re-declared", async () => {
    stage({ storage: true, session: { status: "completed" } });
    const r = await send("PUT", CONSTRAINTS, { baggageMode: "UNKNOWN" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal((tables.layover_constraints ?? []).length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L48 / L230 — the entry policy, as a traveller's requests", () => {
  it("policy OFF (the seed): an unconfirmed corridor is `entry_unverified` — not forbidden, and not affirmed", async () => {
    // Was "…and landside stays open", asserting `open === true`. Nothing is
    // FORBIDDEN with the policy off — `closedBy` is empty and the city is still
    // offered — but the gate is not open and no surface may say "you can go".
    stage({ entryPolicy: false });
    const r = await send("GET", CONSTRAINTS);
    assert.equal(r.body.verdict, "entry_unverified");
    assert.equal(r.body.landsideGate.open, false);
    assert.equal(r.body.landsideGate.status, "caution");
    assert.deepEqual(r.body.landsideGate.closedBy, []);
    assert.equal(r.body.landsideGate.entryForbidsLandside, false);
    assert.equal(r.body.layoverState, null);
    const recs = await send("GET", `/api/airport/sessions/${SESSION}/recommendations`);
    assert.equal(recs.status, 200, JSON.stringify(recs.body));
  });

  it("policy ON: the same traveller is refused landside on every surface", async () => {
    stage({ entryPolicy: true });
    const r = await send("GET", CONSTRAINTS);
    assert.equal(r.body.verdict, "no");
    assert.deepEqual(r.body.landsideGate.closedBy, ["entry_unconfirmed"]);
    assert.equal(r.body.landsideGate.entryPermissionState, "UNKNOWN");
    assert.equal(r.body.layoverState, "AIRPORT_ONLY");
    const recs = await send("GET", `/api/airport/sessions/${SESSION}/recommendations`);
    assert.equal(recs.body.recommendations.filter((x: any) => !x.insideAirport).length, 0);
    const ov = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(ov.body.advice.verdict, "no");
    assert.ok(ov.body.advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /airport/sessions — the constraints a traveller states at the start", () => {
  const start = (extra: Record<string, unknown>) => send("POST", "/api/airport/sessions", {
    iata: "TPE",
    arrivalTime: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    departureTime: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    flightType: "international",
    ...extra,
  });
  const created = () => tables.layover_sessions[tables.layover_sessions.length - 1];

  it("L35 — 'not sure' is never stored as 'no checked bags', with or without the table", async () => {
    stage();
    const off = await start({ baggageMode: "UNKNOWN" });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.equal(created().checked_bags, true);
    assert.deepEqual(off.body.constraints, { stored: "session_booleans_only", version: null, unsaved: [], sessionSynced: true });
    assert.equal("layover_constraints" in tables, false);

    stage({ storage: true });
    const on = await start({ baggageMode: "UNKNOWN", recheckRequired: false, airportChangeRequired: false });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.equal(on.body.constraints.stored, "versioned");
    assert.equal(on.body.constraints.version, 1);
    assert.equal(created().checked_bags, true);
    const row = tables.layover_constraints.find((c) => c.session_id === on.body.session.id);
    assert.ok(row, "no constraint version was written for the new session");
    assert.equal(row.baggage_mode, "UNKNOWN");
    assert.equal(row.recheck_required, false);
  });

  it("a declared mode wins over a contradictory boolean in the same request", async () => {
    stage();
    await start({ baggageMode: "CARRY_ON_ONLY", checkedBags: true });
    assert.equal(created().checked_bags, false);
    stage();
    await start({ baggageMode: "COLLECT_RECHECK", checkedBags: false });
    assert.equal(created().checked_bags, true);
  });

  it("CONTROL — a request that states none of them is answered exactly as before", async () => {
    stage({ storage: true });
    const r = await start({ checkedBags: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal("constraints" in r.body, false, "a legacy create gained a constraints key");
    assert.equal(created().checked_bags, true);
    assert.equal((tables.layover_constraints ?? []).length, 0);
  });

  it("a declaration that could not be stored does not fail the create, and says so", async () => {
    stage({ storage: true, failures: { "layover_constraints:insert": { message: "permission denied" } } });
    const r = await start({ baggageMode: "UNKNOWN" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.constraints.stored, "not_stored");
    assert.equal(r.body.constraints.retryable, true);
    assert.equal(created().checked_bags, true, "the cautious boolean must be on the row whether or not the version was stored");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PATCH /airport/sessions/:id — constraints are not edited here", () => {
  it("refuses a declarable field rather than accepting and dropping it", async () => {
    stage({ storage: true });
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}`, { baggageMode: "UNKNOWN" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message, /constraints/);
    assert.equal(tables.layover_events.length, 0);
  });

  it("refuses `checkedBags` once a set is declared — the boolean no longer decides anything", async () => {
    stage({ storage: true, constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: null, airport_change_required: null }] });
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}`, { checkedBags: true });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(tables.layover_sessions[0].checked_bags, false);
  });

  it("CONTROL — with nothing declared `checkedBags` is still editable there", async () => {
    stage({ storage: true });
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}`, { checkedBags: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(tables.layover_sessions[0].checked_bags, true);
  });

  it("a flight-time edit certifies before and after under the SAME declared set", async () => {
    // The replanner compares two certified records. If only one of them carried
    // the declared set, every edit would report a verdict change it did not cause.
    stage({ storage: true, constraints: [{ version: 1, baggage_mode: "CARRY_ON_ONLY", recheck_required: null, airport_change_required: true }] });
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}`, {
      departureTime: new Date(Date.now() + 13 * 3_600_000).toISOString(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session.constraints.set.airportChangeRequired, true);
    if (r.body.replan?.ran) assert.equal(r.body.replan.diff.verdictChanged, false, JSON.stringify(r.body.replan.diff));
  });
});
