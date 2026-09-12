/**
 * Trips spec §11.3 / §12.1 replanDay + simulatePlan, §14.3 the meeting
 * point, §17.3 rescue, §12.3 value of information — pure.
 * census-trips TR196, TR209, TR211, TR212, TR220, TR272–TR279, TR320–TR328.
 *
 * Run: node --import tsx/esm --test src/test/tripReplanMeetingRescue.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { replanDay, simulateChange, REPLAN_OPS, type ReplanInputs } from "../services/trips/TripReplan.js";
import { findMeetingPoint, MEETING_REFUSALS, type MeetingPointInputs } from "../services/trips/TripMeetingPoint.js";
import { planRescue, RESCUE_PROBLEMS, ESCALATION_TARGETS } from "../services/trips/TripRescue.js";
import { valueOfInformation, unknownsFromExperiences, VOI_MAX_QUESTIONS } from "../services/trips/TripValueOfInformation.js";
import type { ImpactState } from "../services/trips/TripImpactPreview.js";
import type { FreedomWindow } from "../services/trips/TripFreedomEngine.js";
import type { ExecutableTripExperience } from "../services/trips/TripExperienceCompiler.js";
import type { PulseInterpretation } from "../services/trips/TripSignals.js";

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const A = { lat: 48.8566, lng: 2.3522 }; const B = { lat: 48.8600, lng: 2.3600 }; const FAR = { lat: 48.9000, lng: 2.4500 };
const travel = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6_371_000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(s));
  return d <= 2000 ? { minutes: Math.ceil(d / 1.25 / 60), mode: "walk" } : { minutes: Math.ceil(d / 8.33 / 60) + 3, mode: "drive" };
};
const window = (o: Partial<FreedomWindow> = {}): FreedomWindow => ({ id: "fw:A:B", position: "between", beginsAt: T("12:00"), endsAt: T("18:00"), durationMinutes: 360, origin: { placeId: null, point: A }, requiredDestination: null, participants: ["me", "ana"], hardConstraints: [], confidence: "HIGH" as any, certified: true, reservedMinutes: 15, afterCommitmentId: "A", beforeCommitmentId: "B", ...o });
const state = (): ImpactState => ({
  plans: [
    { id: "walk", title: "Walking tour", status: "confirmed", startsAt: T("15:00"), endsAt: T("17:00"), dayDate: "2026-09-13", participantIds: ["me", "ana"], planScope: "ALL_CREW", confirmed: true },
    { id: "coffee", title: "Coffee", status: "planned", startsAt: T("13:00"), endsAt: T("13:30"), dayDate: "2026-09-13", participantIds: ["me"], planScope: "SOLO", confirmed: false },
    { id: "done", title: "Breakfast", status: "done", startsAt: T("09:00"), endsAt: T("10:00"), dayDate: "2026-09-13", participantIds: ["me", "ana"], planScope: "ALL_CREW", confirmed: true },
  ],
  reservations: [{ id: "tour-res", title: "Walking tour", type: "activity", status: "confirmed", startsAt: T("15:00"), endsAt: T("17:00"), cancellationDeadlineAt: T("13:00"), costMinor: 4000, currency: "EUR", planId: "walk", participantIds: ["me", "ana"] }],
  transport: [], commitments: [{ id: "B", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00"), flexibility: "fixed", participantIds: ["me", "ana"] }],
  safeReturnActiveFor: [], crewIds: ["me", "ana"],
});
const rainSignal: PulseInterpretation = { kind: "rain_arriving", subjectId: "2026-09-13", interpretation: "", relevance: ["stage"], effects: [{ kind: "plan_invalidated", subjectIds: ["walk"], detail: "" }], estimate: { value: {} as any, confidence: 0.8, sourceClass: "imported_owned", observedAt: T("11:00"), expiresAt: T("17:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 } } };
const museum: ExecutableTripExperience = { id: "fw:A:B:museum", windowId: "fw:A:B", candidateId: "museum", placeId: null, name: "Musée d'Orsay", primitive: "SEE", verdict: "EXECUTABLE", reasonCodes: [], arriveAt: T("15:20"), leaveBy: T("17:00"), stayMinutes: 75, travel: { toMinutes: 10, backMinutes: 10, mode: "walk" }, participants: ["me", "ana"], servesGoalIds: [], score: 0.7, properties: {} as any, explanation: [], source: "saved_idea" };
function inputs(o: Partial<ReplanInputs> = {}): ReplanInputs {
  const st = state();
  return { now: NOW, day: "2026-09-13", plans: st.plans, state: st, conflicts: [], signals: [], triggers: [], windows: [window()], opportunities: [], actorUserId: "me", ...o };
}

describe("§11.3 replanDay — a candidate diff, never a write", () => {
  it("nothing wrong: every plan is kept, no proposals, no confirmation", () => {
    const d = replanDay(inputs());
    assert.deepEqual([...REPLAN_OPS], ["keep", "move", "cancel", "add"]);
    assert.deepEqual(d.counts, { keep: 3, move: 0, cancel: 0, add: 0 }); assert.deepEqual(d.proposals, []); assert.equal(d.requiresUserConfirmation, false);
    assert.ok(d.entries.every((e) => e.op === "keep" && e.impact === null));
  });
  it("rain invalidates the shared booked walk: cancel with the §15.3 side effects, add the best executable fallback; both are shared mutations → proposals; confirmation required", () => {
    const d = replanDay(inputs({ signals: [rainSignal], opportunities: [museum] }));
    const cancel = d.entries.find((e) => e.planId === "walk")!;
    assert.equal(cancel.op, "cancel"); assert.equal(cancel.reason, "PLAN_INVALIDATED_BY_SIGNAL"); assert.equal(cancel.sharedMutation, true);
    assert.equal(cancel.impact!.bookingSideEffects.bookingsAtRisk.length, 1); assert.equal(cancel.impact!.bookingSideEffects.requiresUserConfirmation, true);
    const add = d.entries.find((e) => e.op === "add")!;
    assert.equal(add.reason, "FALLBACK_OPPORTUNITY"); assert.equal(add.experienceId, "fw:A:B:museum"); assert.deepEqual(add.to, { startsAt: T("15:20"), endsAt: T("17:00") });
    assert.deepEqual(d.proposals.map((p) => p.op), ["cancel", "add"]); assert.equal(d.requiresUserConfirmation, true);
    assert.match(d.summary, /1 cancelled, 1 added; 2 shared mutation\(s\) become proposals; a booking is at risk/);
  });
  it("a plan in conflict moves to the first free slot that clears it; locked plans and dropped plans obey the constraints; maxMoves caps", () => {
    const conflict = { reason: "TRIP_TEMPORAL_CONFLICT" as const, kind: "PLAN_OVERLAP" as const, commitmentIds: [], planIds: ["coffee", "walk"], shortfallMinutes: 30, overridden: false as const, detail: "coffee overlaps walk" };
    const d = replanDay(inputs({ conflicts: [conflict], constraints: { lockedPlanIds: ["walk"] } }));
    const moved = d.entries.find((e) => e.planId === "coffee")!;
    assert.equal(moved.op, "move"); assert.equal(moved.reason, "PLAN_IN_CONFLICT"); assert.ok(Date.parse(moved.to!.startsAt!) >= Date.parse(T("13:30")));
    assert.equal(d.entries.find((e) => e.planId === "walk")!.op, "keep");
    const capped = replanDay(inputs({ conflicts: [conflict], constraints: { lockedPlanIds: ["walk"], maxMoves: 0 } }));
    assert.equal(capped.entries.find((e) => e.planId === "coffee")!.op, "keep");
    const dropped = replanDay(inputs({ constraints: { dropPlanIds: ["coffee"] } }));
    assert.equal(dropped.entries.find((e) => e.planId === "coffee")!.reason, "CONSTRAINT_DROP"); assert.equal(dropped.entries.find((e) => e.planId === "coffee")!.sharedMutation, false, "a solo plan is nobody else's");
  });
  it("downstream of a tight arrival: plans the trigger names move by the arrival's magnitude", () => {
    const trigger = { kind: "tight_arrival" as const, fired: true, affectedIds: ["flight", "coffee"], participantIds: [], evidence: "", mitigation: "", magnitude: 45 };
    const d = replanDay(inputs({ triggers: [trigger] }));
    const e = d.entries.find((x) => x.planId === "coffee")!;
    assert.equal(e.op, "move"); assert.equal(e.reason, "PLAN_DOWNSTREAM_OF_TIGHT_ARRIVAL"); assert.equal(e.to!.startsAt, T("13:45"));
  });
});

describe("§12.1 simulatePlan — judged, not written", () => {
  it("a move into the dinner's approach window is INFEASIBLE with the conflict; a move inside the free window is FEASIBLE and says what the window keeps; no slot is UNKNOWN", () => {
    const bad = simulateChange({ kind: "move_plan", targetId: "coffee", startsAt: T("19:40"), endsAt: T("20:10"), proposedBy: "me" }, state(), [window()], NOW);
    assert.equal(bad.feasibility, "INFEASIBLE"); assert.equal(bad.conflicts[0].commitmentIds[0], "B");
    const ok = simulateChange({ kind: "move_plan", targetId: "coffee", startsAt: T("13:45"), endsAt: T("14:15"), proposedBy: "me" }, state(), [window()], NOW);
    assert.equal(ok.feasibility, "FEASIBLE"); assert.deepEqual(ok.windowAfter, { id: "fw:A:B", durationMinutesBefore: 360, durationMinutesAfter: 330 });
    const unknown = simulateChange({ kind: "add_plan", targetId: null, title: "x", proposedBy: "me" }, state(), [window()], NOW);
    assert.equal(unknown.feasibility, "UNKNOWN");
    assert.ok(ok.explanation.some((x) => /no booking is at risk/.test(x)));
  });
});

describe("§14.3 findMeetingPoint — least group burden, every constraint by name, alternatives and refusals", () => {
  const base = (): MeetingPointInputs => ({
    now: NOW, travel,
    participants: [{ userId: "me", point: A }, { userId: "ana", point: B }, { userId: "bo", point: null, positionReason: "not sharing" }],
    candidates: [
      { id: "cafe", name: "Café Mid", point: { lat: 48.8583, lng: 2.3561 }, placeType: "cafe" },
      { id: "far-bar", name: "Far Bar", point: FAR, placeType: "bar" },
      { id: "hotel", name: "Our hotel", point: A, placeType: "hotel", privateAnchor: true },
      { id: "station", name: "Gare", point: B, placeType: "train_station" },
      { id: "closed", name: "Closed bar", point: B, placeType: "bar", closure: "temporarily_closed" },
      { id: "tiny", name: "Tiny bar", point: B, placeType: "bar", capacity: 2 },
      { id: "stairs", name: "Stairs bar", point: B, placeType: "bar", accessibilityConstraints: ["stairs_only"] },
      { id: "mall", name: "Mall", point: B, placeType: "shopping_mall" },
    ],
  });
  it("recommends the café between them, lists alternatives by burden, refuses the private anchor, the closed bar, the small bar, the mall; names the unplaced participant", () => {
    const r = findMeetingPoint(base());
    assert.equal(r.recommended!.candidateId, "cafe"); assert.ok(r.recommended!.explanation[0].includes("min of group travel"));
    assert.deepEqual(r.alternatives.map((a) => a.candidateId), ["stairs", "station", "far-bar"], "by group burden; the two at ana's spot tie and order by id; the far bar last");
    const refused = Object.fromEntries(r.refused.map((x) => [x.candidateId, x.refusals]));
    assert.deepEqual(refused.hotel, ["PRIVATE_ANCHOR"]); assert.deepEqual(refused.closed, ["VENUE_CLOSED"]); assert.deepEqual(refused.tiny, ["PARTY_EXCEEDS_CAPACITY"]); assert.deepEqual(refused.mall, ["VENUE_UNSUITABLE"], "a SHOP is not a place to meet");
    assert.deepEqual(r.unplaced, [{ userId: "bo", reason: "not sharing" }]);
    assert.equal(r.constraintsApplied.length, 6);
    assert.ok(MEETING_REFUSALS.includes("NEXT_COMMITMENT_MISSED"));
  });
  it("accessibility and next commitments: a need refuses the stairs bar; a commitment nobody could make from the far bar refuses it and says by how much; unreliable transport weighs a journey more", () => {
    const i = base();
    i.participants = [{ userId: "me", point: A, accessibilityNeeds: ["stairs_only"], nextCommitment: { id: "B", arriveBy: new Date(NOW + 40 * 60_000).toISOString(), point: A } }, { userId: "ana", point: B }];
    const r = findMeetingPoint(i);
    const refused = Object.fromEntries(r.refused.map((x) => [x.candidateId, x]));
    assert.ok(refused.stairs.refusals.includes("ACCESSIBILITY_UNMET"));
    assert.ok(refused["far-bar"].refusals.includes("NEXT_COMMITMENT_MISSED")); assert.ok(refused["far-bar"].explanation.some((x) => /me would miss B by \d+ min/.test(x)));
    const j = base(); j.participants = [{ userId: "me", point: A, transportReliability: 0.5 }, { userId: "ana", point: B }];
    const weighted = findMeetingPoint(j).recommended!;
    const plain = findMeetingPoint(base()).recommended!;
    assert.ok(weighted.groupBurdenMinutes > plain.groupBurdenMinutes, "an unreliable leg costs more");
  });
  it("nobody placed: no recommendation, every candidate refused, the explanation says so", () => {
    const i = base(); i.participants = [{ userId: "me", point: null }, { userId: "ana", point: null }];
    const r = findMeetingPoint(i);
    assert.equal(r.recommended, null); assert.equal(r.alternatives.length, 0); assert.match(r.explanation[0], /nobody has a shared position/);
  });
});

describe("§17.3 planRescue — typed problems, institution-directed escalation", () => {
  it("the seven problems; each plan declares a disruption, escalates to an institution or the crew, and keeps Compass organising", () => {
    assert.deepEqual([...RESCUE_PROBLEMS], ["missed_transport", "hotel_issue", "lost_crew", "no_ride", "travel_document", "stranded", "emergency"]);
    for (const p of RESCUE_PROBLEMS) {
      const plan = planRescue(p, { now: NOW });
      assert.ok(plan.steps.length >= 2, p); assert.ok(plan.escalation.length >= 1, p);
      assert.ok(plan.escalation.every((e) => (ESCALATION_TARGETS as readonly string[]).includes(e.to)), p);
      assert.ok(plan.compass.mustNot.some((x) => /book, cancel or rebook/.test(x)), p);
      assert.ok(["minor", "major", "critical"].includes(plan.declare.severity));
    }
  });
  it("missed flight → airline now, airport if unresolved; travel document → embassy/consulate now; emergency → local emergency now, Safe Return attached; lost crew → crew first, police if unsafe", () => {
    const flight = planRescue("missed_transport", { now: NOW, transport: { id: "seg", mode: "flight", providerRef: "AB123", fallbackId: "seg2" } });
    assert.deepEqual(flight.escalation.map((e) => [e.to, e.when]), [["airline", "now"], ["airport", "if_unresolved"]]);
    assert.ok(flight.steps.some((s) => /AB123/.test(s.detail)) && flight.steps.some((s) => /fallback seg2/.test(s.detail)));
    const doc = planRescue("travel_document", { now: NOW, homeCountry: "Ireland", destinationCountry: "France" });
    assert.equal(doc.escalation[0].to, "embassy_consulate"); assert.match(doc.steps[0].detail, /Ireland's mission in France/); assert.equal(doc.severity, "critical");
    const em = planRescue("emergency", { now: NOW, emergencyNumber: "112", destinationCountry: "France" });
    assert.equal(em.escalation[0].to, "local_emergency"); assert.equal(em.safeReturn, "attach"); assert.match(em.steps[0].detail, /112/); assert.equal(em.declare.kind, "safety");
    const lost = planRescue("lost_crew", { now: NOW, crewWithPosition: ["ana"] });
    assert.deepEqual(lost.escalation.map((e) => [e.to, e.when]), [["trip_crew", "now"], ["local_emergency", "if_unsafe"]]); assert.equal(lost.safeReturn, "offer");
  });
});

describe("§12.3 valueOfInformation — ask only what could change the decision", () => {
  it("value = probability × stakes; above the threshold it is a question, capped; below it stays uncertainty", () => {
    const v = valueOfInformation([
      { key: "a", dimension: "feasibility", probabilityChangesDecision: 0.9, stakes: 0.9, question: "A?" },
      { key: "b", dimension: "cost", probabilityChangesDecision: 0.6, stakes: 0.6, question: "B?" },
      { key: "c", dimension: "recommendation_quality", probabilityChangesDecision: 0.5, stakes: 0.6, question: "C?" },
      { key: "d", dimension: "authorization", probabilityChangesDecision: 0.1, stakes: 1, question: "D?" },
    ]);
    assert.deepEqual(v.ask.map((q) => q.key), ["a", "b"]); assert.equal(v.ask.length, VOI_MAX_QUESTIONS);
    assert.deepEqual(v.uncertainty.map((q) => [q.key, q.representedAs]), [["c", "uncertainty"], ["d", "uncertainty"]]);
    assert.equal(v.uncertainty[1].question, null);
  });
  it("from experiences: an UNCERTAIN option that could beat the best is worth a question; one that could not is represented as uncertainty", () => {
    const exp = (id: string, verdict: string, reasonCodes: string[], score: number, goals: string[] = []) => ({ id, name: id, verdict, reasonCodes, score, servesGoalIds: goals });
    const strongBest = unknownsFromExperiences([exp("best", "EXECUTABLE", [], 0.9), exp("maybe", "UNCERTAIN", ["EXPERIENCE_HOURS_UNKNOWN"], 0)]);
    const v1 = valueOfInformation(strongBest);
    assert.equal(v1.ask.length, 0); assert.equal(v1.uncertainty.length, 1);
    const weakBest = unknownsFromExperiences([exp("best", "EXECUTABLE", [], 0.4), exp("maybe", "UNCERTAIN", ["EXPERIENCE_HOURS_UNKNOWN"], 0, ["g1"])]);
    const v2 = valueOfInformation(weakBest);
    assert.equal(v2.ask.length, 1); assert.match(v2.ask[0].question!, /when maybe is open today/);
  });
});
