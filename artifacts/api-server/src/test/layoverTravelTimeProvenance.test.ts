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
 * What was built here was PROVENANCE, not routing: every travel-time figure
 * travels with a `travelTimeSource` from the candidate, through
 * SafeRecommendation, out of routes/airport.ts, and `adviseLeaving` names the
 * fact in its `unknowns`.
 *
 * ── AND PROVENANCE WAS NOT ENOUGH (census-layover L293, 2026-09-13) ──────────
 * A label on an invented number does not stop the number driving a "safe"
 * rating. `estimateTravelTime`, `estimateActivityTime` and the `/safety`
 * probe's 20/30 are now DELETED rather than labelled, and the vocabulary has a
 * fourth member, `unmeasured`, which means there is no figure at all. Three
 * assertions in this file were changed with that work and each says so where it
 * stands; two of them were asserting the defect (the 15/25 constants, and the
 * probe's provenance), and one was asserting the size of the vocabulary.
 * "measured" is declared so a client can tell a route apart; nothing produces
 * it while the configured provider is `noRoutedProvider`, and the last test
 * pins that so the read-path inference stays honest.
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

// ── result-shape adapter ─────────────────────────────────────────────────────
/**
 * `generateRecommendations` / `getRecommendations` now answer
 * `{ ok: true, recommendations }` or `{ ok: false, message }`, because "the
 * table could not be read" and "this layover has nothing to offer" were the
 * same empty array before and are not the same answer. Every call in this file
 * expects the success arm, and says so out loud rather than reading
 * `undefined` off a refusal.
 */
function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

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

  it("the vocabulary is exactly the seven declared kinds", () => {
    // CHANGED WITH L293, and NOT because it was asserting the defect: it was
    // asserting the SIZE of the vocabulary, which is a real thing to pin. What
    // moved is the vocabulary. "unmeasured" is the answer for a candidate that
    // has no travel figure at all — the state every landside card is now in —
    // and it needed a name of its own, because reporting it as
    // "category_default" would have claimed a constant that no longer exists.
    //
    // CHANGED AGAIN WITH 2745, for the same reason and with the same strength —
    // an exact list, not a loosened one. `layover_recommendations.travel_time_source`
    // stores THIS vocabulary, so it had to gain the three kinds a persisted row
    // can now be in and previously could not express: a figure a human stated,
    // a great-circle lower bound (only ever a refusal), and — the one the read
    // path needed — "a figure is stored and nobody recorded where it came from".
    assert.deepEqual([...TRAVEL_TIME_SOURCES], [
      "inside_airport", "category_default", "measured", "unmeasured",
      "traveller_stated", "straight_line_bound", "unknown_provenance",
    ]);
  });
});

describe("generateRecommendations — every card states where its travel time came from", () => {
  for (const stableIds of [false, true]) {
    it(`stableIds=${stableIds}: landside cards are unmeasured, airside cards inside_airport, none measured`, async () => {
      // ── THIS ASSERTION ENCODED THE DEFECT, VERBATIM (changed with L293) ────
      // It read:
      //     // Both branches of estimateTravelTime are present (15 for cafe, 25 otherwise).
      //     assert.ok(landside.some((r) => r.travelTimeMin === 15)
      //            && landside.some((r) => r.travelTimeMin === 25), …);
      //     for (const r of landside) assert.equal(r.travelTimeSource, "category_default", …);
      // — it REQUIRED the two fabricated constants to be present on the cards,
      // and it required their provenance to say a category constant had been
      // used. Both halves are now false by construction: the constants are
      // deleted and the landside figure is an absence. The claim the case is
      // really making — every card states where its travel time came from, and
      // none of them claims a route — survives unchanged below.
      const t = tables();
      const recs = cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds }));
      const landside = recs.filter((r) => !r.insideAirport);
      const airside = recs.filter((r) => r.insideAirport);
      assert.ok(landside.length >= 3, `positive control: expected discovery + escape cards, got ${landside.length}`);
      assert.ok(airside.length >= 2, `positive control: expected inside-airport cards, got ${airside.length}`);
      assert.ok(landside.every((r) => r.travelTimeMin === null),
        `a category constant survives among ${JSON.stringify(landside.map((r) => r.travelTimeMin))}`);
      for (const r of landside) assert.equal(r.travelTimeSource, "unmeasured", `"${r.title}"`);
      for (const r of airside) assert.equal(r.travelTimeSource, "inside_airport", `"${r.title}"`);
      assert.ok(recs.every((r) => r.travelTimeSource !== "measured"));
    });
  }

  it("the provenance is NOT written to the row — layover_recommendations has no such column", async () => {
    // Writing an unknown column would make the insert/upsert fail on every
    // database that has not run a migration adding it; the source lives beside
    // the row (like rec_key's `keys`), not in it.
    const t = tables();
    cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), Date.now(), { stableIds: true }));
    assert.ok(t.layover_recommendations.length > 0, "positive control: rows were written");
    for (const row of t.layover_recommendations) {
      assert.ok(!("travel_time_source" in row) && !("travelTimeSource" in row),
        `row "${row.title}" carries a provenance column the schema does not have`);
    }
  });
});

describe("getRecommendations — the persisted read path recovers provenance conservatively", () => {
  it("inside_airport rows read as inside_airport; an unlabelled figure reads as unknown_provenance", async () => {
    // ── THIS ASSERTION ENCODED AN INFERENCE, AND 2745 DELETED THE INFERENCE ──
    // The second half read `assert.equal(…"r2"…, "category_default")` and the
    // title said "every other row reads as category_default". That was
    // `persistedTravelTimeSource` deciding, from the SIGN OF AN INTEGER, that a
    // stored landside 25 must have come from a category constant — a claim
    // about a producer made about a row that named none, and the exact thing
    // `LayoverTravelTime`'s header refused to let a routed provider inherit.
    // `layover_recommendations.travel_time_source` (2745) lets the row say; r2
    // says nothing, so the answer is now "we do not know". The claim this case
    // is really making — a persisted row's provenance is recovered
    // CONSERVATIVELY and never as a measurement — survives, strengthened.
    const t = tables();
    t.layover_recommendations.push(
      { id: "r1", session_id: "session-1", rec_type: "food", title: "Airport Dining", safety_rating: "safe", travel_time_min: 0, activity_time_min: 45, return_buffer_min: 140, hard_return_time: null, inside_airport: true, sort_order: 0 },
      { id: "r2", session_id: "session-1", rec_type: "activity", title: "Night Market", safety_rating: "safe", travel_time_min: 25, activity_time_min: 90, return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 1 },
    );
    const recs = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    assert.equal(recs.length, 2);
    assert.equal(recs.find((r) => r.id === "r1")!.travelTimeSource, "inside_airport");
    assert.equal(recs.find((r) => r.id === "r2")!.travelTimeSource, "unknown_provenance");
    // The figure is not denied along with its provenance — r2 still holds 25.
    assert.equal(recs.find((r) => r.id === "r2")!.travelTimeMin, 25);
  });

  it("a row that DOES carry a provenance reads as exactly that", async () => {
    const t = tables();
    t.layover_recommendations.push(
      { id: "r3", session_id: "session-1", rec_type: "activity", title: "Routed", safety_rating: "safe", travel_time_min: 41, activity_time_min: 90, return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 0, travel_time_source: "measured" },
    );
    const recs = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    assert.equal(recs[0]!.travelTimeSource, "measured");
  });
});

describe("sanitizeRecommendation — the field always reaches the client", () => {
  const base = {
    recType: "activity", title: "x", safetyRating: "safe", travelTimeMin: 25,
    activityTimeMin: 60, returnBufferMin: 120, insideAirport: false,
  };
  it("populates travelTimeSource from the raw record, defaulting closed", () => {
    // CHANGED WITH 2745, same strength: `base` states no source and holds a
    // figure, so the fallback runs through `persistedTravelTimeSource`, which
    // no longer names `category_default` for a record that named no producer.
    // "Defaulting closed" is the claim, and unknown is further from a
    // measurement than a category constant was, not nearer.
    assert.equal(sanitizeRecommendation(base).travelTimeSource, "unknown_provenance");
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
      // WAS `category_default` for every landside card — the fabrication's own
      // label. There is no category constant to attribute a figure to any more,
      // because there is no figure (L293).
      assert.equal(c.travelTimeSource, c.insideAirport ? "inside_airport" : "unmeasured", `"${c.title}"`);
    }
  });

  it("GET /sessions/:id/safety: there is no leg at all, and advice.unknowns still says so", async () => {
    // ── THIS ASSERTION ENCODED THE DEFECT (changed with L293c) ──────────────
    // It read `assert.equal(r.body.travelTimeSource, "category_default")` and
    // its title named "the literal 20-minute leg" as a thing to be labelled.
    // Labelling it was §7's work and it was not enough: the 20 and the 30 were
    // still the inputs to the rating this endpoint published as the session's
    // overall safety. The probe is deleted; `record.windowOnly` answers with no
    // journey in it, so the provenance of the journey is "unmeasured" because
    // there is none.
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.travelTimeSource, "unmeasured");
    assert.equal(r.body.estimates.outboundTravel, null, "an outbound estimate for a journey nobody named");
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
  // The persisted read path infers provenance from the row's own facts because
  // no column stores it. That inference is exact ONLY while nothing emits
  // "measured". This is the tripwire, and census L293 RETARGETED it rather than
  // relaxing it.
  //
  // WHY IT MOVED. The old form was "the literal appears in no service file but
  // the engine" — a proxy for "no producer exists" that worked only while the
  // travel-time PORT was unwired. L293 wires it: `LayoverTravelTime.landsideLeg`
  // asks `TravelTimeProvider` and would return `"measured"` for a ROUTED answer.
  // So the proxy is replaced by the thing it was standing in for, asserted two
  // ways: exactly one file outside the engine may name the literal, and the
  // configured provider must in fact produce nothing.
  //
  // The obligation the old comment recorded is UNCHANGED and still owed: the
  // first real provider must also add a provenance column to
  // `layover_recommendations`, update `persistedTravelTimeSource`, and then
  // change these expectations. That is why the provider is a module constant
  // and not an environment lookup — see LayoverTravelTime.ts.
  const PRODUCER = "LayoverTravelTime.ts";

  it("the literal appears only in the engine's declaration, its own comparison, and the ONE port adapter", () => {
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
      } else if (f.endsWith(PRODUCER)) {
        assert.equal(hits, 1, `${PRODUCER}: expected exactly the one assignment behind the routed branch, found ${hits}`);
      } else {
        assert.equal(hits, 0, `${f} produces or compares "measured" — a measured travel time now exists; persist its provenance on the row and update persistedTravelTimeSource`);
      }
    }
  });

  /**
   * REPOINTED, NOT RELAXED, WHEN THE SEAM WAS FILLED.
   *
   * This used to pin `LAYOVER_TRAVEL_TIME_PROVIDER.id === "none-configured"`,
   * with the stated worry that "a routed provider is configured; the persisted
   * read path can no longer infer provenance". That worry is DISCHARGED:
   * migration 2745 added `layover_recommendations.travel_time_source` and
   * `persistedTravelTimeSource` now READS it instead of inferring anything, so
   * a routed provider no longer threatens the read path. What this file is
   * really about — that NOTHING ON THIS TREE PRODUCES A "measured" PROVENANCE
   * — is unchanged and is asserted below on the ANSWER rather than on the
   * provider's name, which is the stronger of the two claims.
   */
  it("and the configured provider produces none of it — asked, not assumed", async () => {
    const { LAYOVER_TRAVEL_TIME_PROVIDER, landsideLeg, UNMEASURED_LEG } =
      await import("../services/airport/LayoverTravelTime.js");
    // A ROUTED corridor adapter, which is what makes the refusal below a
    // measurement of the deployment rather than a property of a stand-in.
    assert.equal(LAYOVER_TRAVEL_TIME_PROVIDER.routed, true);
    // Two real coordinates, a real departure time: the port still answers that
    // it has nothing, and the reason is the one the absence deserves.
    const leg = await landsideLeg({ lat: 25.07, lng: 121.23 }, { lat: 25.01, lng: 121.30 }, new Date());
    // Every field of the canonical absence, unchanged. `detail` is the one
    // addition and is checked separately, so this stays an EXACT comparison
    // rather than a loosened one.
    assert.deepEqual({ ...leg, detail: null }, UNMEASURED_LEG);
    assert.equal(leg.minutes, null);
    assert.equal(leg.source, "unmeasured");
    assert.equal(leg.reason, "NO_ROUTED_PROVIDER");
    // And the absence names the SPEND GATE, not a missing credential: nobody
    // opted this deployment in to a billable call.
    assert.match(String(leg.detail), /^PROVIDER_NOT_ENABLED .*LAYOVER_ROUTED_CORRIDOR_ENABLED/);
  });
});
