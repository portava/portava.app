/**
 * Layover travel-time provenance — a category constant never poses as a route.
 *
 * node:test + node:assert (NOT vitest). Real router, fake table-backed DB.
 *
 * THE DEFECT (census L9 / L65). `estimateTravelTime(placeType)` returns 15 or
 * 25 minutes without reading a coordinate (`fetchDiscoveryPlaces` does not even
 * SELECT lat/lng), the city-escape card carries a literal 30 and the safety
 * route a literal 20 — and each literal feeds a "safe" rating a traveller may
 * act on by leaving the airport. Spec §2.1: "missing live intelligence degrades
 * VISIBLY; never fabricate freshness."
 *
 * What is built here is PROVENANCE, not routing: every travel-time figure now
 * travels with a `travelTimeSource` (inside_airport | category_default |
 * measured) from the candidate, through SafeRecommendation, out of
 * routes/airport.ts, and `adviseLeaving` names the fact in its `unknowns`.
 * "measured" is declared so a client can tell it apart; NOTHING PRODUCES IT on
 * this tree, and the last test pins that so the read-path inference stays honest.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverTravelTimeProvenance.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  generateRecommendations,
  getRecommendations,
} from "../services/airport/LayoverRecommendationService.js";
import { sanitizeRecommendation } from "../services/airport/LayoverPrivacyGuard.js";
import {
  adviseLeaving,
  computeWindow,
  travelTimeSourceFor,
  TRAVEL_TIME_SOURCES,
  TRAVEL_TIME_UNMEASURED_UNKNOWN,
} from "../services/airport/LayoverSafetyEngine.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  const now = Date.now();
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(now + 5 * 60_000).toISOString(),
    departureTime: new Date(now + 9 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 535,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

// Two place types on purpose: one on each side of estimateTravelTime's 15/25
// split, so the provenance is proven independent of which constant was picked.
const PLACES = [
  { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active" },
  { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active" },
];

function tables(): Record<string, any[]> {
  return {
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

describe("travelTimeSourceFor — the fail-closed resolver", () => {
  it("an absent source is the least-trusted kind that applies, never measured", () => {
    assert.equal(travelTimeSourceFor({ insideAirport: false }), "category_default");
    assert.equal(travelTimeSourceFor({ insideAirport: true }), "inside_airport");
    assert.equal(travelTimeSourceFor({ insideAirport: false, travelTimeSource: null }), "category_default");
  });

  it("an explicit, known source is preserved; an unknown string is NOT trusted", () => {
    assert.equal(travelTimeSourceFor({ insideAirport: false, travelTimeSource: "measured" }), "measured");
    assert.equal(travelTimeSourceFor({ insideAirport: true, travelTimeSource: "category_default" }), "category_default");
    // A value outside the vocabulary (e.g. a future column read back with a typo)
    // must fall to the conservative default rather than pass through.
    assert.equal(travelTimeSourceFor({ insideAirport: false, travelTimeSource: "routed" as any }), "category_default");
  });

  it("the vocabulary is exactly the three declared kinds", () => {
    assert.deepEqual([...TRAVEL_TIME_SOURCES], ["inside_airport", "category_default", "measured"]);
  });
});

describe("generateRecommendations — every card states where its travel time came from", () => {
  for (const stableIds of [false, true]) {
    it(`stableIds=${stableIds}: landside cards are category_default, airside cards inside_airport, none measured`, async () => {
      const t = tables();
      const recs = await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds });
      const landside = recs.filter((r) => !r.insideAirport);
      const airside = recs.filter((r) => r.insideAirport);
      assert.ok(landside.length >= 3, `positive control: expected discovery + escape cards, got ${landside.length}`);
      assert.ok(airside.length >= 2, `positive control: expected inside-airport cards, got ${airside.length}`);
      // Both branches of estimateTravelTime are present (15 for cafe, 25 otherwise).
      assert.ok(landside.some((r) => r.travelTimeMin === 15) && landside.some((r) => r.travelTimeMin === 25),
        `expected both category constants among ${JSON.stringify(landside.map((r) => r.travelTimeMin))}`);
      for (const r of landside) assert.equal(r.travelTimeSource, "category_default", `"${r.title}" (${r.travelTimeMin} min)`);
      for (const r of airside) assert.equal(r.travelTimeSource, "inside_airport", `"${r.title}"`);
      assert.ok(recs.every((r) => r.travelTimeSource !== "measured"));
    });
  }

  it("the provenance is NOT written to the row — layover_recommendations has no such column", async () => {
    // Writing an unknown column would make the insert/upsert fail on every
    // database that has not run a migration adding it; the source lives beside
    // the row (like rec_key's `keys`), not in it.
    const t = tables();
    await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(t.layover_recommendations.length > 0, "positive control: rows were written");
    for (const row of t.layover_recommendations) {
      assert.ok(!("travel_time_source" in row) && !("travelTimeSource" in row),
        `row "${row.title}" carries a provenance column the schema does not have`);
    }
  });
});

describe("getRecommendations — the persisted read path recovers provenance conservatively", () => {
  it("inside_airport rows read as inside_airport; every other row reads as category_default", async () => {
    const t = tables();
    t.layover_recommendations.push(
      { id: "r1", session_id: "session-1", rec_type: "food", title: "Airport Dining", safety_rating: "safe", travel_time_min: 0, activity_time_min: 45, return_buffer_min: 140, hard_return_time: null, inside_airport: true, sort_order: 0 },
      { id: "r2", session_id: "session-1", rec_type: "activity", title: "Night Market", safety_rating: "safe", travel_time_min: 25, activity_time_min: 90, return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 1 },
    );
    const recs = await getRecommendations(makeLayoverDb(t), "session-1");
    assert.equal(recs.length, 2);
    assert.equal(recs.find((r) => r.id === "r1")!.travelTimeSource, "inside_airport");
    assert.equal(recs.find((r) => r.id === "r2")!.travelTimeSource, "category_default");
  });
});

describe("sanitizeRecommendation — the field always reaches the client", () => {
  const base = {
    recType: "activity", title: "x", safetyRating: "safe", travelTimeMin: 25,
    activityTimeMin: 60, returnBufferMin: 120, insideAirport: false,
  };
  it("populates travelTimeSource from the raw record, defaulting closed", () => {
    assert.equal(sanitizeRecommendation(base).travelTimeSource, "category_default");
    assert.equal(sanitizeRecommendation({ ...base, insideAirport: true, travelTimeMin: 0 }).travelTimeSource, "inside_airport");
    assert.equal(sanitizeRecommendation({ ...base, travelTimeSource: "measured" }).travelTimeSource, "measured");
  });
});

describe("adviseLeaving — unknowns[] names the unmeasured travel time", () => {
  const window = () => computeWindow(AIRPORT, session());

  it("with no facts, the traveller who intends to leave is told the times are category estimates", () => {
    const advice = adviseLeaving(AIRPORT, session(), window());
    assert.ok(advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN), JSON.stringify(advice.unknowns));
  });

  it("stated category_default: the same disclosure", () => {
    const advice = adviseLeaving(AIRPORT, session(), window(), { travelTimeSource: "category_default" });
    assert.ok(advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN));
  });

  it("stated measured: the disclosure is withheld — the only way to silence it", () => {
    const advice = adviseLeaving(AIRPORT, session(), window(), { travelTimeSource: "measured" });
    assert.ok(!advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN), JSON.stringify(advice.unknowns));
  });

  it("a traveller staying airside is not warned about landside travel", () => {
    const s = session({ wantsToLeave: false });
    const advice = adviseLeaving(AIRPORT, s, computeWindow(AIRPORT, s));
    assert.equal(advice.verdict, "stay_airside");
    assert.ok(!advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN));
  });

  it("the pre-existing unknowns and reason codes are untouched (extension, not replacement)", () => {
    const advice = adviseLeaving(AIRPORT, session(), window());
    assert.equal(advice.unknowns[0], "Visa or transit-permit requirements for your nationality");
    assert.ok(advice.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
    assert.ok(advice.reasonCodes.includes("AIRPORT_MATURITY_LIMITED"));
  });
});

// ── Route level: the field crosses the HTTP boundary ─────────────────────────

let server: http.Server;
let base: string;
const TOKEN = "prov-token";
const USER_ID = "user-1";

function req(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } },
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

function stage() {
  const t: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID })],
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
  };
  _setTestClient(makeLayoverDb(t, { users: { [TOKEN]: USER_ID } }), true);
  return t;
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

describe("routes/airport — provenance is visible at the API boundary", () => {
  it("GET /sessions/:id/recommendations: every card carries travelTimeSource, none measured", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs: any[] = r.body.recommendations;
    assert.ok(Array.isArray(recs) && recs.length >= 4, `positive control: got ${recs?.length} cards`);
    for (const c of recs) {
      assert.ok((TRAVEL_TIME_SOURCES as readonly string[]).includes(c.travelTimeSource), `"${c.title}": ${c.travelTimeSource}`);
      assert.equal(c.travelTimeSource, c.insideAirport ? "inside_airport" : "category_default", `"${c.title}"`);
    }
  });

  it("GET /sessions/:id/safety: the literal 20-minute leg is labelled category_default and advice.unknowns says so", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.travelTimeSource, "category_default");
    assert.ok(r.body.advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN), JSON.stringify(r.body.advice.unknowns));
  });

  it("GET /sessions/:id/overview: advice.unknowns says so", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.advice.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN), JSON.stringify(r.body.advice.unknowns));
  });
});

// ── The honesty pin ──────────────────────────────────────────────────────────

describe('"measured" has no producer on this tree', () => {
  // The persisted read path infers provenance from inside_airport because no
  // column stores it. That inference is exact ONLY while nothing emits
  // "measured". This test is the tripwire: the first producer must also add a
  // column, update getRecommendations, and then change this expectation.
  it("the literal appears only in the engine's declaration and its own comparison", () => {
    const engine = "LayoverSafetyEngine.ts";
    const svcDir = join(HERE, "..", "services", "airport");
    const files = readdirSync(svcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(svcDir, f));
    files.push(join(HERE, "..", "routes", "airport.ts"));
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of files) {
      const code = strip(readFileSync(f, "utf8"));
      const hits = (code.match(/"measured"/g) ?? []).length;
      if (f.endsWith(engine)) {
        assert.equal(hits, 2, `${engine}: expected the TRAVEL_TIME_SOURCES entry and adviseLeaving's comparison, found ${hits}`);
      } else {
        assert.equal(hits, 0, `${f} produces or compares "measured" — a measured travel time now exists; persist its provenance on the row and update getRecommendations`);
      }
    }
  });
});
