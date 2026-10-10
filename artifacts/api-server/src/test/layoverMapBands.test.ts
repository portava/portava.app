/**
 * layoverMapBands — spec §13's SAFE / TIGHT / BLOCKED map bands, computed on
 * the server from the certified budget (census-layover L67).
 *
 * Pure cases for the rule's order, then the bands read off records the
 * production certifier produces, then the overview over the real router with
 * the flag OFF (stops unchanged) and ON (every stop banded).
 *
 * Run: node --import tsx/esm --test src/test/layoverMapBands.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  MAP_BAND_TIGHT_MARGIN_MIN,
  mapBandForStop,
  withMapBands,
  type MapBandBudget,
} from "../services/airport/layoverMapBands.js";
import { RETURN_SOON_LEAD_MIN } from "../services/airport/LayoverSafetyEngine.js";
import { certifySessionFeasibility, type FeasibilityAirport } from "../services/airport/LayoverFeasibility.js";
import { certifiedPlanFit } from "../services/airport/LayoverConstraints.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const OPEN: MapBandBudget = { landside: "open", closedBy: [], cautions: [], usableMinutes: 300, planClockFit: "fits" };
const STOP = { insideAirport: false, travelMin: 30, durationMin: 60 }; // needs 120

describe("L67 — the rule, in order", () => {
  it("SAFE when the gate is open and the stop fits with the margin to spare", () => {
    const b = mapBandForStop(STOP, OPEN);
    assert.equal(b.band, "SAFE");
    assert.equal(b.neededMin, 120);
    assert.equal(b.spareMin, 180);
    assert.match(b.reason, /travel time you entered/);
  });

  it("the margin is RETURN_SOON's lead, not a new number", () => {
    assert.equal(MAP_BAND_TIGHT_MARGIN_MIN, RETURN_SOON_LEAD_MIN);
    assert.equal(mapBandForStop(STOP, { ...OPEN, usableMinutes: 120 + MAP_BAND_TIGHT_MARGIN_MIN }).band, "SAFE");
    assert.equal(mapBandForStop(STOP, { ...OPEN, usableMinutes: 120 + MAP_BAND_TIGHT_MARGIN_MIN - 1 }).band, "TIGHT");
  });

  it("BLOCKED when the stay and the trip there and back exceed the window", () => {
    assert.equal(mapBandForStop(STOP, { ...OPEN, usableMinutes: 119 }).band, "BLOCKED");
    assert.equal(mapBandForStop(STOP, { ...OPEN, usableMinutes: 120 }).band, "TIGHT");
  });

  it("a CLOSED gate is BLOCKED at any amount of spare time, and says why", () => {
    const b = mapBandForStop(STOP, { ...OPEN, landside: "closed", closedBy: ["airport_change"], usableMinutes: 900 });
    assert.equal(b.band, "BLOCKED");
    assert.match(b.reason, /different airport/);
  });

  it("a gate in a state this build does not know is read as closed", () => {
    assert.equal(mapBandForStop(STOP, { ...OPEN, landside: "weird" as never }).band, "BLOCKED");
  });

  it("a CAUTIONARY gate is never SAFE", () => {
    const b = mapBandForStop(STOP, { ...OPEN, landside: "caution", cautions: ["entry_unconfirmed"], usableMinutes: 900 });
    assert.equal(b.band, "TIGHT");
    assert.match(b.reason, /not confirmed/);
  });

  it("the envelope's geometric BLOCKED stands", () => {
    const b = mapBandForStop({ ...STOP, envelope: { band: "BLOCKED", reason: "12 km away" } }, OPEN);
    assert.equal(b.band, "BLOCKED");
    assert.equal(b.reason, "12 km away");
  });

  it("a stop that fits inside a plan that overflows is TIGHT", () => {
    assert.equal(mapBandForStop(STOP, { ...OPEN, planClockFit: "over" }).band, "TIGHT");
  });

  it("unstated minutes or an uncertified window are NOT banded — never drawn as reachable", () => {
    for (const s of [{ ...STOP, travelMin: 0 }, { ...STOP, travelMin: null }, { ...STOP, durationMin: undefined }]) {
      assert.equal(mapBandForStop(s, OPEN).band, null);
    }
    assert.equal(mapBandForStop(STOP, { ...OPEN, usableMinutes: Number.NaN }).band, null);
  });

  it("an airside stop has no band", () => {
    assert.equal(mapBandForStop({ ...STOP, insideAirport: true }, OPEN).band, null);
  });

  it("OFF leaves the stops as they were (same objects, no key)", () => {
    const stops = [STOP];
    assert.equal(withMapBands(stops, OPEN, false), stops);
    assert.ok(!("mapBand" in withMapBands(stops, OPEN, false)[0]));
    assert.equal(withMapBands(stops, OPEN, true)[0].mapBand?.band, "SAFE");
  });
});

// ── on certified records ─────────────────────────────────────────────────────

function airport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}
const ARRIVAL = Date.parse("2030-06-15T00:00:00.000Z");
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };
const REFUSED: EntryEligibility = { state: "refused", status: "visa_required", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
function certify(minutes: number, entry: EntryEligibility) {
  return certifySessionFeasibility(airport(), {
    id: "s", arrivalTime: new Date(ARRIVAL).toISOString(), departureTime: new Date(ARRIVAL + minutes * 60_000).toISOString(),
    boardingTime: null, flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
  } as never, { nowMs: ARRIVAL, entry });
}
function bandOn(record: ReturnType<typeof certify>, stop = STOP) {
  const fit = certifiedPlanFit(record, [stop]);
  return mapBandForStop(stop, {
    landside: fit.landside.status, closedBy: fit.landside.closedBy, cautions: fit.landside.cautions,
    usableMinutes: record.envelope.usableMinutes, planClockFit: fit.clockFit,
  });
}

describe("L67 — on records the certifier produces", () => {
  it("a long permitted layover bands a modest stop SAFE; an unconfirmed border TIGHT; a refused one BLOCKED", () => {
    assert.equal(bandOn(certify(600, PERMITTED)).band, "SAFE");
    assert.equal(bandOn(certify(600, UNRESOLVED)).band, "TIGHT");
    assert.equal(bandOn(certify(600, REFUSED)).band, "BLOCKED");
  });

  it("SAFE is never produced unless the certified verdict is `yes`, swept", () => {
    let safe = 0;
    for (const entry of [PERMITTED, UNRESOLVED, REFUSED]) for (let m = 120; m <= 900; m += 9) {
      const r = certify(m, entry);
      const b = bandOn(r);
      if (b.band === "SAFE") { safe++; assert.equal(r.verdict, "yes", `m=${m} ${entry.state}`); }
      if (r.verdict === "no") assert.notEqual(b.band, "SAFE");
    }
    assert.ok(safe > 0);
  });
});

// ── over the real router ─────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const TOKEN = "map-bands-token";

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    http.get({ hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    }).on("error", reject);
  });
}

function stage(flagOn: boolean) {
  _setTestClient(makeLayoverDb({
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(flagOn ? [{ flag: "layover_map_bands_enabled", enabled: true }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({
      user_id: "user-1",
      arrival_time: new Date(Date.now() - 3_600_000).toISOString(),
      departure_time: new Date(Date.now() + 9 * 3_600_000).toISOString(),
      status: "active",
    })],
    layover_plan_stops: [
      { id: "stop-city", session_id: "session-1", title: "Old town", stop_order: 0, duration_min: 60, travel_min: 30, inside_airport: false, source: "user", lat: null, lng: null },
      { id: "stop-lounge", session_id: "session-1", title: "Lounge", stop_order: 1, duration_min: 45, travel_min: 0, inside_airport: true, source: "user", lat: null, lng: null },
    ],
    layover_checkpoints: [], layover_outcomes: [], layover_events: [], layover_recommendations: [],
    passport_stamps: [], passport_visibility_preferences: [], trip_plan_items: [],
  }, { users: { [TOKEN]: "user-1" } }), true);
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

describe("L67 — the overview", () => {
  it("flag OFF: no stop carries a mapBand", async () => {
    stage(false);
    const r = await get("/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stops.length, 2);
    for (const s of r.body.stops) assert.ok(!("mapBand" in s));
  });

  it("flag ON: the landside stop is banded from the certified budget and the airside stop is not", async () => {
    stage(true);
    const r = await get("/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const city = r.body.stops.find((s: any) => s.id === "stop-city");
    const lounge = r.body.stops.find((s: any) => s.id === "stop-lounge");
    assert.ok(["SAFE", "TIGHT", "BLOCKED"].includes(city.mapBand.band), JSON.stringify(city.mapBand));
    assert.equal(city.mapBand.usableMinutes, r.body.window.usableMinutes, "read against the window the response publishes");
    // No corridor is confirmed on this fixture: the gate is not open, so never SAFE.
    assert.notEqual(city.mapBand.band, "SAFE");
    assert.equal(lounge.mapBand.band, null);
  });
});
