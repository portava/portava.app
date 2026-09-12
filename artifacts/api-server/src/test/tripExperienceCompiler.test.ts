/**
 * Trips spec §13.1 / §13.2 / §13.3 — the experience compiler and the
 * opportunity engine, pure. §22.4 "closed-before-arrival activity cannot
 * remain executable" as a property over generated inputs.
 * census-trips TR224–TR253, TR413.
 *
 * Run: node --import tsx/esm --test src/test/tripExperienceCompiler.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compileExperiences, primitiveFor, candidateProperties,
  ACTIVITY_PRIMITIVES, PRIMITIVE_DEFAULTS, EXPERIENCE_REASON_CODES, OPEN_AIR_PRIMITIVES,
  type CompileInputs, type ExperienceCandidate, type TravelEstimator,
} from "../services/trips/TripExperienceCompiler.js";
import {
  diffOpportunities, shouldNotify, attentionKindFor, OPPORTUNITY_SIGNIFICANCES,
  type OpportunityPortfolio,
} from "../services/trips/TripOpportunityEngine.js";
import type { FreedomWindow } from "../services/trips/TripFreedomEngine.js";
import type { PulseInterpretation } from "../services/trips/TripSignals.js";

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const HOTEL = { lat: 48.8566, lng: 2.3522 };
const NEAR = { lat: 48.8600, lng: 2.3600 };   // ~0.7 km
const FAR = { lat: 48.9000, lng: 2.4500 };    // ~8.6 km

/** Straight-line walking at 1.25 m/s; beyond 2 km a taxi at 8.33 m/s + 3 min. Deterministic. */
const travel: TravelEstimator = {
  minutes(a, b) {
    const R = 6_371_000; const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(s));
    return d <= 2000 ? { minutes: Math.ceil(d / 1.25 / 60), mode: "walk" } : { minutes: Math.ceil(d / 8.33 / 60) + 3, mode: "drive" };
  },
};
const noTravel: TravelEstimator = { minutes: () => null };

function window(o: Partial<FreedomWindow> = {}): FreedomWindow {
  return {
    id: "fw:A:B", position: "between", beginsAt: T("12:00"), endsAt: T("16:00"), durationMinutes: 240,
    origin: { placeId: "hotel", lat: HOTEL.lat, lng: HOTEL.lng } as any,
    requiredDestination: { placeId: "dinner", lat: HOTEL.lat, lng: HOTEL.lng, commitmentId: "B", arriveBy: T("16:00") } as any,
    participants: ["me", "ana"], hardConstraints: [], confidence: "HIGH" as any, certified: true, reservedMinutes: 15,
    afterCommitmentId: "A", beforeCommitmentId: "B", ...o,
  };
}
const cand = (id: string, o: Partial<ExperienceCandidate> = {}): ExperienceCandidate => ({ id, placeId: `p-${id}`, name: id, placeType: "museum", point: NEAR, source: "saved_idea", ...o });
function inputs(o: Partial<CompileInputs> = {}): CompileInputs {
  return { now: NOW, window: window(), origin: HOTEL, participants: [{ userId: "me" }, { userId: "ana" }], candidates: [], liveSignals: [], travel, goals: [], preferences: {}, nextCommitment: { id: "B", arriveBy: T("16:00"), point: HOTEL }, prepMinutes: 15, ...o };
}
const signal = (kind: PulseInterpretation["kind"], effects: PulseInterpretation["effects"]): PulseInterpretation => ({
  kind, subjectId: "x", interpretation: "", effects, relevance: ["stage"],
  estimate: { value: {} as any, confidence: 0.8, sourceClass: "firsthand_unverified", observedAt: T("11:50"), expiresAt: T("13:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 } },
});

describe("§13.2 activity primitives and per-candidate properties", () => {
  it("the thirteen primitives, each with the ten properties §13.2 names, with defaults", () => {
    assert.deepEqual([...ACTIVITY_PRIMITIVES], ["EAT", "SEE", "MEET", "DRINK", "SHOP", "WALK", "REST", "PHOTO", "EXPLORE", "PLAY", "LEARN", "NIGHTLIFE", "TRANSIT"]);
    for (const p of ACTIVITY_PRIMITIVES) {
      const d = PRIMITIVE_DEFAULTS[p];
      for (const k of ["minimumMinutes", "idealMinutes", "compressibility", "interruptibility", "reversibility", "costBand", "energyCost", "reservationRequired", "queueDistribution", "accessibilityConstraints", "failureRecoveryRoutes"]) assert.ok(k in d, `${p}.${k}`);
      assert.ok(d.minimumMinutes <= d.idealMinutes, p);
    }
    assert.equal(primitiveFor("night_club"), "NIGHTLIFE"); assert.equal(primitiveFor("restaurant"), "EAT"); assert.equal(primitiveFor("museum"), "SEE");
    assert.equal(primitiveFor("park"), "WALK"); assert.equal(primitiveFor("subway_station"), "TRANSIT"); assert.equal(primitiveFor(null, "Le Bar"), "DRINK"); assert.equal(primitiveFor("zzz"), "EXPLORE");
    const c = candidateProperties(cand("x", { placeType: "restaurant", properties: { minimumMinutes: 30, accessibilityConstraints: ["stairs_only"] } }));
    assert.equal(c.minimumMinutes, 30); assert.equal(c.idealMinutes, 90); assert.deepEqual(c.accessibilityConstraints, ["stairs_only"]);
  });
});

describe("§13.1 compileExperiences — the eight inputs, one verdict each", () => {
  it("a nearby open museum in a four-hour window is EXECUTABLE with arrival, stay, leave-by and travel both ways", () => {
    const r = compileExperiences(inputs({ candidates: [cand("louvre", { openingWindows: [{ opensAt: T("09:00"), closesAt: T("18:00") }] })] }));
    assert.equal(r.counts.EXECUTABLE, 1);
    const e = r.experiences[0];
    assert.equal(e.id, "fw:A:B:louvre"); assert.equal(e.primitive, "SEE"); assert.equal(e.verdict, "EXECUTABLE");
    assert.equal(e.travel.mode, "walk"); assert.ok(e.travel.toMinutes! > 0 && e.travel.backMinutes! > 0);
    assert.equal(e.stayMinutes, 75, "the ideal fits");
    assert.ok(Date.parse(e.arriveAt!) > NOW && Date.parse(e.leaveBy!) < Date.parse(T("16:00")));
    assert.deepEqual(e.participants, ["me", "ana"]); assert.ok(e.score > 0);
    assert.ok(!e.reasonCodes.includes("EXPERIENCE_COMPRESSED"));
  });
  it("§22.4: closed before arrival is NOT_EXECUTABLE, never promoted; closing during the minimum stay too; unknown hours are UNCERTAIN unless open-air", () => {
    const closed = compileExperiences(inputs({ candidates: [cand("late", { openingWindows: [{ opensAt: T("17:00"), closesAt: T("23:00") }] })] })).experiences[0];
    assert.equal(closed.verdict, "NOT_EXECUTABLE"); assert.ok(closed.reasonCodes.includes("EXPERIENCE_CLOSED_BEFORE_ARRIVAL")); assert.equal(closed.score, 0); assert.equal(closed.arriveAt, null);
    const closing = compileExperiences(inputs({ candidates: [cand("brief", { openingWindows: [{ opensAt: T("09:00"), closesAt: T("12:20") }] })] })).experiences[0];
    assert.equal(closing.verdict, "NOT_EXECUTABLE"); assert.ok(closing.reasonCodes.includes("EXPERIENCE_CLOSES_DURING_STAY"));
    const unknown = compileExperiences(inputs({ candidates: [cand("mystery")] })).experiences[0];
    assert.equal(unknown.verdict, "UNCERTAIN"); assert.ok(unknown.reasonCodes.includes("EXPERIENCE_HOURS_UNKNOWN"));
    const park = compileExperiences(inputs({ candidates: [cand("park", { placeType: "park" })] })).experiences[0];
    assert.equal(park.verdict, "EXECUTABLE", "open-air primitives do not need hours");
  });
  it("no time after travel both ways is TRIP_TEMPORAL_INFEASIBLE; a queue longer than the window is EXPERIENCE_QUEUE_EXCEEDS_WINDOW; unknown travel is UNCERTAIN", () => {
    const short = compileExperiences(inputs({ window: window({ endsAt: T("12:40"), durationMinutes: 40 }), candidates: [cand("louvre", { openingWindows: [{ opensAt: T("09:00"), closesAt: T("18:00") }] })] })).experiences[0];
    assert.equal(short.verdict, "NOT_EXECUTABLE"); assert.ok(short.reasonCodes.includes("TRIP_TEMPORAL_INFEASIBLE"));
    const queue = compileExperiences(inputs({ window: window({ endsAt: T("13:30"), durationMinutes: 90 }), candidates: [cand("tower", { openingWindows: [{ opensAt: T("09:00"), closesAt: T("23:00") }], liveConditions: { queueWaitMinutes: 60 } })] })).experiences[0];
    assert.equal(queue.verdict, "NOT_EXECUTABLE"); assert.ok(queue.reasonCodes.includes("EXPERIENCE_QUEUE_EXCEEDS_WINDOW"));
    const unknown = compileExperiences(inputs({ travel: noTravel, candidates: [cand("louvre", { openingWindows: [{ opensAt: T("09:00"), closesAt: T("18:00") }] })] })).experiences[0];
    assert.equal(unknown.verdict, "UNCERTAIN"); assert.ok(unknown.reasonCodes.includes("TRIP_TEMPORAL_UNKNOWN")); assert.equal(unknown.score, 0);
    const nowhere = compileExperiences(inputs({ candidates: [cand("ghost", { point: null, placeType: "park" })] })).experiences[0];
    assert.equal(nowhere.verdict, "UNCERTAIN"); assert.ok(nowhere.reasonCodes.includes("TRIP_SPATIAL_NO_COORDINATES"));
  });
  it("live conditions: a live closure, unsafe density, a pulse invalidation and a 'better now' each land as a reason; a reservation requirement blocks", () => {
    const hours = [{ opensAt: T("09:00"), closesAt: T("23:00") }];
    const closed = compileExperiences(inputs({ candidates: [cand("c", { openingWindows: hours, liveConditions: { closure: "temporarily_closed" } })] })).experiences[0];
    assert.ok(closed.reasonCodes.includes("EXPERIENCE_CLOSED_LIVE")); assert.equal(closed.verdict, "NOT_EXECUTABLE");
    const packed = compileExperiences(inputs({ candidates: [cand("c", { openingWindows: hours, liveConditions: { crowdLevel: "unsafe_density" } })] })).experiences[0];
    assert.ok(packed.reasonCodes.includes("EXPERIENCE_UNSAFE_DENSITY"));
    const rain = compileExperiences(inputs({ liveSignals: [signal("rain_arriving", [{ kind: "plan_invalidated", subjectIds: ["walk"], detail: "" }])], candidates: [cand("walk", { placeType: "park" }), cand("bar", { placeType: "bar", openingWindows: hours })] }));
    const w = rain.experiences.find((e) => e.candidateId === "walk")!; const b = rain.experiences.find((e) => e.candidateId === "bar")!;
    assert.equal(w.verdict, "NOT_EXECUTABLE"); assert.ok(w.reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED")); assert.equal(b.verdict, "EXECUTABLE");
    const better = compileExperiences(inputs({ liveSignals: [signal("crowd_rising", [{ kind: "saved_idea_better_now", subjectIds: ["bar"], detail: "" }])], candidates: [cand("bar", { placeType: "bar", openingWindows: hours }), cand("bar2", { placeType: "bar", openingWindows: hours })] }));
    assert.equal(better.experiences[0].candidateId, "bar", "the favoured one scores higher"); assert.ok(better.experiences[0].reasonCodes.includes("EXPERIENCE_BETTER_NOW"));
    const resv = compileExperiences(inputs({ candidates: [cand("class", { placeType: "cooking class", openingWindows: hours })] })).experiences[0];
    assert.equal(resv.primitive, "LEARN"); assert.ok(resv.reasonCodes.includes("EXPERIENCE_RESERVATION_REQUIRED")); assert.equal(resv.verdict, "NOT_EXECUTABLE");
  });
  it("participants and goals: an accessibility need unmet blocks; an open goal served raises the score and is named; a closed goal is not", () => {
    const hours = [{ opensAt: T("09:00"), closesAt: T("23:00") }];
    const club = compileExperiences(inputs({ participants: [{ userId: "me" }, { userId: "kid", accessibilityNeeds: ["adults_only"] }], candidates: [cand("club", { placeType: "night_club", openingWindows: hours })] })).experiences[0];
    assert.equal(club.verdict, "NOT_EXECUTABLE"); assert.ok(club.reasonCodes.includes("EXPERIENCE_ACCESSIBILITY_UNMET"));
    const r = compileExperiences(inputs({ goals: [{ id: "g1", type: "culture", scope: "shared", status: "open" }, { id: "g2", type: "food", scope: "shared", status: "satisfied" }], candidates: [cand("museum", { openingWindows: hours }), cand("cafe", { placeType: "cafe", openingWindows: hours })] }));
    const m = r.experiences.find((e) => e.candidateId === "museum")!; const c = r.experiences.find((e) => e.candidateId === "cafe")!;
    assert.deepEqual(m.servesGoalIds, ["g1"]); assert.ok(m.reasonCodes.includes("EXPERIENCE_SERVES_GOAL"));
    assert.deepEqual(c.servesGoalIds, []); assert.ok(c.reasonCodes.includes("EXPERIENCE_NO_OPEN_GOAL"));
    assert.equal(r.experiences[0].candidateId, "museum");
  });
  it("compression: a candidate that fits only below its ideal is EXECUTABLE and says EXPERIENCE_COMPRESSED; travel far away is penalised; deterministic order", () => {
    const hours = [{ opensAt: T("09:00"), closesAt: T("23:00") }];
    // 75 minutes: near is ~10 min of walking each way (40 min left, compressed);
    // far is ~21 min of driving each way (18 min left, under the 30 min minimum).
    const r = compileExperiences(inputs({ window: window({ endsAt: T("13:15"), durationMinutes: 75 }), candidates: [cand("near", { openingWindows: hours }), cand("far", { point: FAR, openingWindows: hours })] }));
    const near = r.experiences.find((e) => e.candidateId === "near")!;
    assert.equal(near.verdict, "EXECUTABLE"); assert.ok(near.reasonCodes.includes("EXPERIENCE_COMPRESSED")); assert.ok(near.stayMinutes! < 75 && near.stayMinutes! >= 30);
    const far = r.experiences.find((e) => e.candidateId === "far")!;
    assert.equal(far.verdict, "NOT_EXECUTABLE", "8.7 km each way leaves 18 min in 75");
    assert.ok(far.reasonCodes.includes("TRIP_TEMPORAL_INFEASIBLE"));
    const again = compileExperiences(inputs({ window: window({ endsAt: T("13:15"), durationMinutes: 75 }), candidates: [cand("far", { point: FAR, openingWindows: hours }), cand("near", { openingWindows: hours })] }));
    assert.deepEqual(again.experiences.map((e) => e.id), r.experiences.map((e) => e.id), "input order does not change the output order");
  });
  it("§22.4 property: over generated candidates and windows, no EXECUTABLE experience arrives outside an opening window, and none arrives before the window begins", () => {
    let seed = 7; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    let executable = 0;
    for (let i = 0; i < 300; i++) {
      const open = 8 + Math.floor(rnd() * 8), close = open + 1 + Math.floor(rnd() * 10);
      const wStart = 9 + Math.floor(rnd() * 8), wLen = 1 + Math.floor(rnd() * 5);
      const pad = (n: number) => String(Math.min(n, 23)).padStart(2, "0") + ":00";
      const c = cand(`c${i}`, { point: rnd() < 0.5 ? NEAR : FAR, openingWindows: [{ opensAt: T(pad(open)), closesAt: T(pad(close)) }], properties: { minimumMinutes: 15 + Math.floor(rnd() * 60) } });
      const w = window({ beginsAt: T(pad(wStart)), endsAt: T(pad(wStart + wLen)), durationMinutes: wLen * 60 });
      const e = compileExperiences(inputs({ now: Date.parse(w.beginsAt), window: w, candidates: [c] })).experiences[0];
      if (e.verdict !== "EXECUTABLE") continue;
      executable++;
      const arrive = Date.parse(e.arriveAt!);
      assert.ok(arrive >= Date.parse(w.beginsAt), "arrival before the window");
      assert.ok(arrive >= Date.parse(c.openingWindows![0].opensAt) && arrive < Date.parse(c.openingWindows![0].closesAt), `EXECUTABLE with arrival outside hours: ${JSON.stringify(e)}`);
      assert.ok(arrive + e.properties.minimumMinutes * 60_000 <= Date.parse(c.openingWindows![0].closesAt), "closes during the minimum stay");
    }
    assert.ok(executable > 20, `the generator produced ${executable} executable cases; too few to mean anything`);
    assert.ok(EXPERIENCE_REASON_CODES.includes("EXPERIENCE_CLOSED_BEFORE_ARRIVAL"));
    assert.ok(OPEN_AIR_PRIMITIVES.length > 0);
  });
});

describe("§13.3 diffOpportunities — significance is a function of the diff", () => {
  const hours = [{ opensAt: T("09:00"), closesAt: T("23:00") }];
  function portfolio(cands: ExperienceCandidate[], o: Partial<OpportunityPortfolio> = {}, extra: Partial<CompileInputs> = {}): OpportunityPortfolio {
    const r = compileExperiences(inputs({ candidates: cands, ...extra }));
    return {
      tripId: "trip", windowId: "fw:A:B", window: { id: "fw:A:B", beginsAt: T("12:00"), endsAt: T("16:00"), durationMinutes: 240, certified: true, participants: ["me", "ana"] },
      executable: r.experiences.filter((e) => e.verdict === "EXECUTABLE"),
      notExecutable: r.experiences.filter((e) => e.verdict !== "EXECUTABLE").map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, verdict: e.verdict, reasonCodes: e.reasonCodes })),
      computedAt: T("12:00"), sourceTripVersion: 9, ...o,
    };
  }
  it("the contract: every §13.3 field; unchanged → none; five significances in order", () => {
    assert.deepEqual([...OPPORTUNITY_SIGNIFICANCES], ["none", "low", "medium", "high", "critical"]);
    const p = portfolio([cand("museum", { openingWindows: hours })]);
    const ev = diffOpportunities(p, p, "recompute");
    for (const k of ["trigger", "previousFreedomWindow", "newFreedomWindow", "opportunitiesAdded", "opportunitiesRemoved", "significance", "expiresAt", "reasonCodes"]) assert.ok(k in ev, k);
    assert.equal(ev.significance, "none"); assert.deepEqual(ev.reasonCodes, ["OPPORTUNITY_UNCHANGED"]); assert.equal(shouldNotify(ev), false); assert.equal(ev.expiresAt, T("16:00"));
  });
  it("the spec's example: the saved rooftop is no longer viable (rain) and an indoor plan now fits → HIGH, notify, kind plan_invalidated", () => {
    const before = portfolio([cand("rooftop", { placeType: "rooftop bar", openingWindows: hours }), cand("museum", { openingWindows: hours, liveConditions: { closure: "temporarily_closed" } })]);
    assert.deepEqual(before.executable.map((e) => e.candidateId), ["rooftop"]);
    const after = portfolio([cand("rooftop", { placeType: "rooftop bar", openingWindows: hours }), cand("museum", { openingWindows: hours })], {}, { liveSignals: [signal("rain_arriving", [{ kind: "plan_invalidated", subjectIds: ["rooftop"], detail: "" }])] });
    assert.deepEqual(after.executable.map((e) => e.candidateId), ["museum"]);
    const ev = diffOpportunities(before, after, "signal");
    assert.equal(ev.significance, "high"); assert.equal(shouldNotify(ev), true);
    assert.deepEqual(ev.opportunitiesRemoved.map((r) => [r.name, r.verdictNow]), [["rooftop", "NOT_EXECUTABLE"]]);
    assert.ok(ev.opportunitiesRemoved[0].reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED"));
    assert.deepEqual(ev.opportunitiesAdded.map((a) => a.name), ["museum"]);
    assert.ok(ev.reasonCodes.includes("OPPORTUNITY_FALLBACK_AVAILABLE") && ev.reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED"));
    assert.match(ev.detail, /rooftop no longer viable; museum now fits/);
    assert.equal(attentionKindFor(ev), "plan_invalidated");
  });
  it("'weather changed' with no viable change is raw data: same executable set → none, no notify", () => {
    const before = portfolio([cand("museum", { openingWindows: hours })]);
    const after = portfolio([cand("museum", { openingWindows: hours })], {}, { liveSignals: [signal("rain_arriving", [{ kind: "plan_invalidated", subjectIds: ["some-other-plan"], detail: "" }])] });
    const ev = diffOpportunities(before, after, "signal");
    assert.equal(ev.significance, "none"); assert.equal(shouldNotify(ev), false);
  });
  it("a new option that serves an open goal is MEDIUM; a new option without one is LOW; the best changing is MEDIUM; the window closing is CRITICAL; the first portfolio is a window opened", () => {
    const g = [{ id: "g1", type: "culture", scope: "shared", status: "open" }];
    const before = portfolio([cand("cafe", { placeType: "cafe", openingWindows: hours })], {}, { goals: g });
    const goalAdd = diffOpportunities(before, portfolio([cand("cafe", { placeType: "cafe", openingWindows: hours }), cand("museum", { openingWindows: hours })], {}, { goals: g }), "plan_changed");
    assert.equal(goalAdd.significance, "medium"); assert.ok(goalAdd.reasonCodes.includes("OPPORTUNITY_GOAL_SERVED"));
    const plainAdd = diffOpportunities(before, portfolio([cand("cafe", { placeType: "cafe", openingWindows: hours }), cand("cafe2", { placeType: "cafe", openingWindows: hours })], {}, { goals: g }), "plan_changed");
    assert.equal(plainAdd.significance, "low");
    const closed = diffOpportunities(before, { ...before, window: null, executable: [], notExecutable: [] }, "commitment_changed");
    assert.equal(closed.significance, "critical"); assert.ok(closed.reasonCodes.includes("OPPORTUNITY_WINDOW_CLOSED"));
    const first = diffOpportunities(null, before, "initial");
    assert.equal(first.significance, "medium"); assert.ok(first.reasonCodes.includes("OPPORTUNITY_WINDOW_OPENED")); assert.equal(first.previousFreedomWindow, null);
    const allGone = diffOpportunities(before, portfolio([cand("cafe", { placeType: "cafe", openingWindows: hours, liveConditions: { closure: "permanently_closed" } })], {}, { goals: g }), "signal");
    assert.equal(allGone.significance, "critical"); assert.ok(allGone.reasonCodes.includes("OPPORTUNITY_ALL_REMOVED")); assert.equal(attentionKindFor(allGone), "opportunity_removed");
  });
});
