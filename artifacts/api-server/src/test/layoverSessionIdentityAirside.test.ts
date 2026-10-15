/**
 * census-layover §80 — the two follow-ups the verifier of #728 recorded (V-728 R1, R2).
 *
 * R1 — SESSION IDENTITY. `assess` / `rankActivities` read a certified record only when it is THIS
 * instant's (`inputs.nowMs === nowMs`, §75), but the engine carried no session identity: a readable
 * record for ANOTHER session at the same instant was accepted, and every card was rated against that
 * session's usable time. `CertifiedTimeBudget.inputs` now carries the record's session id (the field
 * every `LayoverFeasibilityRecord` already has: `inputs.session.id`), `assess` takes a session that
 * names its own `id`, and a mismatch — or a missing id on either side — certifies nothing.
 *
 * R2 — THE AIRSIDE MARGIN WHEN THE BOARDING TIME IS UNKNOWN. With no `boardingTime` the cutoff is the
 * DEPARTURE (`layoverCutoffMs`), and the only charge for spec §6's boarding / gate-transfer / deplane
 * terms airside is a flat +15, so a 45-minute dining card on a 60-minute connection was `safe` with the
 * traveller due at the gate fifteen minutes before departure. No airport row, no written constraint
 * column and no client field supplies a boarding-close figure, so none is invented: an airside card
 * whose session states no boarding time is `possible_but_risky`, with a sentence naming the unknown,
 * and never `safe`. Every number on the card is unchanged.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/layoverSessionIdentityAirside.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { generateRecommendations } from "../services/airport/LayoverRecommendationService.js";
import { certifySessionFeasibility, type LandsideProbe, type LayoverFeasibilityRecord } from "../services/airport/LayoverFeasibility.js";
import * as Engine from "../services/airport/LayoverSafetyEngine.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";

const AIRPORT: AirportProfile = {
  id: "airport-tpe", iataCode: "TPE", name: "Taoyuan Intl", city: "Taoyuan",
  country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23,
  domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180,
  immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: false,
};

/** 10:00 in Asia/Taipei — a fixed instant, so the time-of-day terms are the same on every machine. */
const NOW = Date.parse("2026-09-13T02:00:00.000Z");
const MIN = 60_000;

const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "US", destinationCountry: "TW" }, status: "visa_free",
} as EntryEligibility;

/** A session that lands `arriveInMin` from NOW and leaves `layoverMin` after landing. */
function session(id: string, arriveInMin: number, layoverMin: number, over: Partial<LayoverSession> = {}): LayoverSession {
  const arrival = NOW + arriveInMin * MIN;
  return {
    id, userId: `user-of-${id}`, airportId: "airport-tpe", tripId: null,
    arrivalTime: new Date(arrival).toISOString(),
    departureTime: new Date(arrival + layoverMin * MIN).toISOString(),
    boardingTime: null, layoverMinutes: layoverMin,
    flightType: "international", immigrationRequired: true, checkedBags: true,
    loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"],
    manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null,
    canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** The instant `minBeforeDeparture` before the session's departure, as an ISO boarding time. */
const boardingBefore = (s: LayoverSession, minBeforeDeparture: number) =>
  new Date(Date.parse(s.departureTime) - minBeforeDeparture * MIN).toISOString();

const certify = (s: LayoverSession, nowMs = NOW, probe: LandsideProbe | null = null): LayoverFeasibilityRecord =>
  certifySessionFeasibility(AIRPORT, s, { nowMs, entry: PERMITTED, landsideProbe: probe });

const certifies = (r: Engine.SafetyRating) => r === "safe" || r === "possible_but_risky";

/** A record identical to `rec` in every figure, certified (it says) for session `id`. */
const relabelled = (rec: LayoverFeasibilityRecord, id: unknown) =>
  ({ ...rec, inputs: { ...rec.inputs, session: { ...rec.inputs.session, id } } }) as unknown as LayoverFeasibilityRecord;

const fits = { title: "out 15+60", travelTimeMin: 15, activityTimeMin: 60, insideAirport: false, verified: true };
const lounge = { title: "lounge", travelTimeMin: 0, activityTimeMin: 30, insideAirport: true };
const dining = { title: "dining", travelTimeMin: 0, activityTimeMin: 45, insideAirport: true };
const pod = { title: "pod", travelTimeMin: 0, activityTimeMin: 60, insideAirport: true };

// ═══════════════════════════════════════════════════════════════════════════
// R1 — a record is read only for the session it certified
// ═══════════════════════════════════════════════════════════════════════════

describe("R1 — a record certified for ANOTHER session certifies nothing", () => {
  // Session A landed two hours ago with seven hours left; session B is a 20-hour connection, same instant.
  // Both state a boarding time so R2's boarding term is not what any case below turns on.
  const a0 = session("session-A", -120, 540);
  const A = { ...a0, boardingTime: boardingBefore(a0, 30) };
  const b0 = session("session-B", -120, 1200);
  const B = { ...b0, boardingTime: boardingBefore(b0, 30) };

  it("PRECONDITION: each session's own record certifies the three cards, and B's certifies far more time", () => {
    const recA = certify(A), recB = certify(B);
    for (const c of [fits, lounge, pod]) {
      assert.equal(Engine.assess(AIRPORT, A, c, NOW, recA).rating, "safe", `${c.title} on A's own record`);
      assert.equal(Engine.assess(AIRPORT, B, c, NOW, recB).rating, "safe", `${c.title} on B's own record`);
    }
    assert.ok(recB.envelope.usableMinutes - recA.envelope.usableMinutes >= 600,
      `fixture: B ${recB.envelope.usableMinutes} vs A ${recA.envelope.usableMinutes}`);
    assert.equal(recA.inputs.nowMs, recB.inputs.nowMs, "the same instant: §75's instant check cannot tell them apart");
  });

  it("B's record rated for session A: nothing certified, landside or airside, and the warning names the cause", () => {
    const recB = certify(B);
    for (const c of [fits, lounge, pod]) {
      const r = Engine.assess(AIRPORT, A, c, NOW, recB);
      assert.equal(r.rating, "not_recommended", `"${c.title}" rated ${r.rating} on another session's record`);
      assert.equal(r.warningReason, Engine.UNCERTIFIED_WINDOW_WARNING);
      assert.equal(r.usableMinutes, 0, "another session's usable minutes leaked onto A's card");
    }
  });

  it("…and through rankActivities, the recommendation service's call", () => {
    for (const r of Engine.rankActivities(AIRPORT, A, [fits, lounge, dining, pod], NOW, certify(B))) {
      assert.ok(!certifies(r.assessment.rating), `"${r.title}" rated ${r.assessment.rating} on B's record`);
      assert.equal(r.assessment.warningReason, Engine.UNCERTIFIED_WINDOW_WARNING);
    }
  });

  it("THE ID IS THE ONLY NEW GATE: relabelling A's own record to another id refuses; relabelling it back is byte-identical", () => {
    const recA = certify(A);
    for (const c of [fits, lounge, dining, pod]) {
      const own = Engine.assess(AIRPORT, A, c, NOW, recA);
      assert.equal(Engine.assess(AIRPORT, A, c, NOW, relabelled(recA, "session-B")).rating, "not_recommended", c.title);
      assert.deepEqual(Engine.assess(AIRPORT, A, c, NOW, relabelled(relabelled(recA, "session-B"), "session-A")), own, c.title);
    }
  });

  it("a MISSING id on either side is a refusal, never a match — two undefineds are not one session", () => {
    const recA = certify(A);
    const noIdSession = { ...A, id: undefined } as unknown as LayoverSession;
    const shapes: Array<[string, LayoverSession, unknown]> = [
      ["session has no id", noIdSession, recA],
      ["record has no session id", A, relabelled(recA, undefined)],
      ["neither has an id", noIdSession, relabelled(recA, undefined)],
      ["record's session is missing", A, { ...recA, inputs: { ...recA.inputs, session: undefined } }],
      ["record's session is null", A, { ...recA, inputs: { ...recA.inputs, session: null } }],
      ["both ids are empty strings", { ...A, id: "" }, relabelled(recA, "")],
      ["record id is a number", A, relabelled(recA, 1)],
      ["record id differs only by case", A, relabelled(recA, "SESSION-A")],
    ];
    for (const [why, s, rec] of shapes) {
      for (const c of [fits, lounge]) {
        const r = Engine.assess(AIRPORT, s, c, NOW, rec as never);
        assert.equal(r.rating, "not_recommended", `${why}: "${c.title}" rated ${r.rating}`);
        assert.equal(r.warningReason, Engine.UNCERTIFIED_WINDOW_WARNING, why);
      }
    }
  });

  it("the record's OWN landside probe is rated against the record being built — its own session — unchanged", () => {
    const rec = certify(A, NOW, { title: "probe", travelTimeMin: 15, activityTimeMin: 60, travelTimeSource: "traveller_stated" });
    assert.ok(rec.landside);
    assert.equal(rec.landside.rating, "safe", `${rec.landside.rating}: ${rec.landside.warningReason}`);
    assert.equal(rec.landside.usableMinutes, rec.envelope.usableMinutes);
  });

  it("a NARROWED COPY of the record (spread, one envelope term changed — LAY-5's time-budget chips) keeps the session id and is read", () => {
    const recA = certify(A);
    const narrowed = { ...recA, envelope: { ...recA.envelope, usableMinutes: 90 } };
    assert.equal(narrowed.inputs.session.id, A.id);
    const r = Engine.assess(AIRPORT, A, { ...fits, activityTimeMin: 30 }, NOW, narrowed);
    assert.equal(r.usableMinutes, 90, "the copy is read, and its narrowed figure is the one rated against");
    assert.ok(certifies(r.rating), `${r.rating}: ${r.warningReason}`);
  });

  it("the production producer still certifies its own session's cards (the service's record is the session's)", async () => {
    const s = { ...session("session-P", -60, 600, { flightType: "domestic", immigrationRequired: false, checkedBags: false }) };
    const withBoarding = { ...s, boardingTime: boardingBefore(s, 30) };
    const r = await generateRecommendations(makeLayoverDb({
      discovery_places: [], layover_recommendations: [], layover_plan_stops: [], layover_events: [],
    }), AIRPORT, withBoarding, NOW);
    if (!r.ok) assert.fail(r.message);
    const airside = r.recommendations.filter((c: any) => c.insideAirport);
    assert.ok(airside.length >= 3, `positive control: ${airside.length} airside cards`);
    for (const c of airside) assert.equal(c.safetyRating, "safe", `"${c.title}": ${c.warningReason}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2 — airside, with no boarding time the span ends at departure: never "safe"
// ═══════════════════════════════════════════════════════════════════════════

describe("R2 — an airside card is not `safe` when the boarding time is unknown", () => {
  // A 60-minute domestic connection, no boarding time — the verifier's case.
  const conn = (arriveInMin: number, over: Partial<LayoverSession> = {}) =>
    session("session-60", arriveInMin, 60, { flightType: "domestic", immigrationRequired: false, checkedBags: false, ...over });

  it("RED ON MAIN: a 45-minute dining card on a 60-minute connection, no boarding time, is not `safe` — at any instant before the last 60 minutes", () => {
    for (const arrive of [180, 30, 0]) {
      const s = conn(arrive);
      const r = Engine.assess(AIRPORT, s, dining, NOW, certify(s));
      assert.notEqual(r.rating, "safe", `arrive ${arrive}: 45-min dining on a 60-min connection with no boarding time rated safe`);
      assert.equal(r.rating, "possible_but_risky", `arrive ${arrive}: ${r.rating}`);
      assert.equal(r.warningReason, Engine.BOARDING_TIME_UNKNOWN_WARNING);
    }
  });

  it("RED ON MAIN, THROUGH THE PRODUCER: generateRecommendations rates its own 45-minute dining card", async () => {
    const r = await generateRecommendations(makeLayoverDb({
      discovery_places: [], layover_recommendations: [], layover_plan_stops: [], layover_events: [],
    }), AIRPORT, conn(0), NOW);
    if (!r.ok) assert.fail(r.message);
    const diningCard = r.recommendations.find((c: any) => c.insideAirport && c.activityTimeMin === 45);
    assert.ok(diningCard, "positive control: the producer's 45-minute dining card");
    assert.equal(diningCard.safetyRating, "possible_but_risky", `${diningCard.safetyRating}: ${diningCard.warningReason}`);
    assert.equal(diningCard.warningReason, Engine.BOARDING_TIME_UNKNOWN_WARNING);
    for (const c of r.recommendations.filter((x: any) => x.insideAirport)) {
      assert.notEqual(c.safetyRating, "safe", `"${c.title}" rated safe with no boarding time`);
    }
  });

  it("NO MINUTE IS INVENTED: stating boarding = departure leaves every number identical and changes only the rating", () => {
    const unknown = conn(0);
    const stated = { ...unknown, boardingTime: unknown.departureTime };
    const recU = certify(unknown), recS = certify(stated);
    assert.equal(recU.deadline.cutoffMs, recS.deadline.cutoffMs, "the same cutoff");
    assert.deepEqual(recU.envelope, recS.envelope, "the same certified envelope");
    for (const c of [lounge, dining]) {
      const u = Engine.assess(AIRPORT, unknown, c, NOW, recU);
      const s = Engine.assess(AIRPORT, stated, c, NOW, recS);
      assert.equal(s.rating, "safe", `${c.title}: a stated boarding time the span holds is still safe`);
      assert.equal(u.rating, "possible_but_risky", c.title);
      const { rating: _ru, warningReason: _wu, ...numbersU } = u;
      const { rating: _rs, warningReason: _ws, ...numbersS } = s;
      assert.deepEqual(numbersU, numbersS, `${c.title}: a number moved — R2 may change the rating, never a minute`);
    }
  });

  it("a stated boarding time the span holds is still `safe`; one it does not hold is still the stated arithmetic reason", () => {
    const s0 = session("session-120", 0, 120, { flightType: "domestic", immigrationRequired: false, checkedBags: false });
    const holds = { ...s0, boardingTime: boardingBefore(s0, 30) };    // span 90: 45 + 15 fits
    assert.equal(Engine.assess(AIRPORT, holds, dining, NOW, certify(holds)).rating, "safe");
    const tight = { ...s0, boardingTime: boardingBefore(s0, 70) };    // span 50: 45 + 15 does not
    const t = Engine.assess(AIRPORT, tight, dining, NOW, certify(tight));
    assert.equal(t.rating, "possible_but_risky");
    assert.equal(t.warningReason, "Your layover is very short — plan for a quick visit.");
  });

  it("FAIL-CLOSED DEFAULT (owner question Q-R2-1): even a 30-minute lounge on a 10-hour layover is not `safe` without a boarding time", () => {
    const s = session("session-long", -60, 600, { flightType: "domestic", immigrationRequired: false, checkedBags: false });
    const r = Engine.assess(AIRPORT, s, lounge, NOW, certify(s));
    assert.equal(r.rating, "possible_but_risky");
    assert.equal(r.warningReason, Engine.BOARDING_TIME_UNKNOWN_WARNING);
  });

  it("a boarding time that is not the record's cutoff is not 'stated' (fail closed), and an unparseable one never matches", () => {
    const s = conn(0);
    const rec = certify(s); // certified with NO boarding time: cutoff = departure
    const later = { ...s, boardingTime: boardingBefore(s, 10) }; // the same session id, now stating a boarding time
    const r = Engine.assess(AIRPORT, later, lounge, NOW, rec);
    assert.equal(r.rating, "possible_but_risky", "a boarding time the record never certified was trusted");
    assert.equal(r.warningReason, Engine.BOARDING_TIME_UNKNOWN_WARNING);
    assert.equal(Engine.cutoffIsStatedBoarding({ boardingTime: "not a date" }, Number.NaN), false);
    assert.equal(Engine.cutoffIsStatedBoarding({ boardingTime: "" }, rec.deadline.cutoffMs), false);
    assert.equal(Engine.cutoffIsStatedBoarding({ boardingTime: null }, rec.deadline.cutoffMs), false);
    assert.equal(Engine.cutoffIsStatedBoarding({}, rec.deadline.cutoffMs), false);
    assert.equal(Engine.cutoffIsStatedBoarding({ boardingTime: s.departureTime }, rec.deadline.cutoffMs), true);
  });

  it("the earlier, STATED reasons keep precedence: an unstated dwell and a too-short span say so, not 'boarding unknown'", () => {
    const late = conn(-50); // 10 minutes left
    const r = Engine.assess(AIRPORT, late, lounge, NOW, certify(late));
    assert.equal(r.warningReason, "Your layover is very short — plan for a quick visit.");
    const unstated = Engine.assess(AIRPORT, conn(0), { ...lounge, activityTimeMin: null }, NOW, certify(conn(0)));
    assert.equal(unstated.rating, "not_recommended");
    assert.equal(unstated.warningReason, Engine.UNSTATED_ACTIVITY_WARNING);
  });

  it("landside cards are untouched by R2: their ladder already charges the airport's buffer", () => {
    const s = session("session-land", -120, 540);
    const r = Engine.assess(AIRPORT, s, fits, NOW, certify(s));
    assert.equal(r.rating, "safe", `${r.rating}: ${r.warningReason}`);
  });

  it("SWEEP: with no boarding time no airside card is `safe`; with one, `safe` iff the span holds dwell + 15 — the rule it always was", () => {
    let unknownRated = 0, statedSafe = 0, statedRisky = 0;
    for (const arrive of [-240, -50, -20, 0, 30, 180]) for (const layover of [45, 60, 90, 180, 600]) for (const dwell of [20, 30, 45, 60]) {
      const s = session(`sweep-${arrive}-${layover}`, arrive, layover, { flightType: "domestic", immigrationRequired: false, checkedBags: false });
      const card = { title: `d${dwell}`, travelTimeMin: 0, activityTimeMin: dwell, insideAirport: true };
      const u = Engine.assess(AIRPORT, s, card, NOW, certify(s));
      if (u.rating !== "not_recommended") {
        unknownRated++;
        assert.notEqual(u.rating, "safe", `arrive ${arrive}, ${layover} min, dwell ${dwell}: safe with no boarding time`);
      }
      for (const before of [0, 20]) {
        const b = { ...s, boardingTime: boardingBefore(s, before) };
        const rec = certify(b);
        const r = Engine.assess(AIRPORT, b, card, NOW, rec);
        const span = Math.min(Math.max(0, Math.round((rec.deadline.cutoffMs - NOW) / MIN)), rec.envelope.totalMinutes);
        assert.equal(r.rating, span < dwell + 15 ? "possible_but_risky" : "safe", `arrive ${arrive}, ${layover} min, boarding −${before}, dwell ${dwell}`);
        if (r.rating === "safe") statedSafe++; else statedRisky++;
      }
    }
    assert.ok(unknownRated > 50 && statedSafe > 20 && statedRisky > 20, `positive control: ${unknownRated}/${statedSafe}/${statedRisky}`);
  });
});
