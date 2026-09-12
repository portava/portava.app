/**
 * Trips spec §8.2 decision urgency, §8.4 the risk register's four triggers,
 * §9.4 impact preview and §15.3 invalidation semantics — pure.
 * census-trips TR140, TR141, TR145–TR147, TR156, TR291–TR295.
 *
 * Run: node --import tsx/esm --test src/test/tripDecisionRiskImpact.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decisionUrgency, classifyConsequence, byUrgency, URGENCY_WEIGHTS, URGENCY_BANDS, TIME_HORIZON_HOURS } from "../services/trips/TripDecisionUrgency.js";
import { evaluateRiskTriggers, RISK_MITIGATIONS, RISK_TRIGGER_KINDS, TIGHT_ARRIVAL_THRESHOLD_MIN, type RiskTriggerInputs } from "../services/trips/TripRiskTriggers.js";
import { previewImpact, type ImpactState, type ProposedChange } from "../services/trips/TripImpactPreview.js";
import type { PulseInterpretation } from "../services/trips/TripSignals.js";

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const rain = (confidence: number, planIds: string[]): PulseInterpretation => ({
  kind: "rain_arriving", subjectId: "2026-09-13", interpretation: "", relevance: ["stage"],
  effects: [{ kind: "plan_invalidated", subjectIds: planIds, detail: "" }],
  estimate: { value: {} as any, confidence, sourceClass: "imported_owned", observedAt: T("11:00"), expiresAt: T("17:00"), fallbackUsed: false, contradictorySources: [], support: { agreeing: 1, total: 1 } },
});

describe("§8.2 decisionUrgency = f(timeRemaining, availabilityDecay, downstreamImpact, consequence)", () => {
  it("four terms, four weights that sum to one, four bands; a passed deadline is 1 on time; no deadline is 0 and says so", () => {
    assert.deepEqual([...URGENCY_BANDS], ["low", "medium", "high", "critical"]);
    assert.ok(Math.abs(Object.values(URGENCY_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    const base = { downstream: { dependentCommitments: 0, dependentPlans: 0, totalCommitments: 4, totalPlans: 6 }, consequence: null };
    const passed = decisionUrgency({ ...base, deadlineAt: T("11:00") }, NOW);
    assert.equal(passed.terms.timeRemaining, 1); assert.ok(passed.hoursRemaining! < 0);
    const none = decisionUrgency({ ...base, deadlineAt: null }, NOW);
    assert.equal(none.terms.timeRemaining, 0); assert.equal(none.hoursRemaining, null); assert.match(none.explanation[0], /no deadline/);
    const far = decisionUrgency({ ...base, deadlineAt: new Date(NOW + TIME_HORIZON_HOURS * 3_600_000).toISOString() }, NOW);
    assert.equal(far.terms.timeRemaining, 0);
    const soon = decisionUrgency({ ...base, deadlineAt: new Date(NOW + 2 * 3_600_000).toISOString() }, NOW);
    assert.ok(soon.terms.timeRemaining > 0.9);
  });
  it("not merely chronological: an undated decision with a severe consequence and everything downstream outranks a dated trivial one", () => {
    const trivialSoon = decisionUrgency({ deadlineAt: new Date(NOW + 3 * 3_600_000).toISOString(), downstream: { dependentCommitments: 0, dependentPlans: 0, totalCommitments: 4, totalPlans: 6 }, consequence: "a small fee" }, NOW);
    const undatedSevere = decisionUrgency({ deadlineAt: null, availabilityDecay: 0.8, downstream: { dependentCommitments: 3, dependentPlans: 4, totalCommitments: 4, totalPlans: 6 }, consequence: "the crew would be stranded overnight with nowhere to sleep" }, NOW);
    assert.ok(undatedSevere.score > trivialSoon.score, `${undatedSevere.score} > ${trivialSoon.score}`);
    assert.equal(undatedSevere.consequenceLevel, "severe"); assert.equal(trivialSoon.consequenceLevel, "minor");
    assert.equal([trivialSoon, undatedSevere].map((u, i) => ({ id: String(i), urgency: u })).sort(byUrgency)[0].id, "1");
  });
  it("availability decay from a half-life: half the option gone after one half-life; consequence classified from text", () => {
    const u = decisionUrgency({ deadlineAt: null, availabilityDecay: { halfLifeHours: 6, sinceIso: new Date(NOW - 6 * 3_600_000).toISOString() }, downstream: { dependentCommitments: 0, dependentPlans: 0, totalCommitments: 0, totalPlans: 0 }, consequence: null }, NOW);
    assert.ok(Math.abs(u.terms.availabilityDecay - 0.5) < 1e-9);
    assert.equal(classifyConsequence("non-refundable deposit lost"), "major"); assert.equal(classifyConsequence("missed flight"), "severe"); assert.equal(classifyConsequence("major"), "major"); assert.equal(classifyConsequence(null), "none");
  });
});

describe("§8.4 the four register triggers", () => {
  const base = (): RiskTriggerInputs => ({ now: NOW, commitments: [], plans: [], transport: [], signals: [], crewSize: 4 });
  it("every trigger is evaluated every time, fired or not, with the spec's mitigation verbatim", () => {
    const r = evaluateRiskTriggers(base());
    assert.deepEqual(r.map((t) => t.kind), [...RISK_TRIGGER_KINDS]);
    assert.ok(r.every((t) => !t.fired && t.mitigation === RISK_MITIGATIONS[t.kind] && t.evidence.length > 10));
  });
  it("tight arrival: a flight ETA beyond the threshold fires, names the downstream plans within twelve hours and the participants to alert", () => {
    const i = base();
    i.commitments = [{ id: "flight", type: "flight", startsAt: T("13:00"), requiredArrivalAt: T("13:00"), estimatedArrivalAt: T("14:15"), participantIds: ["me", "ana"] }, { id: "dinner", type: "dinner", startsAt: T("20:00"), requiredArrivalAt: T("20:00") }];
    i.plans = [{ id: "museum", title: "Louvre", startsAt: T("16:00"), endsAt: T("18:00"), weatherSensitive: false, partySize: null }, { id: "tomorrow", title: "Tour", startsAt: T("10:00", "14"), endsAt: null, weatherSensitive: false, partySize: null }];
    const t = evaluateRiskTriggers(i).find((x) => x.kind === "tight_arrival")!;
    assert.equal(t.fired, true); assert.equal(t.magnitude, 75); assert.deepEqual(t.affectedIds, ["flight", "dinner", "museum"]); assert.deepEqual(t.participantIds, ["me", "ana"]);
    i.commitments[0].estimatedArrivalAt = new Date(Date.parse(T("13:00")) + (TIGHT_ARRIVAL_THRESHOLD_MIN - 1) * 60_000).toISOString();
    assert.equal(evaluateRiskTriggers(i).find((x) => x.kind === "tight_arrival")!.fired, false, "under the threshold is not tight");
  });
  it("weather-sensitive: forecast confidence × dependency — a confident rain on a weather-bound plan fires; a low-confidence one, or rain on nothing, does not", () => {
    const i = base();
    i.plans = [{ id: "walk", title: "Walking tour", startsAt: T("15:00"), endsAt: T("17:00"), weatherSensitive: true, partySize: null }];
    i.signals = [rain(0.7, ["walk"])];
    const t = evaluateRiskTriggers(i).find((x) => x.kind === "weather_sensitive")!;
    assert.equal(t.fired, true); assert.deepEqual(t.affectedIds, ["walk"]); assert.equal(t.magnitude, 0.7);
    i.signals = [rain(0.3, ["walk"])];
    assert.equal(evaluateRiskTriggers(i).find((x) => x.kind === "weather_sensitive")!.fired, false);
    i.signals = [rain(0.9, ["other"])];
    assert.equal(evaluateRiskTriggers(i).find((x) => x.kind === "weather_sensitive")!.fired, false);
  });
  it("late check-in: an arrival estimate past the desk's deadline fires; crew transport mismatch: a party over the vehicle's seats fires, unknown capacity does not", () => {
    const i = base();
    i.commitments = [{ id: "hotel", type: "check_in", startsAt: T("22:00"), requiredArrivalAt: null, estimatedArrivalAt: T("23:30"), checkInDeadlineAt: T("23:00"), participantIds: ["me"] }];
    const late = evaluateRiskTriggers(i).find((x) => x.kind === "late_check_in")!;
    assert.equal(late.fired, true); assert.equal(late.magnitude, 30); assert.deepEqual(late.participantIds, ["me"]);
    const j = base();
    j.transport = [{ id: "cab", mode: "taxi", state: "planned", plannedDepartureAt: T("19:00"), partySize: 6, capacity: null }, { id: "van", mode: "van", state: "planned", plannedDepartureAt: T("19:00"), partySize: 6, capacity: null }, { id: "mystery", mode: "hovercraft", state: "planned", plannedDepartureAt: T("19:00"), partySize: 9, capacity: null }, { id: "done", mode: "taxi", state: "completed", plannedDepartureAt: T("09:00"), partySize: 9, capacity: null }];
    const mm = evaluateRiskTriggers(j).find((x) => x.kind === "crew_transport_mismatch")!;
    assert.equal(mm.fired, true); assert.deepEqual(mm.affectedIds, ["cab"]); assert.equal(mm.magnitude, 2);
  });
});

describe("§9.4 previewImpact and §15.3 booking side effects", () => {
  const state = (): ImpactState => ({
    plans: [
      { id: "dinner", title: "Dinner at Chez Paul", status: "confirmed", startsAt: T("19:30"), endsAt: T("21:30"), dayDate: "2026-09-13", participantIds: ["me", "ana", "bo"], planScope: "ALL_CREW", confirmed: true },
      { id: "walk", title: "Walk", status: "planned", startsAt: T("15:00"), endsAt: T("17:00"), dayDate: "2026-09-13", participantIds: ["me"], planScope: "SOLO", confirmed: false },
    ],
    reservations: [{ id: "res1", title: "Chez Paul", type: "restaurant", status: "confirmed", startsAt: T("19:30"), endsAt: T("21:30"), cancellationDeadlineAt: T("15:00"), costMinor: 12000, currency: "EUR", planId: null, participantIds: ["me", "ana", "bo"] }],
    transport: [{ id: "cab", mode: "taxi", state: "planned", plannedDepartureAt: T("19:00"), plannedArrivalAt: T("19:25"), servesId: "dinner", partySize: 3, costMinor: 1500, currency: "EUR" }],
    commitments: [{ id: "last-train", type: "transport", startsAt: T("23:30"), requiredArrivalAt: T("23:20"), flexibility: "fixed", participantIds: ["me", "ana", "bo"] }],
    safeReturnActiveFor: ["bo"], crewIds: ["me", "ana", "bo"],
  });
  it("cancelling a confirmed shared dinner: the reservation and the cab are affected, the booking is at risk with its deadline and cost, confirmation is required, three participants, Safe Return named, unanimous rule suggested", () => {
    const p = previewImpact({ kind: "cancel_plan", targetId: "dinner", proposedBy: "me" }, state(), NOW);
    assert.equal(p.changesConfirmedPlan, true);
    assert.deepEqual(p.affectedReservations.map((r) => r.id), ["res1"]); assert.deepEqual(p.affectedTransport.map((t) => t.id), ["cab"]);
    assert.deepEqual(p.affectedParticipants, ["me", "ana", "bo"]);
    const se = p.bookingSideEffects;
    assert.equal(se.requiresUserConfirmation, true); assert.equal(se.bookingsAtRisk.length, 1); assert.equal(se.cancellationDeadline, T("15:00")); assert.equal(se.bookingsAtRisk[0].deadlinePassed, false);
    assert.equal(se.potentialCostMinor, 12000); assert.equal(se.currency, "EUR"); assert.equal(p.cancellationCosts.knownMinor, 13500);
    assert.ok(se.explanation.some((x) => /not cancelled without the user's confirmation/.test(x)));
    assert.deepEqual(p.safetyImplications.length, 1); assert.match(p.safetyImplications[0], /bo has an active Safe Return/);
    assert.deepEqual(p.governance, { sharedMutation: true, affectsOthers: true, suggestedDecisionRule: "unanimous" });
  });
  it("moving the dinner into the last train's approach window is a commitment conflict; a cost the reservation does not carry is null, not zero; a passed deadline is said", () => {
    const s = state(); s.reservations[0].costMinor = null; s.reservations[0].currency = null; s.reservations[0].cancellationDeadlineAt = T("11:00");
    const p = previewImpact({ kind: "move_plan", targetId: "dinner", startsAt: T("22:30"), endsAt: T("23:15"), proposedBy: "me" }, s, NOW);
    assert.equal(p.commitmentConflicts.length, 1); assert.equal(p.commitmentConflicts[0].commitmentIds[0], "last-train");
    assert.equal(p.bookingSideEffects.potentialCostMinor, null); assert.equal(p.bookingSideEffects.bookingsAtRisk[0].deadlinePassed, true);
    assert.ok(p.bookingSideEffects.explanation.some((x) => /unknown, not zero/.test(x)));
  });
  it("a solo walk with no booking: nothing at risk, no confirmation, rule anyone; a moved plan overlapping another that day is a PLAN_OVERLAP", () => {
    const p = previewImpact({ kind: "cancel_plan", targetId: "walk", proposedBy: "me" }, state(), NOW);
    assert.equal(p.bookingSideEffects.requiresUserConfirmation, false); assert.equal(p.bookingSideEffects.potentialCostMinor, 0);
    assert.deepEqual(p.governance, { sharedMutation: false, affectsOthers: false, suggestedDecisionRule: "anyone" });
    const m = previewImpact({ kind: "move_plan", targetId: "walk", startsAt: T("20:00"), endsAt: T("21:00"), proposedBy: "me" }, state(), NOW);
    assert.ok(m.commitmentConflicts.some((c) => c.kind === "PLAN_OVERLAP" && c.planIds.includes("dinner")));
  });
});
