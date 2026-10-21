import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { assess } from "../services/airport/LayoverSafetyEngine.js";
import { certifyRecommendation } from "../services/airport/LayoverFeasibilityService.js";
import { recommendationSpecColumns, servedStatusOf, storedStatusProjector } from "../services/layover/LayoverRecommendationStatus.js";
import { recommendationCommitment, servedRecommendationContract } from "../services/airport/LayoverRecommendationContract.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import { objectiveTerms } from "../services/airport/layoverObjective.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";
import type { RoutedCardContract } from "../services/airport/LayoverRoutedFeasibility.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { markCanonicalValidation, certifiedPlanningInstant } from "../services/layover/layoverCanonicalValidity.js";

const NOW = Date.parse("2026-10-19T10:00:00Z"), MIN = 60_000;
const iso = (min: number) => new Date(NOW + min * MIN).toISOString();
const airport: AirportProfile = { id: "airport-a", iataCode: "TPE", name: "Airport", city: "Taipei", country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.07, lng: 121.23, domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, verified: true };
const session: LayoverSession = { id: "session-a", userId: "user-a", airportId: airport.id, tripId: null, arrivalTime: iso(-60), departureTime: iso(600), boardingTime: null, layoverMinutes: 660, flightType: "domestic", immigrationRequired: false, checkedBags: false, loungeAccess: false, wantsToLeave: true, comfortLevel: "moderate", vibeChips: ["food"], manualAirportName: null, manualCity: null, manualCountry: null, manualIata: null, canonicalCityId: null, shareCityStatus: false, returnReminderAt: null, status: "active", createdAt: iso(-60), updatedAt: iso(-60) };
const record = certifySessionFeasibility(airport, session, { nowMs: NOW, entry: { state: "permitted", corridor: { passportCountry: "US", destinationCountry: "TW" }, status: "visa_free" } });
const hard = record.deadline.hardReturnTime.toISOString();
const routed: RoutedCardContract = {
  state: "FEASIBLE", band: "SAFE", reason: null, reasonCodes: [], preference: 0, absence: null, prefilter: null, mode: "drive",
  outboundMinutes: 20, returnMinutes: 35, conservativeReturnMinutes: 50, minExperienceMin: 30, hardReturnBy: hard,
  leaveBy: new Date(Date.parse(hard) - 50 * MIN).toISOString(), expectedAirportReturnAt: iso(100), slackMinutes: 300, confidence: "MEDIUM",
  signals: { independentReturnRoutes: 2, offeredReturnRoutes: 2, fragileCorridor: false, nonInterruptible: false, returnInterruptibility: "interruptible", transferCount: 0, returnRouteUnreliable: false, contributingFactors: [] },
  returnContract: { hardReturnBy: hard, leaveBy: new Date(Date.parse(hard) - 50 * MIN).toISOString(), route: { mode: "drive", departAt: iso(50), minutes: 35, conservativeMinutes: 50, forecast: true, independentRoutes: 2, offeredRoutes: 2, transferCount: 0, interruptibility: "interruptible", conveyances: [] } },
  expiresAt: iso(10),
};
function input(insideAirport = false) {
  const facts = { title: "Lunch", recType: "food", insideAirport, travelTimeMin: insideAirport ? 0 : 20, returnTravelTimeMin: insideAirport ? 0 : 50, travelTimeSource: insideAirport ? "inside_airport" as const : "measured" as const, activityTimeMin: 30 };
  const assessment = assess(airport, session, facts, NOW, record);
  return { card: { ...facts, assessment }, assessment, key: "place:a", mapBand: "SAFE" as const, record, snapshotId: snapshotIdFor(session.id, record.inputHash), routing: insideAirport ? null : routed };
}

describe("L74/L76/L176/L178 executable recommendation contracts", () => {
  it("fresh canonical proof applies only to its exact record and request instant without changing replay inputs", () => {
    const prior = { ...record }, later = NOW + 100, facts = input(true).card;
    assert.equal(assess(airport, session, facts, later, prior).rating, "not_recommended");
    markCanonicalValidation(prior, later);
    assert.equal(certifiedPlanningInstant(prior), later); assert.equal(prior.inputs.nowMs, NOW); assert.equal(prior.inputHash, record.inputHash);
    assert.equal(assess(airport, session, facts, later, prior).rating, "safe");
    assert.equal(assess(airport, session, facts, later + 1, prior).rating, "not_recommended");
    assert.equal(assess(airport, session, facts, later, { ...prior }).rating, "not_recommended");
    const contract = certifyRecommendation(session.id, { ...input(true), record: prior, assessment: assess(airport, session, facts, later, prior) });
    assert.equal(contract.estimatedArrival, new Date(later).toISOString());
  });
  it("carries all §9 fields and a real asymmetric return itinerary without double-charging the protected buffer", () => {
    const c = certifyRecommendation(session.id, input());
    assert.equal(c.state, "READY", c.failureModes.join(","));
    assert.equal(c.estimatedArrival, iso(20)); assert.equal(c.expectedAirportReturn, iso(100));
    assert.equal(c.hardReturnBy, hard); assert.equal(recommendationCommitment(record).mustLeaveBy, hard);
    assert.equal(c.leaveActivityBy, routed.leaveBy); assert.equal(c.departBy, new Date(Date.parse(hard) - 100 * MIN).toISOString());
    assert.equal(c.fallbackPlan.returnRoute?.minutes, 35); assert.equal(c.fallbackPlan.returnRoute?.conservativeMinutes, 50);
    assert.equal(c.abortThreshold.leaveBy, c.leaveActivityBy); assert.deepEqual(c.itinerary.map(s => s.kind), ["outbound", "experience", "return"]);
    for (const name of ["snapshotId", "candidateIds", "departBy", "estimatedArrival", "minExperienceMinutes", "idealExperienceMinutes", "leaveActivityBy", "expectedAirportReturn", "hardReturnBy", "returnBufferMinutes", "riskBand", "confidence", "fallbackPlan", "abortThreshold", "failureModes", "reasonCodes"]) assert.ok(name in c, name);
  });
  it("a one-way measured leg cannot masquerade as an executable return plan", () => {
    const c = certifyRecommendation(session.id, { ...input(), routing: null });
    assert.equal(c.state, "UNAVAILABLE"); assert.equal(c.expectedAirportReturn, null); assert.equal(c.departBy, null);
    assert.ok(c.failureModes.includes("return_route_unmeasured"));
    const row = recommendationSpecColumns({ ...input(), routing: null });
    assert.equal(row.recommendation_status, "BLOCKED"); assert.equal(row.risk_band, "UNSAFE");
  });
  it("missing dwell does not borrow the experience primitive's typical duration", () => {
    const i = input(); i.assessment = { ...i.assessment, statedActivityMin: null };
    const c = certifyRecommendation(session.id, i);
    assert.equal(c.minExperienceMinutes, null); assert.equal(c.idealExperienceMinutes, null); assert.equal(c.expectedAirportReturn, null);
    assert.ok(c.failureModes.includes("duration_unstated"));
  });
  it("rejects absent, foreign-session, and mismatched snapshot citations", () => {
    for (const [sid, snapshotId] of [[session.id, null], ["someone-else", input().snapshotId], [session.id, "snap:wrong"]] as const) {
      assert.equal(certifyRecommendation(sid, { ...input(), snapshotId }).state, "UNAVAILABLE");
    }
  });
  it("expired routes and a return forecast for a different visit instant are refused", () => {
    const stale = certifyRecommendation(session.id, { ...input(), routing: { ...routed, expiresAt: iso(-1) } });
    assert.ok(stale.failureModes.includes("route_expired"));
    const different = { ...routed, returnContract: { ...routed.returnContract!, route: { ...routed.returnContract!.route, departAt: iso(70) } } };
    assert.ok(certifyRecommendation(session.id, { ...input(), routing: different }).failureModes.includes("return_route_unmeasured"));
  });
  it("a live refusal is visible but never available, even when the static clock fits", () => {
    const row = recommendationSpecColumns({ ...input(), liveBlocked: true });
    const served = servedStatusOf(row, { nowMs: NOW });
    assert.equal(served?.available, false); assert.equal(served?.status, "BLOCKED");
    assert.ok(served?.contract?.failureModes.includes("live_access_refused"));
  });
  it("airside experiences need no landside route and use the gate cutoff", () => {
    const c = certifyRecommendation(session.id, input(true));
    assert.equal(c.state, "READY"); assert.equal(c.estimatedArrival, iso(0)); assert.equal(c.expectedAirportReturn, iso(30));
    assert.equal(c.hardReturnBy, new Date(record.deadline.cutoffMs).toISOString());
    assert.equal(c.fallbackPlan.duringExperience, "remain_airside"); assert.equal(c.fallbackPlan.returnRoute, null);
    assert.equal(c.itinerary.length, 1);
  });
  it("persisted JSON projection strips unknown private fields and refuses malformed contracts", () => {
    const c = certifyRecommendation(session.id, input());
    const projected = servedRecommendationContract({ ...c, lat: 25, privateNote: "secret", fallbackPlan: { ...c.fallbackPlan, travelerId: "secret" } });
    assert.deepEqual(projected, c); assert.equal(servedRecommendationContract({ ...c, estimatedArrival: "invalid" }), null);
  });
  it("objective uses actual return asymmetry, transfer complexity and stated preference after safety", () => {
    const i = input(); const t = objectiveTerms(i.card, { keyOf: () => i.key, preferences: session.vibeChips, routing: new Map([[i.key, routed]]) });
    assert.equal(t.stress.state, "KNOWN"); assert.equal(t.experience_density.state, "KNOWN"); assert.equal(t.preference_fit.state, "KNOWN");
    assert.equal(t.monetary_cost.state, "UNKNOWN"); assert.equal(t.social_value.state, "UNKNOWN");
    if (t.return_risk.state === "KNOWN") assert.match(t.return_risk.provenance, /return 50/); else assert.fail("real return term lost");
    const worse = objectiveTerms(i.card, { keyOf: () => i.key, routing: new Map([[i.key, { ...routed, signals: { ...routed.signals!, transferCount: 3, fragileCorridor: true, nonInterruptible: true } }]]) });
    assert.ok(t.stress.state === "KNOWN" && worse.stress.state === "KNOWN" && worse.stress.value > t.stress.value);
  });
  it("a failed active-snapshot read cannot leave a classified card available", async () => {
    const row = { ...recommendationSpecColumns(input(true)), snapshot_id: input().snapshotId, expires_at: new Date(Date.now() + MIN).toISOString() };
    const db = makeLayoverDb({ feature_flags: [{ flag: "layover_recommendation_status_enabled", enabled: true }] }, { failures: { "layover_sessions:select": { message: "forced failure" } } }) as unknown as SupabaseClient;
    const served = (await storedStatusProjector(db, session.id, [row]))(row);
    assert.equal(served.available, false); assert.equal(served.status, "STALE"); assert.equal(served.statusReason, "snapshot_not_active");
  });
});
