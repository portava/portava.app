/**
 * layoverMapBudget — spec §13's time-budget chips (census-layover L118):
 * "Changing time-budget chips triggers simulation/replanning, not local visual
 * filtering alone."
 *
 *   1. The pure rules: which chips are offered, which budgets are refused, and
 *      that narrowing touches ONE term of the record.
 *   2. On records the production certifier produces, through the production
 *      band pipeline (`mapBandedStops`, exported from routes/airport.ts):
 *        - PARITY: a record narrowed to B bands every stop exactly as a session
 *          CERTIFIED with B usable minutes does — the simulation is the
 *          certification at that budget, not a second rule;
 *        - MONOTONICITY: a smaller budget never yields a looser band;
 *        - the identity: narrowing to the certified figure changes nothing.
 *   3. Over the real router: POST /airport/sessions/:id/simulate (flags,
 *      refusals, the bands it answers, nothing stored) and the overview's
 *      `mapBudgetChips` (absent with the flag OFF).
 *   4. The route reads ONE certified record, once, and re-derives nothing.
 *
 * Run: node --import tsx/esm --test src/test/layoverMapBudget.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  MAP_BUDGET_FLOOR_MIN,
  MAP_BUDGET_LADDER_MIN,
  certifiedUsableMinutes,
  mapBudgetChipsFor,
  mapBudgetRefusal,
  narrowRecordToBudget,
  simulationStatement,
} from "../services/airport/layoverMapBudget.js";
import { LANDSIDE_AVAILABLE_FLOOR_MIN } from "../services/airport/LayoverLifecycle.js";
import { certifySessionFeasibility, type FeasibilityAirport } from "../services/airport/LayoverFeasibility.js";
import { certifiedPlanFit, landsideStatusOf } from "../services/airport/LayoverConstraints.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter, { mapBandedStops } from "../routes/airport.js";
import simulateRouter from "../routes/layoverSimulate.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js"; import { withConfirmedCorridor } from "./helpers/confirmedCorridor.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── fixtures on the production certifier ─────────────────────────────────────

function airport(): FeasibilityAirport & { lat: number; lng: number } {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    lat: 25.0797, lng: 121.2342,
  };
}
const ARRIVAL = Date.parse("2030-06-15T00:00:00.000Z");
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };
const REFUSED: EntryEligibility = { state: "refused", status: "visa_required", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const ENTRIES: Array<[string, EntryEligibility]> = [["permitted", PERMITTED], ["unresolved", UNRESOLVED], ["refused", REFUSED]];

function certify(minutes: number, entry: EntryEligibility) {
  return certifySessionFeasibility(airport(), {
    id: "s", arrivalTime: new Date(ARRIVAL).toISOString(), departureTime: new Date(ARRIVAL + minutes * 60_000).toISOString(),
    boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
  } as never, { nowMs: ARRIVAL, entry });
}
type Rec = ReturnType<typeof certify>;

/** A session the certifier gives EXACTLY `usable` minutes, found by its departure. */
function certifiedWithUsable(usable: number, entry: EntryEligibility): Rec {
  for (let m = usable; m <= usable + 900; m++) {
    const r = certify(m, entry);
    if (r.envelope.usableMinutes === usable) return r;
  }
  throw new Error(`no departure certifies exactly ${usable} usable minutes`);
}

/** Plan stops in the route's JSON shape: a sweep of stated legs and stays, near and far. */
const PLACES = [
  { lat: 25.0330, lng: 121.5654 }, // central Taipei, ~34 km
  { lat: 25.0560, lng: 121.2500 }, // ~3 km
  { lat: 24.1477, lng: 120.6736 }, // Taichung, ~118 km
  { lat: null, lng: null },        // no coordinate
];
function stopSweep() {
  const out: any[] = [];
  let i = 0;
  for (const travelMin of [5, 20, 45, 90]) for (const durationMin of [15, 60, 150]) for (const p of PLACES) {
    out.push({ id: `s${i++}`, title: `stop ${i}`, insideAirport: false, travelMin, durationMin, lat: p.lat, lng: p.lng });
  }
  out.push({ id: "unstated", title: "unstated", insideAirport: false, travelMin: 0, durationMin: 60, lat: 25.0560, lng: 121.2500 });
  out.push({ id: "airside", title: "lounge", insideAirport: true, travelMin: 0, durationMin: 45, lat: null, lng: null });
  return out;
}

const BANDS_ON = makeLayoverDb({ feature_flags: [{ flag: "layover_map_bands_enabled", enabled: true }] });
async function pipeline(record: Rec, stops: any[]) {
  return mapBandedStops(BANDS_ON, airport() as never, record, stops);
}

/**
 * The sweep banded TWO ways: as one plan (every stop TIGHT at best — the whole
 * plan overflows, which is its own rule) and each stop as a plan of its own (so
 * SAFE is reachable). Returns one banded stop per (way, stop), in a fixed order.
 */
async function pipelineBothWays(record: Rec, stops: any[]) {
  const whole = await pipeline(record, stops);
  const alone = await Promise.all(stops.map(async (s) => (await pipeline(record, [s]))[0]));
  return [...whole, ...alone];
}

const RANK: Record<string, number> = { SAFE: 0, TIGHT: 1, BLOCKED: 2 };

// ═══════════════════════════════════════════════════════════════════════════
// 1. The pure rules
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_GATE = { open: true, status: "open", closedBy: [], cautions: [], needsInfo: null } as any;
function rec(usable: number, over: Record<string, unknown> = {}) {
  return { envelope: { usableMinutes: usable }, landsideGate: OPEN_GATE, verdict: "yes" as const, ...over } as any;
}
const LANDSIDE = [{ insideAirport: false }];

describe("L118 — the ladder and the floor are not new numbers", () => {
  it("the floor is the engine's own landside floor, and every rung is at or above it, ascending", () => {
    assert.equal(MAP_BUDGET_FLOOR_MIN, LANDSIDE_AVAILABLE_FLOOR_MIN);
    assert.equal(MAP_BUDGET_FLOOR_MIN, 90);
    for (const b of MAP_BUDGET_LADDER_MIN) assert.ok(b >= MAP_BUDGET_FLOOR_MIN, `${b}`);
    assert.deepEqual([...MAP_BUDGET_LADDER_MIN], [...MAP_BUDGET_LADDER_MIN].sort((a, b) => a - b));
  });

  it("the floor is where the certifier's verdict changes category (89 is not 90)", () => {
    const at = certifiedWithUsable(90, PERMITTED);
    const below = certifiedWithUsable(89, PERMITTED);
    assert.equal(at.verdict, "yes");
    assert.equal(below.verdict, "tight");
    assert.equal(landsideStatusOf(at), "open");
    assert.notEqual(landsideStatusOf(below), "open");
  });
});

describe("L118 — which chips are offered", () => {
  it("every rung strictly below the certified figure, and none at or above it", () => {
    assert.deepEqual(mapBudgetChipsFor(rec(300), LANDSIDE), { available: true, withheld: null, certifiedUsableMinutes: 300, budgets: [90, 120, 180, 240] });
    assert.deepEqual(mapBudgetChipsFor(rec(240), LANDSIDE).budgets, [90, 120, 180]);
    assert.deepEqual(mapBudgetChipsFor(rec(241), LANDSIDE).budgets, [90, 120, 180, 240]);
    assert.deepEqual(mapBudgetChipsFor(rec(91), LANDSIDE).budgets, [90]);
  });

  it("nothing to narrow at or under the floor", () => {
    for (const u of [90, 60, 0]) {
      const c = mapBudgetChipsFor(rec(u), LANDSIDE);
      assert.equal(c.available, false);
      assert.equal(c.withheld, "nothing_to_narrow");
      assert.deepEqual(c.budgets, []);
    }
  });

  it("an unreadable record offers nothing (NaN, negative, fractional, absent)", () => {
    for (const u of [Number.NaN, -1, 150.5, Number.POSITIVE_INFINITY, undefined]) {
      const c = mapBudgetChipsFor(rec(u as number), LANDSIDE);
      assert.equal(c.withheld, "uncertified", String(u));
      assert.equal(c.certifiedUsableMinutes, null);
    }
    assert.equal(certifiedUsableMinutes(null), null);
    assert.equal(certifiedUsableMinutes({ envelope: undefined } as never), null);
  });

  it("a CLOSED gate offers nothing — by the gate or by the verdict", () => {
    assert.equal(mapBudgetChipsFor(rec(600, { landsideGate: { ...OPEN_GATE, open: false, status: "closed", closedBy: ["airport_change"] } }), LANDSIDE).withheld, "landside_closed");
    assert.equal(mapBudgetChipsFor(rec(600, { verdict: "no" }), LANDSIDE).withheld, "landside_closed");
  });

  it("a CAUTIONARY gate still offers chips (the bands say TIGHT, never SAFE)", () => {
    const c = mapBudgetChipsFor(rec(600, { verdict: "entry_unverified" }), LANDSIDE);
    assert.equal(landsideStatusOf(rec(600, { verdict: "entry_unverified" })), "caution");
    assert.equal(c.available, true);
  });

  it("no stop outside the airport: nothing to band, nothing offered", () => {
    assert.equal(mapBudgetChipsFor(rec(600), []).withheld, "no_landside_stop");
    assert.equal(mapBudgetChipsFor(rec(600), [{ insideAirport: true }]).withheld, "no_landside_stop");
    assert.equal(mapBudgetChipsFor(rec(600), [{ insideAirport: true }, { insideAirport: null }]).available, true);
  });
});

describe("L118 — a chip can only narrow, and only where that is sound", () => {
  it("above the certified figure is refused, naming the figure", () => {
    const r = mapBudgetRefusal(rec(240), 241);
    assert.equal(r?.reason, "above_certified");
    assert.equal(r?.certifiedUsableMinutes, 240);
    assert.match(r!.message, /240 minutes/);
    assert.equal(mapBudgetRefusal(rec(240), 240), null, "exactly the certified figure is a (trivial) narrowing");
  });

  it("below the floor is refused; at the floor it is not", () => {
    assert.equal(mapBudgetRefusal(rec(600), MAP_BUDGET_FLOOR_MIN - 1)?.reason, "below_floor");
    assert.equal(mapBudgetRefusal(rec(600), MAP_BUDGET_FLOOR_MIN), null);
  });

  it("a certified figure under the floor admits no budget", () => {
    assert.equal(mapBudgetRefusal(rec(80), 90)?.reason, "above_certified");
    assert.equal(mapBudgetRefusal(rec(80), 60)?.reason, "below_floor");
  });

  it("an unreadable record is refused whatever the budget", () => {
    for (const u of [Number.NaN, -5, 99.5]) assert.equal(mapBudgetRefusal(rec(u), 120)?.reason, "uncertified", String(u));
  });

  it("a budget that is not a positive whole number is not a budget", () => {
    for (const b of [0, -30, 120.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(mapBudgetRefusal(rec(600), b)?.reason, "not_a_budget", String(b));
  });

  it("narrowing changes ONE term: the deadline, the gate and the rest are the record's own objects", () => {
    const r = certify(600, PERMITTED);
    const n = narrowRecordToBudget(r, 120);
    assert.equal(n.envelope.usableMinutes, 120);
    assert.equal(r.envelope.usableMinutes, certify(600, PERMITTED).envelope.usableMinutes, "the certified record is not mutated");
    assert.equal(n.deadline, r.deadline);
    assert.equal(n.landsideGate, r.landsideGate);
    assert.equal(n.inputs, r.inputs);
    assert.equal(n.envelope.hardReturnTime, r.envelope.hardReturnTime);
    assert.deepEqual({ ...n.envelope, usableMinutes: r.envelope.usableMinutes }, r.envelope);
    assert.deepEqual(Object.keys(n).sort(), Object.keys(r).sort());
  });

  it("the narrowed copy stays a READABLE record for its own instant (#728's predicate) and widens nothing", () => {
    // #728 (census-layover §75) rates a card against a record only when `deadline.cutoffMs` is finite, `inputs.nowMs`
    // is the rating call's own instant, and both envelope figures are finite and non-negative. A narrowed copy keeps
    // all of that; only `usableMinutes` moves, and only DOWN (a wider budget is refused before any copy is made).
    for (const [, entry] of ENTRIES) {
      const r = certify(720, entry);
      for (const b of MAP_BUDGET_LADDER_MIN.filter((x) => mapBudgetRefusal(r, x) === null)) {
        const n = narrowRecordToBudget(r, b);
        assert.ok(Number.isFinite(n.deadline.cutoffMs));
        assert.equal(n.inputs.nowMs, r.inputs.nowMs);
        assert.equal(n.envelope.totalMinutes, r.envelope.totalMinutes, "the airside span is untouched");
        assert.ok(Number.isInteger(n.envelope.usableMinutes) && n.envelope.usableMinutes >= 0);
        assert.ok(n.envelope.usableMinutes <= r.envelope.usableMinutes, "never wider than certified");
      }
    }
  });

  it("the statement says it is a hypothetical, names both figures, and says nothing was saved", () => {
    const s = simulationStatement(120, 410);
    assert.match(s, /If you had only 2 h/);
    assert.match(s, /120 usable minutes instead of your certified 410/);
    assert.match(s, /return time does not change/);
    assert.match(s, /nothing was saved/);
    assert.match(simulationStatement(90, 300), /1 h 30 min/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. On certified records, through the production band pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe("L118 — the simulation IS the certification at that budget (parity)", () => {
  it("a record narrowed to B bands every stop exactly as a session certified with B usable minutes, swept", async () => {
    const stops = stopSweep();
    let compared = 0;
    const seen = new Set<string>();
    for (const [name, entry] of ENTRIES) {
      for (const M of [600, 780, 960]) {
        const big = certify(M, entry);
        for (const B of [...MAP_BUDGET_LADDER_MIN, 150, 205].filter((b) => b <= big.envelope.usableMinutes)) {
          const small = certifiedWithUsable(B, entry);
          assert.equal(landsideStatusOf(narrowRecordToBudget(big, B)), landsideStatusOf(small), `${name} M=${M} B=${B}: the gate`);
          const sim = await pipelineBothWays(narrowRecordToBudget(big, B), stops);
          const cert = await pipelineBothWays(small, stops);
          assert.equal(sim.length, 2 * stops.length);
          for (let i = 0; i < sim.length; i++) {
            assert.deepEqual(sim[i].mapBand, cert[i].mapBand, `${name} M=${M} B=${B} #${i} ${sim[i].id}: mapBand`);
            assert.equal(sim[i].envelope.band, cert[i].envelope.band, `${name} M=${M} B=${B} #${i} ${sim[i].id}: envelope band`);
            if (sim[i].mapBand.band) seen.add(sim[i].mapBand.band);
            compared++;
          }
          const fs = certifiedPlanFit(narrowRecordToBudget(big, B), stops);
          const fc = certifiedPlanFit(small, stops);
          assert.deepEqual(
            { fit: fs.fit, clockFit: fs.clockFit, landside: fs.landside, usable: fs.usableMinutes, overflow: fs.overflowMin },
            { fit: fc.fit, clockFit: fc.clockFit, landside: fc.landside, usable: fc.usableMinutes, overflow: fc.overflowMin },
            `${name} M=${M} B=${B}: plan fit`,
          );
        }
      }
    }
    assert.ok(compared > 500, `non-vacuous: ${compared}`);
    assert.deepEqual([...seen].sort(), ["BLOCKED", "SAFE", "TIGHT"], "every band appears in the sweep");
  });

  it("narrowing to the certified figure is the identity (the overview's own bands)", async () => {
    const stops = stopSweep();
    for (const [, entry] of ENTRIES) {
      const r = certify(720, entry);
      assert.deepEqual(await pipeline(narrowRecordToBudget(r, r.envelope.usableMinutes), stops), await pipeline(r, stops));
    }
  });
});

describe("L118 — a smaller budget never yields a looser band (monotonicity)", () => {
  it("swept over budgets, stops, entries and layovers: the band rank never drops as the budget shrinks", async () => {
    const stops = stopSweep();
    let pairs = 0;
    let moved = 0;
    for (const [name, entry] of ENTRIES) {
      for (const M of [540, 900]) {
        const r = certify(M, entry);
        const budgets: number[] = [];
        for (let b = MAP_BUDGET_FLOOR_MIN; b <= r.envelope.usableMinutes; b += 15) budgets.push(b);
        const runs = await Promise.all(budgets.map((b) => pipelineBothWays(narrowRecordToBudget(r, b), stops)));
        for (let k = 1; k < budgets.length; k++) {
          for (let i = 0; i < runs[k].length; i++) {
            const smaller = runs[k - 1][i].mapBand.band;
            const larger = runs[k][i].mapBand.band;
            assert.equal(smaller === null, larger === null, `${name} #${i} ${runs[k][i].id}: banded at one budget and not another`);
            if (smaller !== null) {
              assert.ok(RANK[smaller] >= RANK[larger], `${name} M=${M} #${i} ${runs[k][i].id}: ${budgets[k - 1]} → ${smaller} is looser than ${budgets[k]} → ${larger}`);
              if (RANK[smaller] > RANK[larger]) moved++;
              pairs++;
            }
          }
        }
      }
    }
    assert.ok(pairs > 1000, `non-vacuous: ${pairs}`);
    assert.ok(moved > 20, `the budget actually moves bands: ${moved}`);
  });

  it("a stop that is SAFE on the certified figure turns TIGHT and then BLOCKED as the chip narrows", async () => {
    const r = certify(720, PERMITTED);
    const stop = [{ id: "x", title: "x", insideAirport: false, travelMin: 20, durationMin: 90, lat: 25.0560, lng: 121.2500 }]; // needs 130
    assert.equal((await pipeline(r, stop))[0].mapBand.band, "SAFE");
    assert.equal((await pipeline(narrowRecordToBudget(r, 150), stop))[0].mapBand.band, "TIGHT");
    assert.equal((await pipeline(narrowRecordToBudget(r, 120), stop))[0].mapBand.band, "BLOCKED");
    assert.match((await pipeline(narrowRecordToBudget(r, 120), stop))[0].mapBand.reason, /more than your 120 usable minutes/);
  });

  it("the geometry is re-cut at the budget: a stop the certified ring admits is BLOCKED by the budget's ring", async () => {
    const r = certify(900, PERMITTED);
    // Taichung, with an understated 5-minute leg: the stated minutes fit any chip; the straight-line bound does not.
    const far = [{ id: "far", title: "far", insideAirport: false, travelMin: 5, durationMin: 15, lat: 24.1477, lng: 120.6736 }];
    const certified = (await pipeline(r, far))[0];
    assert.notEqual(certified.envelope.band, "BLOCKED", "the certified ring admits it");
    const narrowed = (await pipeline(narrowRecordToBudget(r, 90), far))[0];
    assert.equal(narrowed.envelope.band, "BLOCKED");
    assert.equal(narrowed.mapBand.band, "BLOCKED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Over the real router
// ═══════════════════════════════════════════════════════════════════════════

let server: http.Server;
let base: string;
const TOKEN = "map-budget-token";
let tables: Record<string, any[]>;

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(flags: { chips?: boolean; bands?: boolean; mode?: boolean } = {}, failures: Record<string, { message: string }> = {}) {
  const { chips = true, bands = true, mode = true } = flags;
  tables = {
    feature_flags: [
      ...(mode ? [{ flag: "airport_mode_enabled", enabled: true }] : []),
      ...(bands ? [{ flag: "layover_map_bands_enabled", enabled: true }] : []),
      ...(chips ? [{ flag: "layover_map_budget_chips_enabled", enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: "user-1",
      arrival_time: new Date(Date.now() - 3_600_000).toISOString(),
      departure_time: new Date(Date.now() + 9 * 3_600_000).toISOString(),
      status: "active",
    }), sessionRow({ id: "session-2", user_id: "someone-else" })],
    layover_plan_stops: [
      { id: "stop-city", session_id: "session-1", title: "Old town", stop_order: 0, duration_min: 60, travel_min: 30, inside_airport: false, source: "user", lat: null, lng: null },
      { id: "stop-lounge", session_id: "session-1", title: "Lounge", stop_order: 1, duration_min: 45, travel_min: 0, inside_airport: true, source: "user", lat: null, lng: null },
    ],
    layover_checkpoints: [], layover_outcomes: [], layover_events: [], layover_recommendations: [],
    layover_certified_computations: [], passport_stamps: [], passport_visibility_preferences: [], trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(withConfirmedCorridor(tables, { userIds: ["user-1"], destination: "TW" }), { users: { [TOKEN]: "user-1" }, failures }), true);
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  app.use("/api", simulateRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const SIM = "/api/airport/sessions/session-1/simulate";

describe("L118 — POST /simulate: switched on only by BOTH flags", () => {
  it("chip flag OFF (the seed): 404 feature_disabled, nothing computed", async () => {
    stage({ chips: false });
    const r = await call("POST", SIM, { budgetMinutes: 120 });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
  });

  it("map bands OFF: 404 — a chip has no band to move", async () => {
    stage({ bands: false });
    const r = await call("POST", SIM, { budgetMinutes: 120 });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
  });

  it("airport mode OFF: 404", async () => {
    stage({ mode: false });
    assert.equal((await call("POST", SIM, { budgetMinutes: 120 })).status, 404);
  });

  it("CONTROL: both ON answers 200", async () => {
    stage();
    assert.equal((await call("POST", SIM, { budgetMinutes: 120 })).status, 200);
  });
});

describe("L118 — POST /simulate: the server re-bands the plan under the budget", () => {
  it("every landside stop is banded against the BUDGET, the airside stop is not banded, and the plan fit is read at the budget", async () => {
    stage();
    const r = await call("POST", SIM, { budgetMinutes: 90 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.simulation.budgetMinutes, 90);
    assert.equal(r.body.simulation.stored, false);
    assert.ok(r.body.simulation.certifiedUsableMinutes > 90);
    assert.match(r.body.simulation.statement, /If you had only 1 h 30 min/);
    const city = r.body.stops.find((s: any) => s.id === "stop-city");
    const lounge = r.body.stops.find((s: any) => s.id === "stop-lounge");
    assert.equal(city.mapBand.usableMinutes, 90);
    assert.equal(city.mapBand.neededMin, 120);
    assert.equal(city.mapBand.band, "BLOCKED", "120 minutes of stay and travel do not fit a 90-minute budget");
    assert.equal(lounge.mapBand.band, null);
    assert.equal(r.body.planFit.usableMinutes, 90);
    assert.equal(r.body.planFit.clockFit, "over");
    assert.equal(typeof r.body.certification.inputHash, "string");
  });

  it("the SAME stop on the overview, read at the certified figure, is not BLOCKED — the chip moved it on the server", async () => {
    stage();
    const ov = await call("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    const city = ov.body.stops.find((s: any) => s.id === "stop-city");
    assert.notEqual(city.mapBand.band, "BLOCKED");
    assert.equal(city.mapBand.usableMinutes, ov.body.window.usableMinutes);
  });

  it("nothing is stored: no decision, no event, no stop write, no snapshot", async () => {
    stage();
    // The double creates an EMPTY table the first time one is read; a read is not a write.
    const rows = () => JSON.stringify(Object.fromEntries(Object.entries(tables).filter(([, v]) => v.length > 0)));
    const before = rows();
    const r = await call("POST", SIM, { budgetMinutes: 120 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows(), before);
    // CONTROL: a planted row IS seen, so the comparison above is not vacuous.
    tables.layover_events.push({ id: "planted" });
    assert.notEqual(rows(), before);
  });
});

describe("L118 — POST /simulate: what it refuses", () => {
  it("a budget above the certified figure: 409 above_certified, naming the figure", async () => {
    stage();
    const r = await call("POST", SIM, { budgetMinutes: 1440 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "above_certified");
    assert.match(r.body.message, /certified usable time is \d+ minutes/);
  });

  it("a budget below the floor: 409 below_floor", async () => {
    stage();
    const r = await call("POST", SIM, { budgetMinutes: 60 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "below_floor");
  });

  it("not a whole number of minutes, out of range, missing, or carrying anything else: 400", async () => {
    stage();
    // The record is ALWAYS the server's own certification of the session in the URL: a body that tries to hand one
    // in (or a figure, or another session) is refused by name — the engine has no session identity of its own yet (V-728 R1).
    for (const body of [{ budgetMinutes: 0 }, { budgetMinutes: 120.5 }, { budgetMinutes: "120" }, { budgetMinutes: 1441 }, {}, { budgetMinutes: 120, usableMinutes: 9999 }, { budgetMinutes: 120, record: { envelope: { usableMinutes: 9999 } } }, { budgetMinutes: 120, sessionId: "session-2" }]) {
      const r = await call("POST", SIM, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "invalid_payload");
    }
  });

  it("another traveller's session: 404", async () => {
    stage();
    const r = await call("POST", "/api/airport/sessions/session-2/simulate", { budgetMinutes: 120 });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_found");
  });

  it("the stops unreadable: 503, never an empty plan", async () => {
    stage({}, { "layover_plan_stops:select": { message: "boom" } });
    const r = await call("POST", SIM, { budgetMinutes: 120 });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("the bands flag turning OFF between the gate and the pipeline: refused, never unbanded stops served as a simulation", async () => {
    stage();
    // Wrap the double so the SECOND read of layover_map_bands_enabled (the pipeline's own) finds the flag gone.
    const db = makeLayoverDb(tables, { users: { [TOKEN]: "user-1" } });
    const from = db.from;
    let bandReads = 0;
    db.from = (t: string) => {
      const b = from(t);
      if (t !== "feature_flags") return b;
      const eq = b.eq;
      b.eq = (c: string, v: unknown) => (c === "flag" && v === "layover_map_bands_enabled" && ++bandReads > 1 ? eq(c, "__gone__") : eq(c, v));
      return b;
    };
    _setTestClient(db, true);
    const r = await call("POST", SIM, { budgetMinutes: 120 });
    assert.equal(bandReads, 2, "both reads happened");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "feature_disabled");
  });

  it("the session unreadable: 503", async () => {
    stage({}, { "layover_sessions:select": { message: "boom" } });
    assert.equal((await call("POST", SIM, { budgetMinutes: 120 })).status, 503);
  });
});

describe("L118 — the overview's mapBudgetChips", () => {
  it("chip flag OFF (the seed): the overview carries no mapBudgetChips key at all", async () => {
    stage({ chips: false });
    const r = await call("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!("mapBudgetChips" in r.body));
  });

  it("ON: the rungs below the certified figure the overview publishes", async () => {
    stage();
    const r = await call("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.mapBudgetChips;
    assert.equal(c.available, true, JSON.stringify(c));
    assert.equal(c.certifiedUsableMinutes, r.body.window.usableMinutes);
    assert.ok(c.budgets.length > 0);
    for (const b of c.budgets) assert.ok(b >= MAP_BUDGET_FLOOR_MIN && b < r.body.window.usableMinutes, `${b}`);
  });

  it("ON with the map bands OFF: published, withheld as map_bands_off", async () => {
    stage({ bands: false });
    const r = await call("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.body.mapBudgetChips.available, false);
    assert.equal(r.body.mapBudgetChips.withheld, "map_bands_off");
    assert.deepEqual(r.body.mapBudgetChips.budgets, []);
  });

  it("every chip the overview offers, the simulate route accepts", async () => {
    stage();
    const ov = await call("GET", "/api/airport/sessions/session-1/overview");
    for (const b of ov.body.mapBudgetChips.budgets) {
      const r = await call("POST", SIM, { budgetMinutes: b });
      assert.equal(r.status, 200, `${b}: ${JSON.stringify(r.body)}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. One certified record, read once, nothing re-derived
// ═══════════════════════════════════════════════════════════════════════════

describe("L118 — routes/layoverSimulate.ts consults the certified record and nothing else", () => {
  const strip = (f: string) => f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const src = strip(readFileSync(join(HERE, "..", "routes", "layoverSimulate.ts"), "utf8"));
  const service = strip(readFileSync(join(HERE, "..", "services", "airport", "layoverMapBudget.ts"), "utf8"));

  it("the record is the one certified for the session in the URL, owned by the caller — never one from the body", () => {
    assert.match(src, /getSession\(sc, req\.params\.id, auth\.user\.id\)/);
    assert.match(src, /consumerLayoverRecord\(sc, airport, session, nowMs\)/);
    assert.match(src, /certifySessionFeasibility\(airport, session, \{/);
    assert.doesNotMatch(src, /req\.body\.(record|session|usable|envelope)/);
  });

  it("the budget module rates nothing: no assess / rankActivities (whose 5th parameter #728 changes)", () => {
    for (const fn of ["assess", "rankActivities", "computeWindow", "computeReturnDeadline", "adviseLeaving", "certifySessionFeasibility"]) {
      assert.equal((service.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length, 0, fn);
    }
  });

  it("certifies exactly once, reads the clock exactly once", () => {
    assert.equal((src.match(/certifySessionFeasibility\s*\(/g) ?? []).length, 1);
    assert.equal((src.match(/consumerLayoverRecord\s*\(/g) ?? []).length, 1);
    assert.equal((src.match(/Date\.now\s*\(/g) ?? []).length, 1);
  });

  it("calls no engine function that derives a window, a deadline or a rating of its own", () => {
    for (const fn of ["assess", "rankActivities", "computeWindow", "computeReturnDeadline", "adviseLeaving", "mapBandForStop", "persistDecision"]) {
      assert.equal((src.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length, 0, fn);
    }
    assert.match(src, /mapBandedStops\s*\(/);
    assert.match(src, /narrowRecordToBudget\s*\(/);
  });
});
