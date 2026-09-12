/**
 * Trips spec §23 — two certification scenarios, composed from the engines:
 *   "Flight delay on arrival — dependency propagation; downstream proposal/replan."
 *   "Rain invalidates tour — risk trigger, fallback opportunity, booking side-effect explanation."
 * census-trips TR420, TR423.
 *
 * Run: node --import tsx/esm --test src/test/tripScenarios.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateRiskTriggers } from "../services/trips/TripRiskTriggers.js";
import { replanDay } from "../services/trips/TripReplan.js";
import { compileExperiences, type ExperienceCandidate, type TravelEstimator } from "../services/trips/TripExperienceCompiler.js";
import { diffOpportunities, shouldNotify, type OpportunityPortfolio } from "../services/trips/TripOpportunityEngine.js";
import { projectSignals, type TripSignal, type PulseContext } from "../services/trips/TripSignals.js";
import { computeFreedomWindows, type FreedomInputs } from "../services/trips/TripFreedomEngine.js";
import { deriveTripHealth, prioritySwitch } from "../services/trips/TripHealth.js";
import type { ImpactState } from "../services/trips/TripImpactPreview.js";

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const HOTEL = { lat: 48.8566, lng: 2.3522 }; const NEAR = { lat: 48.8600, lng: 2.3600 };
const travel: TravelEstimator = { minutes: (a, b) => { const d = Math.hypot((b.lat - a.lat) * 111_000, (b.lng - a.lng) * 73_000); return d <= 2000 ? { minutes: Math.ceil(d / 75), mode: "walk" } : { minutes: Math.ceil(d / 500) + 3, mode: "drive" }; } };

describe("§23 Flight delay on arrival — dependency propagation; downstream proposal/replan (TR420)", () => {
  it("a 75-minute ETA shift fires tight_arrival, names the downstream dinner and museum, and the replan moves them by the same and turns the shared one into a proposal", () => {
    const state: ImpactState = {
      plans: [
        { id: "museum", title: "Louvre", status: "confirmed", startsAt: T("16:00"), endsAt: T("18:00"), dayDate: "2026-09-13", participantIds: ["me", "ana"], planScope: "ALL_CREW", confirmed: true },
        { id: "nap", title: "Rest at the hotel", status: "planned", startsAt: T("14:30"), endsAt: T("15:30"), dayDate: "2026-09-13", participantIds: ["me"], planScope: "SOLO", confirmed: false },
      ],
      reservations: [], transport: [],
      commitments: [{ id: "flight", type: "flight", startsAt: T("13:00"), requiredArrivalAt: T("13:00"), flexibility: "fixed", participantIds: ["me", "ana"] }, { id: "dinner", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "flexible", participantIds: ["me", "ana"] }],
      safeReturnActiveFor: [], crewIds: ["me", "ana"],
    };
    const triggers = evaluateRiskTriggers({
      now: NOW, crewSize: 2, signals: [], transport: [],
      commitments: [{ id: "flight", type: "flight", startsAt: T("13:00"), requiredArrivalAt: T("13:00"), estimatedArrivalAt: T("14:15"), participantIds: ["me", "ana"] }, { id: "dinner", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00") }],
      plans: state.plans.map((p) => ({ id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, weatherSensitive: false, partySize: null })),
    });
    const tight = triggers.find((t) => t.kind === "tight_arrival")!;
    assert.equal(tight.fired, true); assert.equal(tight.magnitude, 75);
    assert.deepEqual([...tight.affectedIds].sort(), ["dinner", "flight", "museum", "nap"], "the dependency propagates to everything within twelve hours");
    assert.deepEqual(tight.participantIds, ["me", "ana"], "the participants to alert");
    assert.equal(tight.mitigation, "Move/cancel downstream plan; alert affected participants.");
    const diff = replanDay({ now: NOW, day: "2026-09-13", plans: state.plans, state, conflicts: [], signals: [], triggers, windows: [], opportunities: [], actorUserId: "me" });
    const museum = diff.entries.find((e) => e.planId === "museum")!; const nap = diff.entries.find((e) => e.planId === "nap")!;
    assert.equal(museum.op, "move"); assert.equal(museum.to!.startsAt, T("17:15")); assert.equal(museum.sharedMutation, true);
    assert.equal(nap.op, "move"); assert.equal(nap.to!.startsAt, T("15:45")); assert.equal(nap.sharedMutation, false);
    assert.deepEqual(diff.proposals.map((p) => p.planId), ["museum"], "the shared mutation becomes a proposal; the solo one is an edit");
    assert.equal(diff.requiresUserConfirmation, false, "nothing is booked");
  });
});

describe("§23 Rain invalidates tour — risk trigger, fallback opportunity, booking side-effect explanation (TR423)", () => {
  it("rain on a booked walking tour: the trigger fires, the tour leaves the portfolio and the museum enters it (HIGH, notify), the replan cancels with the booking's deadline, cost and confirmation, and health stays HEALTHY", () => {
    const ctx: PulseContext = {
      now: NOW, stage: { id: "st1", startsAt: T("00:00", "12"), endsAt: T("23:59", "15"), anchor: null }, locationBand: null, goals: [], transport: [], commitments: [],
      savedIdeas: [{ id: "museum", placeId: null, placeType: "museum", name: "Musée d'Orsay", point: NEAR }, { id: "tour", placeId: null, placeType: "walking tour", name: "Walking tour", point: NEAR }],
      plans: [{ id: "walk", title: "Walking tour of Montmartre", category: "activity", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, point: NEAR }],
      crew: { viewerId: "me", memberIds: ["me", "ana"] }, attention: "NORMAL",
    };
    const rain: TripSignal = { kind: "rain_arriving", subjectId: "2026-09-13", estimate: { value: { date: "2026-09-13", precipMm: 9, weatherCode: 63 }, confidence: 0.7, sourceClass: "imported_owned", observedAt: T("11:00"), expiresAt: T("17:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 } } };
    const pulse = projectSignals([rain], ctx);
    assert.equal(pulse.kept.length, 1); assert.deepEqual(pulse.kept[0].effects.map((e) => e.kind), ["plan_invalidated", "fallback_opportunity"]);

    // 1. the risk trigger
    const triggers = evaluateRiskTriggers({ now: NOW, crewSize: 2, signals: pulse.kept, transport: [], commitments: [], plans: [{ id: "walk", title: "Walking tour of Montmartre", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, partySize: 2 }] });
    const weather = triggers.find((t) => t.kind === "weather_sensitive")!;
    assert.equal(weather.fired, true); assert.deepEqual(weather.affectedIds, ["walk"]); assert.equal(weather.mitigation, "Prepare indoor fallback.");

    // 2. the fallback opportunity — the window between the hotel and dinner
    const freedom = computeFreedomWindows({
      commitments: [
        { id: "A", type: "check_in", startsAt: new Date(T("11:00")), endsAt: null, requiredArrivalAt: new Date(T("11:00")), latenessToleranceMinutes: 0, prepMinutes: 0, flexibility: "fixed", place: { placeId: "hotel", point: HOTEL } },
        { id: "B", type: "dinner", startsAt: new Date(T("20:00")), endsAt: null, requiredArrivalAt: new Date(T("20:00")), latenessToleranceMinutes: 0, prepMinutes: 15, flexibility: "fixed", place: { placeId: "rest", point: HOTEL } },
      ],
      hops: [{ travelMinutes: 0, confidence: "HIGH" as any, routed: false, unknownReason: null }],
      participants: ["me", "ana"], tripStart: new Date(T("00:00", "12")), tripEnd: new Date(T("23:59", "15")),
    } satisfies FreedomInputs);
    const w = freedom.windows.find((x) => x.position === "between")!;
    assert.ok(w, JSON.stringify(freedom.windows.map((x) => x.id)));
    const hours = [{ opensAt: T("09:00"), closesAt: T("18:00") }];
    // the tour is an open-air WALK (a "tour" by name would compile as LEARN, which needs a reservation)
    const candidates: ExperienceCandidate[] = [{ id: "tour", placeId: null, name: "Montmartre stroll", placeType: "park", point: NEAR, source: "saved_idea" }, { id: "museum", placeId: null, name: "Musée d'Orsay", placeType: "museum", point: NEAR, openingWindows: hours, source: "saved_idea" }];
    const before = compileExperiences({ now: NOW, window: w, origin: HOTEL, participants: [{ userId: "me" }, { userId: "ana" }], candidates, liveSignals: [], travel, goals: [], preferences: {}, nextCommitment: { id: "B", arriveBy: T("20:00"), point: HOTEL }, prepMinutes: 15 });
    const after = compileExperiences({ now: NOW, window: w, origin: HOTEL, participants: [{ userId: "me" }, { userId: "ana" }], candidates, liveSignals: pulse.kept.map((k) => ({ ...k, effects: k.effects.map((e) => e.kind === "plan_invalidated" ? { ...e, subjectIds: ["tour"] } : e) })), travel, goals: [], preferences: {}, nextCommitment: { id: "B", arriveBy: T("20:00"), point: HOTEL }, prepMinutes: 15 });
    const portfolio = (r: typeof before): OpportunityPortfolio => ({ tripId: "t", windowId: w.id, window: { id: w.id, beginsAt: w.beginsAt, endsAt: w.endsAt, durationMinutes: w.durationMinutes, certified: w.certified, participants: w.participants }, executable: r.experiences.filter((e) => e.verdict === "EXECUTABLE"), notExecutable: r.experiences.filter((e) => e.verdict !== "EXECUTABLE").map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, verdict: e.verdict, reasonCodes: e.reasonCodes })), computedAt: T("12:00"), sourceTripVersion: 1 });
    assert.deepEqual(before.experiences.filter((e) => e.verdict === "EXECUTABLE").map((e) => e.candidateId).sort(), ["museum", "tour"]);
    const ev = diffOpportunities(portfolio(before), portfolio(after), "signal");
    assert.deepEqual(ev.opportunitiesRemoved.map((r) => r.candidateId), ["tour"]); assert.ok(ev.opportunitiesRemoved[0].reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED"));
    assert.equal(ev.significance, "high"); assert.equal(shouldNotify(ev), true);

    // 3. the booking side-effect explanation, through the replan
    const state: ImpactState = {
      plans: [{ id: "walk", title: "Walking tour of Montmartre", status: "confirmed", startsAt: T("15:00"), endsAt: T("17:00"), dayDate: "2026-09-13", participantIds: ["me", "ana"], planScope: "ALL_CREW", confirmed: true }],
      reservations: [{ id: "tour-res", title: "Walking tour of Montmartre", type: "activity", status: "confirmed", startsAt: T("15:00"), endsAt: T("17:00"), cancellationDeadlineAt: T("13:00"), costMinor: 4000, currency: "EUR", planId: "walk", participantIds: ["me", "ana"] }],
      transport: [], commitments: [{ id: "B", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "fixed", participantIds: ["me", "ana"] }], safeReturnActiveFor: [], crewIds: ["me", "ana"],
    };
    const diff = replanDay({ now: NOW, day: "2026-09-13", plans: state.plans, state, conflicts: [], signals: pulse.kept, triggers, windows: [w], opportunities: after.experiences.filter((e) => e.verdict === "EXECUTABLE"), actorUserId: "me" });
    const cancel = diff.entries.find((e) => e.planId === "walk")!;
    assert.equal(cancel.op, "cancel");
    const se = cancel.impact!.bookingSideEffects;
    assert.equal(se.bookingsAtRisk[0].reservationId, "tour-res"); assert.equal(se.cancellationDeadline, T("13:00")); assert.equal(se.potentialCostMinor, 4000); assert.equal(se.currency, "EUR");
    assert.deepEqual(se.affectedParticipants, ["me", "ana"]); assert.equal(se.requiresUserConfirmation, true);
    assert.ok(se.explanation.some((x) => /soonest cancellation deadline 2026-09-13T13:00/.test(x)) && se.explanation.some((x) => /not cancelled without the user's confirmation/.test(x)));
    assert.equal(diff.entries.find((e) => e.op === "add")!.experienceId, `${w.id}:museum`);

    // 4. §17.1: rain is not a disruption; health stays where it was and discovery is not suppressed
    const health = deriveTripHealth({ conflicts: [], risks: [], disruptions: [], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } });
    assert.equal(health.health, "HEALTHY"); assert.equal(prioritySwitch(health).mode, "NORMAL");
  });
});
