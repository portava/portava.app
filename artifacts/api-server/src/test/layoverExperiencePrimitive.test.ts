/**
 * census-layover L75 — spec §9 `ExperiencePrimitive` on every layover card.
 *
 *   ExperiencePrimitive { type: EAT | SEE | MEET | … | TRANSIT, minDuration,
 *     idealDuration, compressibility, interruptibility, reversibility,
 *     costRange, energyCost, weatherCompatibility, reservationRequirement }
 *
 * On main a layover card carried `rec_type` (a nine-value CHECK, 0127) and none
 * of the ten members. This file pins four things:
 *
 *   A. THE ROUTE. Every card `GET /airport/sessions/:id/recommendations`
 *      serves carries `experience` with all ten members and a type in the
 *      thirteen-value vocabulary — on the regenerate path AND the stored path,
 *      and the same card gets the same descriptor on both.
 *   B. THE TYPE. Which card is which type, and that the vocabulary, the
 *      defaults and the weather rule are Trips' (census-trips TR233–TR243), not
 *      a second copy: the rain rule is checked against the real Trips compiler
 *      for all thirteen types.
 *   C. NEVER THE SAFETY MATH (census §16 / L293). A discovery card's
 *      `activityTimeMin` is still `null`; nothing is stored; and with every
 *      default changed, the ratings, deadlines, order, bands, written rows and
 *      audit event are byte-identical — only the descriptor moves.
 *   D. ONE IMPORTER. Only the recommendation service imports the descriptor;
 *      no safety-path module does.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverExperiencePrimitive.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js"; import { withConfirmedCorridor } from "./helpers/confirmedCorridor.js";
import { generateRecommendations, getRecommendations } from "../services/airport/LayoverRecommendationService.js";
import * as Primitive from "../services/airport/layoverExperiencePrimitive.js";
import {
  ACTIVITY_PRIMITIVES, PRIMITIVE_DEFAULTS, primitiveFor, compileExperiences,
  type ActivityPrimitive, type CompileInputs,
} from "../domain/trips/services/TripExperienceCompiler.js";
import type { PulseInterpretation } from "../domain/trips/services/TripSignals.js";
// The app's own renderer, so the weather case below is pinned end to end:
// producer → wire descriptor → the line a traveller reads.
import { typicalExperienceLine, typicalExperienceA11y } from "../../../../travel-buddy-standalone/src/components/layover/layoverExperienceFacts.ts";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** The spec's ten members, by the spec's names. */
const TEN = [
  "type", "minDuration", "idealDuration", "compressibility", "interruptibility",
  "reversibility", "costRange", "energyCost", "weatherCompatibility", "reservationRequirement",
] as const;

function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

function assertTenMembers(card: any): void {
  const e = card.experience;
  assert.ok(e && typeof e === "object", `"${card.title}" has no experience descriptor: ${JSON.stringify(card).slice(0, 200)}`);
  for (const k of TEN) assert.ok(k in e, `"${card.title}".experience lacks ${k}`);
  assert.ok((ACTIVITY_PRIMITIVES as readonly string[]).includes(e.type), `"${card.title}": type ${e.type} is not one of the thirteen`);
  assert.equal(typeof e.minDuration, "number", `"${card.title}".minDuration`);
  assert.equal(typeof e.idealDuration, "number", `"${card.title}".idealDuration`);
  assert.ok(e.minDuration > 0 && e.minDuration <= e.idealDuration, `"${card.title}": ${e.minDuration}..${e.idealDuration}`);
  assert.ok(e.compressibility >= 0 && e.compressibility <= 1, `"${card.title}".compressibility ${e.compressibility}`);
  assert.ok(Primitive.WEATHER_COMPATIBILITIES.includes(e.weatherCompatibility), `"${card.title}".weatherCompatibility ${e.weatherCompatibility}`);
  assert.ok(Primitive.RESERVATION_REQUIREMENTS.includes(e.reservationRequirement), `"${card.title}".reservationRequirement ${e.reservationRequirement}`);
  assert.equal(e.source, "category_default", `"${card.title}" must say its numbers are typical for the type`);
}

// A fixed instant: 16:00 in Taipei, so a twelve-hour window covers both the
// daytime and the evening and the nightlife card is generated.
const NOW = Date.parse("2026-10-14T08:00:00.000Z");

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW + 5 * 60_000).toISOString(),
    departureTime: new Date(NOW + 12 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 715,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate",
    // Every chip that adds an airside card, so the whole airside catalogue is built.
    vibeChips: ["food", "shopping", "culture"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** One place per producer branch of `mapPlaceTypeToRecType`. */
const PLACES = [
  { id: "place-food", name: "Riverside Noodles", place_type: "restaurant", category: "food", neighborhood: "Zhongli", blurb: "Noodles", verified: true, city: "Taoyuan", status: "active", lat: 25.01, lng: 121.30 },
  { id: "place-bar", name: "Hoppy Corner", place_type: "pub", category: "drink", neighborhood: null, blurb: "Beer", verified: true, city: "Taoyuan", status: "active", lat: 25.02, lng: 121.29 },
  { id: "place-museum", name: "Hakka Culture Hall", place_type: "museum", category: "culture", neighborhood: null, blurb: "History", verified: false, city: "Taoyuan", status: "active", lat: 24.99, lng: 121.31 },
  { id: "place-spa", name: "Hot Spring Spa", place_type: "spa", category: "wellness", neighborhood: null, blurb: "Soak", verified: false, city: "Taoyuan", status: "active", lat: 25.00, lng: 121.28 },
];

function tables(): Record<string, any[]> {
  return {
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

// ── A. THE ROUTE ─────────────────────────────────────────────────────────────

describe("A. GET /airport/sessions/:id/recommendations — every card carries the §9 ExperiencePrimitive", () => {
  let server: any;
  let port = 0;
  let routeTables: Record<string, any[]>;

  async function get(path: string): Promise<{ status: number; body: any }> {
    return await new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET", headers: { authorization: "Bearer env-token" } },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); } catch (e) { reject(e); } });
        },
      );
      r.on("error", reject);
      r.end();
    });
  }

  before(async () => {
    const express = (await import("express")).default;
    const { _setTestClient } = await import("../lib/http.js");
    const airportRouter = (await import("../routes/airport.js")).default;
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", airportRouter);
    server = await new Promise<any>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    port = (server.address() as any).port;
    routeTables = {
      feature_flags: [
        { flag: "airport_mode_enabled", enabled: true },
        // TRUE in production (the 20260922 snapshot): the route regenerates.
        { flag: "layover_safety_engine_enabled", enabled: true },
      ],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: "user-1", vibe_chips: ["food", "shopping", "culture"], departure_time: new Date(Date.now() + 12 * 3_600_000).toISOString(), layover_minutes: 715, immigration_required: false })],
      layover_events: [], layover_plan_stops: [], trip_plan_items: [], layover_checkpoints: [],
      layover_recommendations: [],
      discovery_places: PLACES.map((p) => ({ ...p })),
    };
    _setTestClient(makeLayoverDb(withConfirmedCorridor(routeTables, { userIds: ["user-1"], destination: "TW" }), { users: { "env-token": "user-1" } }), true);
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the regenerate path (layover_safety_engine_enabled TRUE): all ten members on every card, airside and landside", async () => {
    const { status, body } = await get("/api/airport/sessions/session-1/recommendations");
    assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
    const recs: any[] = body.recommendations;
    assert.ok(recs.some((r) => r.insideAirport) && recs.some((r) => !r.insideAirport),
      `positive control: expected airside and landside cards, got ${JSON.stringify(recs.map((r) => [r.title, r.insideAirport]))}`);
    for (const r of recs) assertTenMembers(r);
  });

  it("the stored path (flag FALSE): the same card is served with the same descriptor", async () => {
    const first = (await get("/api/airport/sessions/session-1/recommendations")).body.recommendations as any[];
    assert.ok(routeTables.layover_recommendations.length > 0, "positive control: the regenerate path wrote rows");
    routeTables.feature_flags.find((f) => f.flag === "layover_safety_engine_enabled")!.enabled = false;
    try {
      const { status, body } = await get("/api/airport/sessions/session-1/recommendations");
      assert.equal(status, 200);
      const stored: any[] = body.recommendations;
      assert.equal(stored.length, first.length, "the stored path served a different set");
      const byTitle = new Map(first.map((r) => [r.title, r.experience]));
      for (const r of stored) {
        assertTenMembers(r);
        assert.deepEqual(r.experience, byTitle.get(r.title), `"${r.title}": the stored path and the regenerate path disagree`);
      }
    } finally {
      routeTables.feature_flags.find((f) => f.flag === "layover_safety_engine_enabled")!.enabled = true;
    }
  });
});

// ── B. THE TYPE ──────────────────────────────────────────────────────────────

describe("B. which card is which type — Trips' vocabulary, defaults and rules", () => {
  it("the thirteen types are Trips' thirteen, verbatim, in the spec's order", () => {
    assert.deepEqual([...Primitive.LAYOVER_EXPERIENCE_TYPES], ["EAT", "SEE", "MEET", "DRINK", "SHOP", "WALK", "REST", "PHOTO", "EXPLORE", "PLAY", "LEARN", "NIGHTLIFE", "TRANSIT"]);
    assert.equal(Primitive.LAYOVER_EXPERIENCE_TYPES, ACTIVITY_PRIMITIVES, "a re-listed copy, not Trips' own array");
  });

  it("a rec_type that names an activity gets Trips' own answer for that word", () => {
    for (const [recType, want] of [["food", "EAT"], ["rest", "REST"], ["nightlife", "NIGHTLIFE"], ["meetup", "MEET"]] as const) {
      const got = Primitive.experienceTypeFor({ recType, title: "Anything At All", insideAirport: false });
      assert.deepEqual(got, { type: want, typeBasis: "rec_type" }, recType);
      assert.equal(got.type, primitiveFor(recType), `${recType}: diverged from Trips' primitiveFor`);
    }
  });

  it("the title never re-types a card whose rec_type names one (a restaurant called 'The Barn' is not a bar)", () => {
    assert.equal(Primitive.experienceTypeFor({ recType: "food", title: "The Barn Night Club", insideAirport: false }).type, "EAT");
    assert.equal(Primitive.experienceTypeFor({ recType: "activity", title: "Louvre Museum", insideAirport: false }).type, "EXPLORE");
  });

  it("rec_types Trips' table does not know are mapped here, NOT through primitiveFor (which would call quick_city_escape PLAY)", () => {
    assert.equal(primitiveFor("quick_city_escape"), "PLAY", "positive control: the hazard this mapping exists for");
    for (const recType of ["activity", "hidden_gem", "quick_city_escape"]) {
      assert.deepEqual(Primitive.experienceTypeFor({ recType, title: "x", insideAirport: false }), { type: "EXPLORE", typeBasis: "rec_type" }, recType);
    }
  });

  it("a location rec_type is not an activity: the airside catalogue by title, else unmapped EXPLORE — never TRANSIT", () => {
    assert.equal(primitiveFor("inside_airport"), "TRANSIT", "positive control: what Trips' table would say");
    assert.deepEqual(Primitive.experienceTypeFor({ recType: "inside_airport", title: "Airport Lounge / Rest Area", insideAirport: true }), { type: "REST", typeBasis: "airside_card" });
    assert.deepEqual(Primitive.experienceTypeFor({ recType: "inside_airport", title: "Duty-Free & Airport Shops", insideAirport: true }), { type: "SHOP", typeBasis: "airside_card" });
    assert.deepEqual(Primitive.experienceTypeFor({ recType: "inside_airport", title: "Airport Art & Culture", insideAirport: true }), { type: "SEE", typeBasis: "airside_card" });
    assert.deepEqual(Primitive.experienceTypeFor({ recType: "inside_airport", title: "Some Future Card", insideAirport: true }), { type: "EXPLORE", typeBasis: "unmapped" });
    assert.deepEqual(Primitive.experienceTypeFor({ recType: "near_airport", title: "Airport Lounge / Rest Area", insideAirport: false }), { type: "EXPLORE", typeBasis: "unmapped" });
  });

  it("every airside card the producer writes is in the catalogue — a renamed title fails here, not silently as EXPLORE", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), NOW, {}));
    const airside = recs.filter((r) => r.insideAirport);
    assert.ok(airside.length >= 5, `positive control: the whole airside catalogue, got ${JSON.stringify(airside.map((r) => r.title))}`);
    for (const r of airside) assert.notEqual(r.experience.typeBasis, "unmapped", `airside "${r.title}" (${r.recType}) has no type`);
    const types = new Map(airside.map((r) => [r.title, r.experience.type]));
    assert.equal(types.get("Airport Dining"), "EAT");
    assert.equal(types.get("Rest & Sleep Pod"), "REST");
  });

  it("the landside producer: restaurant → EAT, pub → NIGHTLIFE (its rec_type), museum → EXPLORE (rec_type 'activity'), spa → REST", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), NOW, {}));
    const byPlace = new Map(recs.filter((r) => r.placeId).map((r) => [r.placeId, r.experience.type]));
    assert.equal(byPlace.get("place-food"), "EAT");
    assert.equal(byPlace.get("place-bar"), "NIGHTLIFE");
    assert.equal(byPlace.get("place-museum"), "EXPLORE");
    assert.equal(byPlace.get("place-spa"), "REST");
    const escape = recs.find((r) => r.recType === "quick_city_escape");
    assert.ok(escape, "positive control: a twelve-hour window offers the city escape");
    assert.equal(escape.experience.type, "EXPLORE");
  });

  it("every member is Trips' default for the type — read, not re-stated", () => {
    for (const type of ACTIVITY_PRIMITIVES) {
      const recType = { EAT: "food", REST: "rest", NIGHTLIFE: "nightlife", MEET: "meetup" }[type as string];
      if (!recType) continue;
      const e = Primitive.layoverExperienceFor({ recType, title: "x", insideAirport: false });
      const d = PRIMITIVE_DEFAULTS[type];
      assert.equal(e.type, type);
      assert.equal(e.minDuration, d.minimumMinutes); assert.equal(e.idealDuration, d.idealMinutes);
      assert.equal(e.compressibility, d.compressibility); assert.equal(e.interruptibility, d.interruptibility);
      assert.equal(e.reversibility, d.reversibility); assert.equal(e.costRange, d.costBand);
      assert.equal(e.energyCost, d.energyCost);
      assert.equal(e.reservationRequirement, d.reservationRequired === true ? "required" : d.reservationRequired === false ? "not_required" : "unknown");
    }
  });

  it("reservation: Trips' null is 'unknown', never 'not_required'", () => {
    assert.equal(PRIMITIVE_DEFAULTS.EAT.reservationRequired, null, "positive control");
    assert.equal(Primitive.layoverExperienceFor({ recType: "food", title: "x", insideAirport: false }).reservationRequirement, "unknown");
    assert.equal(PRIMITIVE_DEFAULTS.MEET.reservationRequired, false, "positive control");
    assert.equal(Primitive.layoverExperienceFor({ recType: "meetup", title: "x", insideAirport: false }).reservationRequirement, "not_required");
  });

  it("weather is Trips' RAIN RULE, checked against the real compiler for all thirteen types", () => {
    const at = (h: string) => `2026-09-13T${h}:00.000Z`;
    const rain: PulseInterpretation = {
      kind: "rain_arriving", subjectId: "x", interpretation: "", relevance: ["stage"],
      effects: [{ kind: "plan_invalidated", subjectIds: ["some-other-plan"], detail: "" }],
      estimate: { value: {} as any, confidence: 0.8, sourceClass: "firsthand_unverified", observedAt: at("11:50"), expiresAt: at("13:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 } },
    } as PulseInterpretation;
    const point = { lat: 48.8566, lng: 2.3522 };
    for (const type of ACTIVITY_PRIMITIVES) {
      const inputs: CompileInputs = {
        now: Date.parse(at("12:00")),
        window: {
          id: "fw", position: "between", beginsAt: at("12:00"), endsAt: at("20:00"), durationMinutes: 480,
          origin: { placeId: "o", lat: point.lat, lng: point.lng } as any, requiredDestination: null,
          participants: ["me"], hardConstraints: [], confidence: "HIGH" as any, certified: true, reservedMinutes: 0,
          afterCommitmentId: null, beforeCommitmentId: null,
        } as any,
        origin: point, participants: [{ userId: "me" }],
        candidates: [{ id: "c", placeId: "p", name: "c", placeType: null, point, primitive: type as ActivityPrimitive, source: "test", openingWindows: [{ opensAt: at("00:00"), closesAt: at("23:59") }] }],
        liveSignals: [rain], travel: { minutes: () => ({ minutes: 5, mode: "walk" }) }, goals: [], preferences: {}, nextCommitment: null,
      };
      const tripsInvalidates = compileExperiences(inputs).experiences[0]!.reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED");
      assert.equal(Primitive.rainExposed(type), tripsInvalidates, `${type}: the layover weather rule and Trips' compiler disagree`);
    }
  });

  it("an airside card is all-weather because it is under the terminal roof — a fact, and it says so", () => {
    const lounge = Primitive.layoverExperienceFor({ recType: "inside_airport", title: "Airport Lounge / Rest Area", insideAirport: true });
    assert.equal(Primitive.rainExposed("REST"), true, "positive control: a landside REST is rain-exposed under Trips' rule");
    assert.equal(lounge.weatherCompatibility, "all_weather");
    assert.equal(lounge.weatherBasis, "inside_airport");
    const landsideRest = Primitive.layoverExperienceFor({ recType: "rest", title: "x", insideAirport: false });
    assert.equal(landsideRest.weatherCompatibility, "unknown", "a landside REST is a spa or a day hotel: the venue decides");
    assert.equal(landsideRest.weatherBasis, "venue_dependent");
  });

  it("weather by type: airside all-weather; landside REST and EXPLORE unknown; every other type keeps Trips' rain rule (WALK, PHOTO fair-weather)", () => {
    assert.deepEqual([...Primitive.WEATHER_DECIDED_BY_VENUE].sort(), ["EXPLORE", "REST"]);
    for (const type of ACTIVITY_PRIMITIVES) {
      assert.deepEqual(Primitive.weatherCompatibilityFor(type, true), { weatherCompatibility: "all_weather", weatherBasis: "inside_airport" }, `airside ${type}`);
      const landside = Primitive.weatherCompatibilityFor(type, false);
      if (type === "REST" || type === "EXPLORE") {
        assert.deepEqual(landside, { weatherCompatibility: "unknown", weatherBasis: "venue_dependent" }, type);
      } else {
        assert.deepEqual(landside, { weatherCompatibility: Primitive.rainExposed(type) ? "fair_weather" : "all_weather", weatherBasis: "category_default" }, type);
      }
    }
    assert.equal(Primitive.weatherCompatibilityFor("WALK", false).weatherCompatibility, "fair_weather", "Trips' rule kept where the type IS the exposure");
    assert.equal(Primitive.weatherCompatibilityFor("PHOTO", false).weatherCompatibility, "fair_weather");
  });

  it("no producer card tells a traveller an indoor place is weather-dependent: museum, spa, day hotel, shopping, temple, park — through the app's own line", async () => {
    const indoorish = [
      { id: "w-museum", name: "National Museum", place_type: "museum" },
      { id: "w-spa", name: "Hot Spring Spa", place_type: "spa" },
      { id: "w-hotel", name: "Day Hotel", place_type: "hotel" },
      { id: "w-mall", name: "Big Mall", place_type: "shopping" },
      { id: "w-temple", name: "Jingfu Temple", place_type: "temple" },
      { id: "w-park", name: "City Park", place_type: "park" },
    ].map((p, i) => ({ ...p, category: "x", neighborhood: null, blurb: null, verified: true, city: "Taoyuan", status: "active", lat: 25.0 + i * 0.005, lng: 121.28 }));
    const t = { discovery_places: indoorish, layover_recommendations: [], layover_plan_stops: [], layover_events: [] };
    const recs = cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), NOW, {}));
    const served = recs.filter((r) => r.placeId);
    assert.deepEqual(served.map((r) => r.placeId).sort(), indoorish.map((p) => p.id).sort(), "positive control: the producer served all six");
    for (const r of served) {
      assert.ok(["REST", "EXPLORE"].includes(r.experience.type), `positive control: "${r.title}" is ${r.experience.type}`);
      assert.equal(r.experience.weatherCompatibility, "unknown", `"${r.title}" claims ${r.experience.weatherCompatibility}`);
      const line = typicalExperienceLine(r.experience);
      assert.ok(line && line.startsWith("Typical for "), `positive control: "${r.title}" still gets its line: ${line}`);
      assert.ok(!/weather/i.test(line), `"${r.title}" tells the traveller: ${line}`);
      assert.ok(!/weather/i.test(typicalExperienceA11y(line)), `"${r.title}" screen reader: ${typicalExperienceA11y(line)}`);
    }
  });
});

// ── C. NEVER THE SAFETY MATH ─────────────────────────────────────────────────

describe("C. the descriptor never reaches a rating, a deadline, plan fit or storage (census §16 / L293)", () => {
  it("a discovery card's dwell is still null — the descriptor's minutes are not the card's minutes", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), NOW, {}));
    const fromPlaces = recs.filter((r) => r.placeId);
    assert.ok(fromPlaces.length >= 3, `positive control: got ${fromPlaces.length}`);
    for (const r of fromPlaces) {
      assert.equal(r.activityTimeMin, null, `"${r.title}" now carries ${r.activityTimeMin} minutes nobody stated`);
      assert.equal(typeof r.experience.minDuration, "number", `"${r.title}": positive control — the typical value exists, beside it`);
    }
  });

  it("nothing is stored: no written row and no audit event carries any of it", async () => {
    for (const stableIds of [false, true]) {
      const t = tables();
      cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), NOW, { stableIds }));
      assert.ok(t.layover_recommendations.length > 0, "positive control");
      for (const row of t.layover_recommendations) {
        for (const k of Object.keys(row)) {
          assert.ok(!/experience|primitive|compressib|interrupt|reversib|energy|weather|reservation|ideal|min_?duration/i.test(k), `stableIds=${stableIds}: row key ${k}`);
        }
      }
      const blob = JSON.stringify(t.layover_events);
      for (const word of ["experience", "category_default", "compressibility", "weatherCompatibility"]) {
        assert.ok(!blob.includes(word), `stableIds=${stableIds}: the audit event carries ${word}`);
      }
    }
  });

  it("change every default and nothing but the descriptor moves: ratings, deadlines, order, bands, rows and the event are byte-identical", async () => {
    const s = session();
    const run = async () => {
      const t = tables();
      const recs = cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, s, NOW, { stableIds: true }));
      // The fake database stamps `id` and `created_at` on every insert; neither is the engine's.
      const own = (rs: any[]) => rs.map(({ id: _i, created_at: _c, ...rest }) => rest);
      return { recs, rows: own(t.layover_recommendations), events: own(t.layover_events) };
    };
    const strip = (rs: any[]) => rs.map(({ experience: _e, id: _i, ...rest }) => rest);

    const base = await run();
    const saved = new Map<ActivityPrimitive, any>();
    const mutable = PRIMITIVE_DEFAULTS as Record<ActivityPrimitive, any>;
    for (const p of ACTIVITY_PRIMITIVES) {
      saved.set(p, mutable[p]);
      mutable[p] = { ...mutable[p], minimumMinutes: 9_000, idealMinutes: 9_999, compressibility: 0, interruptibility: "low", reversibility: "irreversible", costBand: "high", energyCost: "high", reservationRequired: true };
    }
    let changed: Awaited<ReturnType<typeof run>>;
    try {
      changed = await run();
    } finally {
      for (const p of ACTIVITY_PRIMITIVES) mutable[p] = saved.get(p);
    }
    assert.ok(base.recs.length >= 5, "positive control");
    // Positive control: the change DID reach the descriptor.
    for (const r of changed.recs) assert.equal(r.experience.minDuration, 9_000, `"${r.title}" did not see the changed default`);
    assert.deepEqual(strip(changed.recs), strip(base.recs), "a default reached a served card's safety fields, order or band");
    assert.deepEqual(changed.rows, base.rows, "a default reached a written row");
    assert.deepEqual(JSON.parse(JSON.stringify(changed.events)), JSON.parse(JSON.stringify(base.events)), "a default reached the audit event");
  });

  it("the stored read path attaches the descriptor without touching what the row says", async () => {
    const t = tables();
    cards(await generateRecommendations(makeLayoverDb(t), AIRPORT, session(), NOW, { stableIds: true }));
    const stored = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    assert.ok(stored.length > 0, "positive control");
    for (const r of stored) {
      assertTenMembers(r);
      if (r.placeId) assert.equal(r.activityTimeMin, null, `"${r.title}"`);
    }
  });
});

// ── D. ONE IMPORTER ──────────────────────────────────────────────────────────

describe("D. only the recommendation service imports the descriptor", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test" || name === "__tests__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  it("no product file but LayoverRecommendationService.ts imports layoverExperiencePrimitive", () => {
    const importers = walk(SRC)
      .filter((p) => /from\s+["'][^"']*layoverExperiencePrimitive(\.js)?["']/.test(readFileSync(p, "utf8")))
      .map((p) => relative(SRC, p).split("\\").join("/"));
    assert.deepEqual(importers, ["services/airport/LayoverRecommendationService.ts"]);
  });

  it("in that service the descriptor is computed only where a card is served, beside its band", () => {
    const src = readFileSync(join(SRC, "services", "airport", "LayoverRecommendationService.ts"), "utf8");
    const lines = src.split("\n");
    const at = lines.flatMap((l, i) => (l.includes("layoverExperienceFor(") ? [i] : []));
    assert.equal(at.length, 2, `expected the two serving sites, found:\n${at.map((i) => lines[i]).join("\n")}`);
    // Each sits in the object a served card is built from, beside the band the
    // pin carries — after `sanitizeRecommendation`, never before `assess`.
    for (const i of at) {
      assert.ok(lines.slice(Math.max(0, i - 2), i + 1).some((l) => /feasibility/.test(l)), `a call outside a serving site: ${lines[i]!.trim().slice(0, 160)}`);
    }
    assert.ok(at[0]! > src.slice(0, src.indexOf("const ranked = rankActivities(")).split("\n").length, "the descriptor is computed before the cards are ranked");
  });
});
