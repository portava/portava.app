/**
 * layoverUnmeasuredJourney — census-layover L293, "a journey nobody measured is
 * not a fifteen-minute journey".
 *
 * THE ROW'S OWN WORDS (App C1, "never query a semantic substitute for a missing
 * field and pretend it is the requested fact; unknown is preferable to
 * fabricated certainty"). It names THREE substitutions, all on the safety path:
 *
 *   (a) `estimateTravelTime(placeType)` returned 15 minutes for a cafe,
 *       restaurant or shop and 25 for anything else — WITHOUT READING A
 *       COORDINATE. Its own doc comment said so: *"A per-category CONSTANT —
 *       15 or 25 minutes — chosen without a coordinate."* `assess` then doubled
 *       it into a round trip and turned it into `"safe"`.
 *   (b) `estimateActivityTime(placeType)` substituted 30 / 90 / 60 minutes for
 *       a duration no row carries — `discovery_places` has no duration column
 *       at all.
 *   (c) `GET /:id/safety` built a fictitious probe — `travelTimeMin: 20,
 *       activityTimeMin: 30` — purely so `assess` had something to score, and
 *       published the result as the session's OVERALL safety. Those two numbers
 *       were identical for every session at every airport on earth.
 *
 * WHY PROVENANCE WAS NOT THE FIX, AND THIS IS. All three already carried
 * `travelTimeSource: "category_default"` (§7's pass, L9/L65). A label on an
 * invented number does not stop the number driving a **safety rating** and a
 * **plan-fit verdict** a traveller acts on when deciding whether they can leave
 * an airport and get back before their flight closes. The rating was the
 * product of the fabrication, not a neighbour of it.
 *
 * THE SHAPE IS L47'S, DELIBERATELY (`services/airport/LayoverPlanFit.ts`,
 * commit `eb70ab3b2`): an airside 0 is a FACT, a landside 0 is an ABSENCE, the
 * total is a LOWER BOUND whenever a term is unstated, and a lower bound can
 * REFUSE but can never CERTIFY. `statedTravelMin` / `statedDurationMin` are
 * imported from that module rather than re-implemented, so the plan surface and
 * the recommendation surface cannot drift apart about what a zero means.
 *
 * AND THE SEAM IS THE ONE THAT ALREADY EXISTS. `domain/trips/contracts/
 * TravelTimeProvider.ts` is the travel-time PORT; its only implementation is
 * `noRoutedProvider`, an honest stub whose id is `"none-configured"` and whose
 * every answer is `{ kind: "unknown", reason: "NO_ROUTED_PROVIDER" }`. The
 * recommendation service now ASKS it. Today that is what makes every landside
 * leg unmeasured — the absence is produced by the port, not asserted by a
 * comment — and the day a routed provider is configured the same call yields a
 * figure.
 *
 * ── SEEN GOING RED FIRST ────────────────────────────────────────────────────
 * Recorded in §16 of docs/architecture/census-layover.md.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest). Express + the layover
 * database double. No network.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverUnmeasuredJourney.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
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
// Namespace imports for the surface this fix ADDS: a missing named export is a
// link error that takes the whole file down with it, and a file that cannot
// load reports one failure instead of the twenty-odd this pins. Each case says
// what it needs and fails on its own.
import * as Engine from "../services/airport/LayoverSafetyEngine.js";
import * as Feasibility from "../services/airport/LayoverFeasibility.js";
import { statedTravelMin, statedDurationMin } from "../services/airport/LayoverPlanFit.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, "..", "services", "airport", "LayoverRecommendationService.ts");
const ROUTES = join(HERE, "..", "routes", "airport.ts");

/** `{ ok }` result adapter — both readers answer a refusal separately from an empty list. */
function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

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
    departureTime: new Date(now + 12 * 3_600_000).toISOString(),
    boardingTime: null, layoverMinutes: 715,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

/**
 * One place on each side of the deleted 15/25 split, and one on each side of
 * the deleted 30/90/60 split, so the absence is proven independent of which
 * constant the category ladder WOULD have picked.
 */
const PLACES = [
  { id: "place-1", name: "Night Market", place_type: "attraction", category: "food", neighborhood: "Zhongli", blurb: "Snacks", verified: true, city: "Taoyuan", status: "active", lat: 24.95, lng: 121.22 },
  { id: "place-2", name: "Riverside Cafe", place_type: "cafe", category: "food", neighborhood: null, blurb: "Coffee", verified: false, city: "Taoyuan", status: "active", lat: 25.01, lng: 121.30 },
];

function tables(): Record<string, any[]> {
  return {
    discovery_places: PLACES.map((p) => ({ ...p })),
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
  };
}

// ── A. THE PRODUCER: no card carries a category constant any more ───────────

describe("L293a/b — the recommendation producer states no journey it has not measured", () => {
  for (const stableIds of [false, true]) {
    it(`stableIds=${stableIds}: every landside card's travel time is null and its source is "unmeasured"`, async () => {
      const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), { stableIds }));
      const landside = recs.filter((r) => !r.insideAirport);
      assert.ok(landside.length >= 3, `positive control: expected discovery + escape cards, got ${landside.length}`);
      for (const r of landside) {
        assert.equal(r.travelTimeMin, null, `"${r.title}" still carries a travel time of ${r.travelTimeMin}`);
        assert.equal(r.travelTimeSource, "unmeasured", `"${r.title}"`);
      }
    });
  }

  it("the deleted category constants appear on no card: no 15, no 25, no 30-minute landside leg", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), {}));
    const landside = recs.filter((r) => !r.insideAirport);
    assert.ok(landside.length > 0, "positive control");
    for (const r of landside) {
      assert.ok(![15, 25, 30].includes(r.travelTimeMin as any), `"${r.title}" carries the category constant ${r.travelTimeMin}`);
    }
  });

  it("a discovery place's dwell time is null — `discovery_places` has no duration column to read", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), {}));
    const fromPlaces = recs.filter((r) => r.placeId);
    assert.ok(fromPlaces.length >= 2, `positive control: expected the two discovery cards, got ${fromPlaces.length}`);
    for (const r of fromPlaces) {
      assert.equal(r.activityTimeMin, null, `"${r.title}" still substitutes ${r.activityTimeMin} minutes for a duration nobody stated`);
    }
  });

  it("airside cards are untouched: 0 minutes of travel is a FACT, and their dwell is the card's own", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), {}));
    const airside = recs.filter((r) => r.insideAirport);
    assert.ok(airside.length >= 2, `positive control: got ${airside.length}`);
    for (const r of airside) {
      assert.equal(r.travelTimeMin, 0, `"${r.title}"`);
      assert.equal(r.travelTimeSource, "inside_airport", `"${r.title}"`);
      assert.ok(typeof r.activityTimeMin === "number" && r.activityTimeMin > 0, `"${r.title}": ${r.activityTimeMin}`);
    }
  });

  it("no landside card is rated safe or possible_but_risky — the rating cannot outrun the measurement", async () => {
    // The window here is TWELVE HOURS. Before this fix every one of these was
    // "safe", on a 15- or 25-minute leg nobody had measured.
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), {}));
    const landside = recs.filter((r) => !r.insideAirport);
    assert.ok(landside.length > 0, "positive control");
    for (const r of landside) {
      assert.ok(r.safetyRating !== "safe" && r.safetyRating !== "possible_but_risky",
        `"${r.title}" is rated ${r.safetyRating} on a journey nobody measured`);
    }
  });

  it("the airside cards ARE still safe in a wide window — this fix refuses to rate, it does not refuse everything", async () => {
    const recs = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session(), Date.now(), {}));
    const airside = recs.filter((r) => r.insideAirport);
    assert.ok(airside.some((r) => r.safetyRating === "safe"),
      `every airside card was downgraded: ${JSON.stringify(airside.map((r) => [r.title, r.safetyRating]))}`);
  });
});

// ── B. assess() FAILS CLOSED on an unstated leg ─────────────────────────────

describe("assess — an unstated landside leg can never be certified", () => {
  const wide = () => session();

  it("travelTimeMin: null is never safe and never possible_but_risky, however wide the window", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "Night Market", travelTimeMin: null, activityTimeMin: 60, insideAirport: false, verified: true,
    } as any);
    assert.ok(a.rating !== "safe" && a.rating !== "possible_but_risky", `rated ${a.rating}`);
  });

  it("the warning names the REAL cause — not a time it never measured", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "Night Market", travelTimeMin: null, activityTimeMin: 60, insideAirport: false, verified: true,
    } as any);
    assert.equal(typeof Engine.UNMEASURED_TRAVEL_WARNING, "string",
      "LayoverSafetyEngine must export UNMEASURED_TRAVEL_WARNING — the sentence the traveller is shown");
    assert.equal(a.warningReason, Engine.UNMEASURED_TRAVEL_WARNING, `warning was: ${a.warningReason}`);
    assert.ok(!/only have|min usable/.test(String(a.warningReason)),
      "the warning claims an arithmetic cause for a missing measurement");
  });

  it("an unstated DWELL also fails closed, with its own sentence", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "Night Market", travelTimeMin: 20, activityTimeMin: null, insideAirport: false, verified: true,
    } as any);
    assert.ok(a.rating !== "safe" && a.rating !== "possible_but_risky", `rated ${a.rating}`);
    assert.equal(typeof Engine.UNSTATED_ACTIVITY_WARNING, "string",
      "LayoverSafetyEngine must export UNSTATED_ACTIVITY_WARNING");
    assert.equal(a.warningReason, Engine.UNSTATED_ACTIVITY_WARNING);
  });

  it("requiredMinutes is published as a LOWER BOUND when a term is unstated", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "x", travelTimeMin: null, activityTimeMin: null, insideAirport: false,
    } as any);
    assert.equal((a as any).requiredMinutesIsLowerBound, true);
    assert.equal((a as any).statedTravelMin, null);
    assert.equal((a as any).statedActivityMin, null);
    // The bound omits the legs it could not state, so it is the buffer alone.
    assert.equal(a.requiredMinutes, a.returnBufferMin);
  });

  it("a fully stated landside candidate is unchanged — every existing number survives", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "x", travelTimeMin: 20, activityTimeMin: 60, insideAirport: false, verified: true,
    } as any);
    assert.equal((a as any).requiredMinutesIsLowerBound, false);
    assert.equal((a as any).statedTravelMin, 20);
    assert.equal(a.requiredMinutes, 20 * 2 + 60 + a.returnBufferMin);
    assert.equal(a.rating, "safe", `a measured, comfortable outing must still be safe, got ${a.rating}`);
  });

  it("AIRSIDE 0 IS A FACT — an inside-airport candidate is still safe with 0 travel", () => {
    const a = Engine.assess(AIRPORT, wide(), {
      title: "Lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true,
    } as any);
    assert.equal(a.rating, "safe");
    assert.equal((a as any).statedTravelMin, 0);
    assert.equal((a as any).requiredMinutesIsLowerBound, false);
  });

  it("a LANDSIDE 0 is an ABSENCE, not a free journey — the same rule LayoverPlanFit draws", () => {
    assert.equal(statedTravelMin({ travelMin: 0, insideAirport: false }), null);
    assert.equal(statedTravelMin({ travelMin: 0, insideAirport: true }), 0);
    assert.equal(statedDurationMin({ durationMin: 0 }), null);
    const a = Engine.assess(AIRPORT, wide(), {
      title: "x", travelTimeMin: 0, activityTimeMin: 60, insideAirport: false,
    } as any);
    assert.ok(a.rating !== "safe" && a.rating !== "possible_but_risky", `rated ${a.rating} on a free landside journey`);
  });

  it("the lower bound can still REFUSE: a stated leg that overflows is not_recommended for the RIGHT reason", () => {
    const tight = session({ departureTime: new Date(Date.now() + 4 * 3_600_000).toISOString(), layoverMinutes: 235 });
    const a = Engine.assess(AIRPORT, tight, {
      title: "x", travelTimeMin: 90, activityTimeMin: 120, insideAirport: false, verified: true,
    } as any);
    assert.equal(a.rating, "not_recommended");
    assert.notEqual(a.warningReason, Engine.UNMEASURED_TRAVEL_WARNING);
  });

  it("`wantsToLeave: false` still answers airport_only, not the unmeasured refusal", () => {
    const a = Engine.assess(AIRPORT, session({ wantsToLeave: false }), {
      title: "x", travelTimeMin: null, activityTimeMin: null, insideAirport: false,
    } as any);
    assert.equal(a.rating, "airport_only");
  });

  it("rankActivities orders unstated legs LAST WITHIN ONE RATING — the travel key, not the rating key", () => {
    // ── WHY THIS CASE EXISTS, MEASURED ──────────────────────────────────────
    // The case below it ("orders unstated legs LAST") does NOT reach the
    // travel-time tiebreak: an unstated leg is `not_recommended` and a measured
    // comfortable one is `safe`, so `rankActivities`' RATING key separates them
    // before the travel key is consulted. Measured: mutating the comparator's
    // `?? Number.POSITIVE_INFINITY` to `?? Number.NEGATIVE_INFINITY` — an
    // absence treated as the shortest journey of all — left the whole layover
    // suite at 158/158. The tiebreak was unpinned.
    //
    // `wantsToLeave: false` makes every landside candidate `airport_only`
    // whatever its legs, so the ratings tie and the travel key alone decides.
    const s = session({ wantsToLeave: false });
    const ranked = Engine.rankActivities(AIRPORT, s, [
      { title: "unstated", travelTimeMin: null, activityTimeMin: 30, insideAirport: false },
      { title: "far",      travelTimeMin: 40,   activityTimeMin: 30, insideAirport: false },
      { title: "near",     travelTimeMin: 10,   activityTimeMin: 30, insideAirport: false },
    ] as any);
    assert.deepEqual(ranked.map((r) => r.assessment.rating), ["airport_only", "airport_only", "airport_only"],
      "positive control: the ratings must TIE, or this case is testing the rating key again");
    assert.deepEqual(ranked.map((r) => r.title), ["near", "far", "unstated"]);
  });

  it("rankActivities orders unstated legs LAST within a rating, and produces no NaN", () => {
    const ranked = Engine.rankActivities(AIRPORT, session(), [
      { title: "unstated", travelTimeMin: null, activityTimeMin: null, insideAirport: false },
      { title: "far",      travelTimeMin: 40,   activityTimeMin: 30,   insideAirport: false, verified: true },
      { title: "near",     travelTimeMin: 10,   activityTimeMin: 30,   insideAirport: false, verified: true },
    ] as any);
    const order = ranked.map((r) => r.title);
    assert.ok(order.indexOf("unstated") > order.indexOf("near"),
      `unstated legs must not sort ahead of measured ones: ${JSON.stringify(order)}`);
    for (const r of ranked) assert.ok(Number.isFinite(r.assessment.requiredMinutes), `${r.title} produced NaN`);
  });
});

// ── C. THE /safety PROBE IS GONE ────────────────────────────────────────────

describe("L293c — certifyFeasibility with no probe makes no journey claim", () => {
  it("assessWindowOnly exists and rates the WINDOW, carrying no travel or dwell", () => {
    assert.equal(typeof Engine.assessWindowOnly, "function",
      "LayoverSafetyEngine must export assessWindowOnly — the answer with no journey in it");
    const s = session();
    const a = Engine.assessWindowOnly(AIRPORT, s, Engine.computeWindow(AIRPORT, s));
    assert.equal((a as any).statedTravelMin, null);
    assert.equal((a as any).statedActivityMin, null);
    assert.equal(a.requiredMinutes, a.returnBufferMin, "a window-only answer requires the buffer and nothing else");
    assert.equal((a as any).requiredMinutesIsLowerBound, true);
  });

  it("its rating agrees with adviseLeaving's verdict — one response cannot say two things", () => {
    for (const s of [
      session(),
      session({ departureTime: new Date(Date.now() + 5 * 3_600_000).toISOString() }),
      session({ departureTime: new Date(Date.now() + 3.5 * 3_600_000).toISOString() }),
      session({ wantsToLeave: false }),
    ]) {
      const w = Engine.computeWindow(AIRPORT, s);
      const advice = Engine.adviseLeaving(AIRPORT, s, w);
      const a = Engine.assessWindowOnly(AIRPORT, s, w);
      const expected = { yes: "safe", tight: "possible_but_risky", no: "not_recommended", stay_airside: "airport_only" } as const;
      assert.equal(a.rating, expected[advice.verdict],
        `verdict ${advice.verdict} (usable ${w.usableMinutes}) but rating ${a.rating}`);
    }
  });

  it("a probe that STATES its leg is unmeasured gets no outbound estimate and no certification", () => {
    // ── WHY THIS CASE EXISTS, MEASURED ──────────────────────────────────────
    // `outboundTravelEstimate` returns `null` for an unstated leg rather than a
    // zero-minute STATIC_DEFAULT placeholder. Nothing reached that branch:
    // `/safety` now passes NO probe, and every probe in
    // layoverFeasibility*.test.ts states both numbers. Measured — replacing the
    // `return null` with `pointEstimate(0, "STATIC_DEFAULT", "LOW", 3, …)` left
    // the whole layover suite at 159/159. `LandsideProbe` survives for a caller
    // that genuinely holds a journey, so the branch that handles one who says
    // "nobody measured it" has to be pinned by a caller who says exactly that.
    const record = Feasibility.certifySessionFeasibility(
      AIRPORT as any, { ...session(), id: "session-1" } as any,
      { nowMs: Date.now(), landsideProbe: { title: "Leaving airport", travelTimeMin: null, activityTimeMin: 30, travelTimeSource: "unmeasured" } as any },
    );
    assert.equal(record.estimates.outboundTravel, null,
      "a zero-minute placeholder estimate stood in for a leg nobody measured");
    assert.ok(record.landside, "positive control: the probe WAS assessed");
    assert.equal(record.landside!.statedTravelMin, null);
    assert.ok(record.landside!.rating !== "safe" && record.landside!.rating !== "possible_but_risky",
      `rated ${record.landside!.rating}`);
  });

  it("a record certified with no probe carries no landside assessment and no outbound estimate", () => {
    const record = Feasibility.certifySessionFeasibility(AIRPORT as any, { ...session(), id: "session-1" } as any, { nowMs: Date.now() });
    assert.equal(record.landside, null);
    assert.equal(record.estimates.outboundTravel, null);
    assert.equal(record.inputs.landsideProbe, null);
  });
});

// ── D. THE PERSISTED READ PATH ──────────────────────────────────────────────

describe("getRecommendations — a stored landside zero reads back as an absence", () => {
  it("landside 0 ⇒ null / unmeasured; landside legacy 25 ⇒ 25 / category_default; airside 0 ⇒ 0 / inside_airport", async () => {
    const t = tables();
    t.layover_recommendations.push(
      { id: "r1", session_id: "session-1", rec_type: "food", title: "Airport Dining", safety_rating: "safe", travel_time_min: 0, activity_time_min: 45, return_buffer_min: 140, hard_return_time: null, inside_airport: true, sort_order: 0 },
      { id: "r2", session_id: "session-1", rec_type: "activity", title: "Night Market", safety_rating: "not_recommended", travel_time_min: 0, activity_time_min: 0, return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 1 },
      { id: "r3", session_id: "session-1", rec_type: "activity", title: "Legacy Row", safety_rating: "safe", travel_time_min: 25, activity_time_min: 90, return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 2 },
    );
    const recs = cards(await getRecommendations(makeLayoverDb(t), "session-1"));
    const by = (id: string) => recs.find((r) => r.id === id)!;
    assert.equal(by("r1").travelTimeMin, 0);
    assert.equal(by("r1").travelTimeSource, "inside_airport");
    assert.equal(by("r2").travelTimeMin, null, "a landside stored zero came back as a measured zero");
    assert.equal(by("r2").activityTimeMin, null);
    assert.equal(by("r2").travelTimeSource, "unmeasured");
    // A row written before this fix still holds its category constant. It is
    // reported as what it is, not upgraded and not erased.
    assert.equal(by("r3").travelTimeMin, 25);
    assert.equal(by("r3").travelTimeSource, "category_default");
  });

  it('"unmeasured" is part of the declared vocabulary and is NOT routed', () => {
    assert.ok((Engine.TRAVEL_TIME_SOURCES as readonly string[]).includes("unmeasured"));
    assert.equal(Engine.TRAVEL_TIME_SOURCE_IS_ROUTED.unmeasured, false);
  });
});

// ── E. THE SOURCE TRIPWIRE ──────────────────────────────────────────────────

describe("the two estimators are deleted, not renamed", () => {
  it("LayoverRecommendationService declares neither estimateTravelTime nor estimateActivityTime", () => {
    const src = readFileSync(SERVICE, "utf8");
    assert.ok(!/function\s+estimateTravelTime\b/.test(src), "estimateTravelTime is still declared");
    assert.ok(!/function\s+estimateActivityTime\b/.test(src), "estimateActivityTime is still declared");
  });

  it("the /safety route holds no literal probe", () => {
    const code = readFileSync(ROUTES, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/travelTimeMin:\s*20/.test(code), "the 20-minute probe leg is still there");
    assert.ok(!/activityTimeMin:\s*30/.test(code), "the 30-minute probe activity is still there");
  });

  it("the recommendation service asks the travel-time PORT rather than a category ladder", () => {
    const src = readFileSync(SERVICE, "utf8");
    assert.ok(/TravelTimeProvider|noRoutedProvider|landsideLeg/.test(src),
      "no travel-time port is consulted anywhere in the producer");
  });
});

// ── F. THE HTTP BOUNDARY ────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const TOKEN = "unmeasured-token";
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

function stage(over: Record<string, any> = {}) {
  const t: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID, departure_time: new Date(Date.now() + 12 * 3_600_000).toISOString(), layover_minutes: 715, immigration_required: false, ...over })],
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

describe("routes/airport — the fabrication does not cross the HTTP boundary", () => {
  it("GET /recommendations: landside cards carry null travel and are never rated safe", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/recommendations");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const recs: any[] = r.body.recommendations;
    const landside = recs.filter((c) => !c.insideAirport);
    assert.ok(landside.length > 0, `positive control: ${recs.length} cards, none landside`);
    for (const c of landside) {
      assert.equal(c.travelTimeMin, null, `"${c.title}"`);
      assert.equal(c.travelTimeSource, "unmeasured", `"${c.title}"`);
      assert.ok(c.safetyRating !== "safe" && c.safetyRating !== "possible_but_risky", `"${c.title}" → ${c.safetyRating}`);
    }
  });

  it("GET /safety: the body contains no 20 and no 30 that came from the deleted probe", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.travelTimeSource, "unmeasured");
    // `requiredMinutes` was the probe's own arithmetic (20*2 + 30 + buffer).
    // With no probe there is no journey in the answer at all.
    assert.equal(r.body.estimates.outboundTravel, null,
      "an outbound travel estimate exists for a journey that was never named");
  });

  it("GET /safety: overallRating agrees with advice.verdict", async () => {
    stage();
    const r = await req("GET", "/api/airport/sessions/session-1/safety");
    const expected = { yes: "safe", tight: "possible_but_risky", no: "not_recommended", stay_airside: "airport_only" } as any;
    assert.equal(r.body.overallRating, expected[r.body.advice.verdict],
      `${r.body.advice.verdict} vs ${r.body.overallRating}`);
  });

  it("POST /stops/from-recommendation: a card with no travel time cannot be timed into a plan", async () => {
    const t = stage();
    t.layover_recommendations.push({
      id: "11111111-1111-4111-8111-111111111111", session_id: "session-1", rec_type: "activity",
      title: "Night Market", safety_rating: "not_recommended", travel_time_min: 0, activity_time_min: 0,
      return_buffer_min: 140, hard_return_time: null, inside_airport: false, sort_order: 0, status: "active",
    });
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const url = new URL("/api/airport/sessions/session-1/stops/from-recommendation", base);
      const rq = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } }, (res) => {
        let raw = ""; res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      });
      rq.on("error", reject);
      rq.end(JSON.stringify({ recommendationId: "11111111-1111-4111-8111-111111111111" }));
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(t.layover_plan_stops.length, 0, "a stop was written for a journey nobody measured");
  });
});
