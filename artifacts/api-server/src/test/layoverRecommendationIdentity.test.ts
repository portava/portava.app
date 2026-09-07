/**
 * Layover recommendation identity — ids survive regeneration (flag ON), and the
 * legacy path stays exactly as it was (flag OFF).
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, no network.
 *
 * THE DEFECT. GET /sessions/:id/recommendations regenerates on every call
 * while `layover_safety_engine_enabled` is TRUE (production). Regeneration
 * deleted every row and re-inserted without reading ids back, so:
 *   - the returned cards carried NO id, and the client renders "Add to plan"
 *     only for cards with an id → the control never rendered in production;
 *   - layover_plan_stops.recommendation_id (ON DELETE SET NULL) was nulled on
 *     the next load, blinding the "already in your plan" guard.
 *
 * Under `layover_stable_recommendation_ids_enabled` (migration 2410, seeded FALSE) the
 * service upserts on (session_id, rec_key) and returns ids. These tests hold
 * both paths down.
 *
 * Run: node --import tsx/esm --test src/test/layoverRecommendationIdentity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  generateRecommendations,
  recommendationKey,
} from "../services/airport/LayoverRecommendationService.js";
import { LAYOVER_ENGINE_VERSION } from "../services/airport/LayoverSafetyEngine.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

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

describe("recommendationKey", () => {
  it("is stable for the same candidate and distinct across candidates", () => {
    const a = recommendationKey({ recType: "food", title: "Airport Dining", insideAirport: true });
    assert.equal(a, recommendationKey({ recType: "food", title: "Airport Dining", insideAirport: true }));
    assert.equal(recommendationKey({ recType: "food", title: "x", insideAirport: false, placeId: "place-1" }), "place:place-1");
    assert.notEqual(a, recommendationKey({ recType: "inside_airport", title: "Airport Dining", insideAirport: true }));
  });
});

describe("stable ids (flag ON)", () => {
  it("returns every card WITH an id, and a second generation keeps the same ids", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const first = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(first.length >= 4, `expected inside + discovery + escape cards, got ${first.length}`);
    for (const r of first) assert.ok(r.id, `card "${r.title}" has no id`);

    const second = await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000, { stableIds: true });
    const byTitle = (rs: typeof first) => new Map(rs.map((r) => [r.title, r.id]));
    const a = byTitle(first), b = byTitle(second);
    assert.equal(a.size, b.size);
    for (const [title, id] of a) assert.equal(b.get(title), id, `"${title}" changed id across regeneration`);
    // and the table holds exactly one row per card — no duplicates, nothing orphaned
    assert.equal(t.layover_recommendations.length, second.length);
  });

  it("a plan stop's recommendation_id still resolves after the cards are regenerated", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const first = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const chosen = first.find((r) => !r.insideAirport && r.placeId === "place-1")!;
    t.layover_plan_stops.push({ id: "stop-1", session_id: "session-1", recommendation_id: chosen.id, title: chosen.title });

    await generateRecommendations(db, AIRPORT, session(), Date.now() + 5 * 60_000, { stableIds: true });
    const stillThere = t.layover_recommendations.find((r) => r.id === chosen.id);
    assert.ok(stillThere, "the row the stop points at was deleted by regeneration");
    assert.equal(stillThere.rec_key, "place:place-1");
  });

  it("a card that no longer applies is removed; the others keep their ids", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const first = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const insideIds = new Set(first.filter((r) => r.insideAirport).map((r) => r.id));
    assert.ok(first.some((r) => !r.insideAirport), "positive control: landside cards present when wantsToLeave");

    // The traveller decides to stay airside: every landside card must go.
    const second = await generateRecommendations(db, AIRPORT, session({ wantsToLeave: false }), Date.now(), { stableIds: true });
    assert.ok(second.every((r) => r.insideAirport), "landside cards survived a stay-airside regeneration");
    for (const r of second) assert.ok(insideIds.has(r.id!), `inside card "${r.title}" did not keep its id`);
    assert.equal(t.layover_recommendations.length, second.length, "stale landside rows were not deleted");
  });

  it("legacy rows (rec_key NULL) for the session are swept on the first stable regeneration", async () => {
    const t = tables();
    t.layover_recommendations.push({ id: "legacy-1", session_id: "session-1", rec_key: null, title: "Old card", rec_type: "food", safety_rating: "safe" });
    const db = makeLayoverDb(t);
    await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(!t.layover_recommendations.some((r) => r.id === "legacy-1"), "legacy row survived");
  });

  it("a failed upsert is non-fatal: cards are still returned, just without ids", async () => {
    const t = tables();
    const db = makeLayoverDb(t, { failures: { "layover_recommendations:upsert": { message: "column rec_key does not exist" } } });
    const recs = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(recs.length >= 4);
    for (const r of recs) assert.equal(r.id, undefined);
  });
});

describe("legacy path (flag OFF) — unchanged", () => {
  it("returns cards WITHOUT ids, and regeneration replaces the rows (new ids)", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const first = await generateRecommendations(db, AIRPORT, session(), Date.now());
    for (const r of first) assert.equal(r.id, undefined, `legacy path leaked an id on "${r.title}"`);
    const idsA = new Set(t.layover_recommendations.map((r) => r.id));
    assert.ok(!t.layover_recommendations.some((r) => "rec_key" in r), "legacy path must not write rec_key");

    await generateRecommendations(db, AIRPORT, session(), Date.now() + 60_000);
    const idsB = new Set(t.layover_recommendations.map((r) => r.id));
    for (const id of idsB) assert.ok(!idsA.has(id), "legacy path is delete+insert: ids must not survive");
  });
});

describe("audit record and honest degradation", () => {
  it("recommendation_generated carries the engine version, the deadline inputs and what was written", async () => {
    const t = tables();
    const db = makeLayoverDb(t);
    const recs = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    const evt = t.layover_events.find((e) => e.event_type === "recommendation_generated");
    assert.ok(evt, "no recommendation_generated event");
    const m = evt.metadata;
    assert.equal(m.count, recs.length);
    assert.equal(m.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.equal(m.stableIds, true);
    assert.equal(m.inputs.iataCode, "TPE");
    assert.equal(m.inputs.airportVerified, false);
    assert.ok(typeof m.inputs.cutoff === "string" && !Number.isNaN(Date.parse(m.inputs.cutoff)));
    assert.ok(typeof m.hardReturnTime === "string");
    assert.equal(typeof m.breakdown.totalBuffer, "number");
    const written = Object.values(m.ratings as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(written, recs.length, "ratings histogram must account for every written card");
    // and the hard return time on every card equals the audited one
    for (const r of recs) assert.equal(r.hardReturnTime, m.hardReturnTime);
  });

  // Honesty note: this path was ALREADY fail-closed before this change (a
  // failed read left `data` null and `if (!data) return []` held). The change
  // adds the structured log spec Appendix C2 asks for; this test pins the
  // fail-closed outcome and cannot distinguish the log — a hand-revert of the
  // error check alone passes it.
  it("an unreadable discovery_places yields no landside discovery cards and does not throw", async () => {
    const t = tables();
    const db = makeLayoverDb(t, { failures: { "discovery_places:select": { message: "relation unavailable" } } });
    const recs = await generateRecommendations(db, AIRPORT, session(), Date.now(), { stableIds: true });
    assert.ok(recs.length > 0, "inside-airport cards must still be produced");
    assert.ok(!recs.some((r) => r.placeId), "a discovery place was fabricated from a failed read");
  });
});
