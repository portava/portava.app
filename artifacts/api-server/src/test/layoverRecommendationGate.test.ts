/**
 * Layover recommendations — §9.1's HARD GATE and §9.1's safety-first ORDERING.
 *
 * node:test + node:assert (NOT vitest). Fake table-backed DB, no network.
 *
 * ── THE TWO DEFECTS THIS FILE HOLDS DOWN ─────────────────────────────────────
 * Both are recorded in docs/architecture/census-layover.md and both were live
 * on the one layover path a traveller actually reaches — the dashboard's
 * `GET /airport/sessions/:id/recommendations`.
 *
 * L77 — THE GATE WAS MEASURED IN THE WRONG UNIT. Landside candidates were
 * fetched when `session.layoverMinutes >= 90`, and `layoverMinutes` is the
 * SCHEDULED arrival-to-departure span typed in at session creation. It knows
 * nothing about immigration, bags, security, traffic or the current time, so a
 * connection with a 600-minute scheduled window and no usable time at all was
 * offered a city, and a session whose stored figure understated the window was
 * refused one. The gate now reads `certified.envelope.usableMinutes` — the same
 * quantity the engine already uses to decide the `airport_only` tier, so the
 * gate and the tier can no longer disagree.
 *
 * L184 — THE SAFETY-FIRST COMPARATOR WAS DEAD CODE. `rankActivities` existed,
 * was tested, and had no caller outside `src/test/`; the cards were ordered by
 * `verified` and a time-of-day nudge, neither of which knows whether a card
 * still fits the certified window. A verified 90-minute attraction could sit
 * above a café that actually fits.
 *
 * ── THE TRAP IN CLOSING L184, WHICH IS WHY THE ORDER TEST CHECKS A DEADLINE ──
 * `rankActivities` used to derive its OWN `computeReturnDeadline`. Calling it
 * from a service that has already certified one would have put two deadline
 * derivations in a single request — at different instants, and with the second
 * one blind to this request's `LiveConditions` — which is exactly the duplicate
 * buffer `9c26efba` removed. The certified deadline is therefore threaded in,
 * and `every card carries the certified hard return` below is the assertion
 * that keeps it threaded.
 *
 * ── MUTATIONS RUN, each against PRODUCTION code, reverted and `cmp`-verified ─
 * 9 pass / 0 fail unmutated.
 *   1. the gate quantity back to `session.layoverMinutes` ..... 4 failed
 *   2. the gate threshold to `>= 0` (open it wide) ............ 1 failed
 *   3. `rankActivities`' rating key neutralised (`rDiff = 0`) . 1 failed
 *   4. `rankActivities` ignoring the deadline it is handed .... 1 failed
 *
 * TWO OF THESE ARE WORTH READING BECAUSE THEY FAILED TO GO RED FIRST.
 *
 * Mutation 3 initially failed NOTHING — not here and not in
 * `src/test/airport.test.ts`, whose case is titled "rankActivities sorts safe
 * first then shorter travel time" and asserts only that the travel-0 card
 * leads. In every candidate set either file had, rating order and travel-time
 * order agreed, so the comparator's primary key was unpinned from the day it
 * was written. The case "the RATING key decides even when the travel-time key
 * disagrees with it" is what makes it 1 failed instead of 0.
 *
 * Mutation 4 STILL fails nothing at the service level, and that is recorded in
 * the case that pins it rather than hidden. See the comment there.
 *
 * Run: node --import tsx/esm --test src/test/layoverRecommendationGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import {
  computeReturnDeadline,
  rankActivities,
  type LiveConditions,
} from "../services/airport/LayoverSafetyEngine.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

/** Fixed instant so the airport-local hour — and therefore the time-of-day
 *  term and the nightlife filter — is the same on every machine and hour. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z"); // 10:00 in Asia/Taipei

function session(over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + 9 * 3_600_000).toISOString(),
    boardingTime: null,
    // DELIBERATELY A LIE in most cases below. Nothing may read it.
    layoverMinutes: 540,
    flightType: "international", immigrationRequired: false, checkedBags: false,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** A verified long attraction and an unverified short café — in that input
 *  order, because `verified` places lead the pre-existing preference sort. */
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

function cards(r: { ok: true; recommendations: any[] } | { ok: false; message: string }): any[] {
  if (!r.ok) assert.fail(`expected recommendations, got a refusal: ${r.message}`);
  return r.recommendations;
}

const usableOf = (s: LayoverSession) =>
  certifySessionFeasibility(AIRPORT, s, { nowMs: NOW }).envelope.usableMinutes;

const landside = (rs: any[]) => rs.filter((r) => !r.insideAirport);

describe("§9.1 hard gate — usable time, not scheduled time", () => {
  it("refuses a city when the certified window has no usable time, however long the SCHEDULED window claims to be", async () => {
    // 3 hours nose-to-nose, international, immigration AND checked bags: the
    // certified buffer eats the whole window.
    const s = session({
      departureTime: new Date(NOW + 3 * 3_600_000).toISOString(),
      immigrationRequired: true,
      checkedBags: true,
      layoverMinutes: 600, // the stale/scheduled figure the old gate believed
    });
    assert.ok(usableOf(s) < 90, `fixture drifted: usable=${usableOf(s)} should be under the 90-minute gate`);

    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));
    assert.equal(landside(got).length, 0,
      `a session with ${usableOf(s)} usable minutes was offered ${landside(got).length} landside card(s)`);
    // Inside-airport suggestions are not gated and must still be there: the
    // requirement is a gate on leaving, not a blank screen.
    assert.ok(got.length > 0, "inside-airport cards must survive the gate");
    assert.ok(got.every((r) => r.insideAirport));
  });

  it("offers a city when the certified window HAS the time, even though the scheduled figure says it does not", async () => {
    const s = session({ layoverMinutes: 30 }); // understated; the old gate refused on it
    assert.ok(usableOf(s) >= 180, `fixture drifted: usable=${usableOf(s)}`);

    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));
    assert.ok(landside(got).length >= 2, `expected landside cards, got ${landside(got).length}`);
    assert.ok(got.some((r) => r.recType === "quick_city_escape"),
      "a >=180-usable-minute window must reach the city-escape gate too");
  });

  it("the stored scheduled figure changes NOTHING — the gate does not read it", async () => {
    // Same real times, same clock; only the denormalised column differs. If any
    // gate still reads it, these two answers cannot be equal.
    const a = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session({ layoverMinutes: 1 }), NOW));
    const b = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, session({ layoverMinutes: 9999 }), NOW));
    assert.deepEqual(a.map((r) => r.title), b.map((r) => r.title));
    assert.deepEqual(a.map((r) => r.safetyRating), b.map((r) => r.safetyRating));
  });

  it("the city-escape wording is a claim about usable time, not about the scheduled span", async () => {
    // Under four usable hours: "quick", never "half-day", whatever the column says.
    const s = session({
      departureTime: new Date(NOW + 6 * 3_600_000).toISOString(),
      layoverMinutes: 1440,
    });
    const u = usableOf(s);
    assert.ok(u >= 180 && u < 240, `fixture drifted: usable=${u} must sit between the two escape thresholds`);

    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));
    const escape = got.find((r) => r.recType === "quick_city_escape");
    assert.ok(escape, "expected the city-escape card in a 180-239 usable-minute window");
    assert.match(escape.description, /quick layover/);
    assert.doesNotMatch(escape.description, /half-day/);
  });
});

describe("§9.1 ordering — safety is the primary key, preference is the tiebreak", () => {
  /** The order `rankActivities` imposes. Anything else is a preference sort. */
  const RANK = ["safe", "possible_but_risky", "not_recommended", "airport_only"];

  it("no card outranks a safer card", async () => {
    const s = session({
      // Long enough to leave (105 usable minutes, past the 90-minute gate),
      // short enough that the 90-minute attraction does not fit while the
      // 30-minute cafe does.
      departureTime: new Date(NOW + 4.5 * 3_600_000).toISOString(),
    });
    assert.ok(usableOf(s) >= 90 && usableOf(s) < 180, `fixture drifted: usable=${usableOf(s)}`);
    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));

    const ranks = got.map((r) => RANK.indexOf(r.safetyRating));
    assert.ok(ranks.every((n) => n >= 0), `unknown rating in ${JSON.stringify(got.map((r) => r.safetyRating))}`);
    for (let i = 1; i < ranks.length; i++) {
      assert.ok(ranks[i]! >= ranks[i - 1]!,
        `card ${i} ("${got[i].title}", ${got[i].safetyRating}) outranks "${got[i - 1].title}" (${got[i - 1].safetyRating})`);
    }

    // The discriminating pair: the VERIFIED attraction leads the preference
    // sort and does not fit; the unverified cafe does. Safety must win.
    const market = got.findIndex((r) => r.title === "Night Market");
    const cafe = got.findIndex((r) => r.title === "Riverside Cafe");
    assert.ok(market >= 0 && cafe >= 0, "both landside fixtures should be present");
    assert.equal(got[market].safetyRating, "not_recommended");
    assert.equal(got[cafe].safetyRating, "safe");
    assert.ok(cafe < market,
      "the card that fits must come before the verified card that does not — this is the whole of L184");
  });

  it("every card carries the ONE certified hard return, so ranking derived no second deadline", async () => {
    const s = session({ immigrationRequired: true, checkedBags: true });
    const certified = certifySessionFeasibility(AIRPORT, s, { nowMs: NOW });
    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));

    assert.ok(got.length > 0);
    for (const r of got) {
      assert.equal(
        new Date(r.hardReturnTime).getTime(),
        certified.deadline.hardReturnTime.getTime(),
        `"${r.title}" was rated against a different deadline than the certified one`,
      );
      assert.equal(r.returnBufferMin, certified.deadline.breakdown.totalBuffer);
    }
  });

  it("the RATING key decides even when the travel-time key disagrees with it", () => {
    // ── WHY THIS CASE EXISTS, MEASURED ───────────────────────────────────────
    // Neutralising `rankActivities`' rating key (`const rDiff = 0`) left this
    // file at 8/8 AND `src/test/airport.test.ts` at 57/57 — including its case
    // titled "rankActivities sorts safe first then shorter travel time", whose
    // only assertion is that the travel-0 inside-airport card leads, which the
    // travel-time key alone produces. The comparator's PRIMARY key was
    // unpinned from the day it was written.
    //
    // It cannot be pinned through `generateRecommendations` either: the
    // category constants make `2·travel + activity` monotone in travel time
    // across every place type the service can produce, so rating order and
    // travel order never disagree there. So the pin is here, on the function,
    // with candidates the service cannot currently build.
    const s = session();
    const candidates = [
      // Short trip, impossible activity: nothing fits, so `not_recommended`.
      { title: "Short but impossible", travelTimeMin: 10, activityTimeMin: 600, insideAirport: false, verified: true },
      // Long trip that still fits inside the certified window: `safe`.
      { title: "Long but fits", travelTimeMin: 120, activityTimeMin: 60, insideAirport: false, verified: true },
    ];
    const ranked = rankActivities(AIRPORT, s, candidates, NOW);

    assert.equal(ranked[0]!.assessment.rating, "safe");
    assert.equal(ranked[1]!.assessment.rating, "not_recommended");
    assert.equal(ranked[0]!.title, "Long but fits",
      "the safe card must lead even though it is the FURTHER one — this is the rating key, and nothing else can produce it");
  });

  it("rankActivities rates against the deadline it is HANDED, not one it re-derives", () => {
    // ── READ THIS BEFORE TRUSTING THE TEST ABOVE ─────────────────────────────
    // "every card carries the ONE certified hard return" does NOT catch a
    // `rankActivities` call that omits the certified deadline. Measured, not
    // assumed: dropping `certified.deadline` from the service's call left 7/7
    // green. `computeReturnDeadline` is pure in (airport, session, live) and
    // does not read the clock, so a second derivation with no live conditions
    // returns the identical instant.
    //
    // The parameter is therefore load-bearing ONLY when live conditions exist
    // — which is the day L81's producer lands and not before. This case is the
    // pin for that day, written at the engine where the difference is
    // reachable, and it is the honest form of the claim: the service's call is
    // correct by construction and unpinned by the service's own suite.
    const s = session();
    const live: LiveConditions = {
      securityWaitExtraMin: 45, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0,
      reasonCodes: [], observedAt: null, expiresAt: null,
    };
    const certified = computeReturnDeadline(AIRPORT, s, live);
    const candidate = { title: "Riverside Cafe", travelTimeMin: 15, activityTimeMin: 30, insideAirport: false, verified: false };

    const handed = rankActivities(AIRPORT, s, [candidate], NOW, certified);
    const rederived = rankActivities(AIRPORT, s, [candidate], NOW);

    assert.equal(handed[0]!.assessment.hardReturnTime.getTime(), certified.hardReturnTime.getTime());
    assert.notEqual(
      rederived[0]!.assessment.hardReturnTime.getTime(),
      certified.hardReturnTime.getTime(),
      "positive control: without the parameter the function derives its own, live-blind deadline",
    );
    assert.equal(
      certified.hardReturnTime.getTime(),
      rederived[0]!.assessment.hardReturnTime.getTime() - 45 * 60_000,
      "the whole 45-minute live wait must be the difference",
    );
  });

  it("within one rating the pre-existing preference order survives", async () => {
    // A wide window: both landside fixtures are `safe`, so the rating cannot
    // separate them and `rankActivities`' own travel-time key decides — 15 min
    // before 25 min. A ranker that discarded the incoming list would still have
    // to produce this, which is the point: nothing below the safety key is lost.
    const s = session();
    const got = cards(await generateRecommendations(makeLayoverDb(tables()), AIRPORT, s, NOW));
    const cafe = got.findIndex((r) => r.title === "Riverside Cafe");
    const market = got.findIndex((r) => r.title === "Night Market");
    assert.equal(got[cafe].safetyRating, "safe");
    assert.equal(got[market].safetyRating, "safe");
    assert.ok(cafe < market, "shorter travel leads inside one rating");
  });
});
