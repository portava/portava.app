/**
 * IG-09 Limited-Live gating — the §26 density gate as a pure promotion criterion,
 * the emergency-stop / pilot combination, and the two non-trivial gate inputs
 * (ordinal calibration accuracy, expiry correctness).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DENSITY_GATE_V1, evaluateDensityGate, densityGateMet, mayExposeLive, scopeKey,
  type PilotDensityMetrics,
} from "../lib/intelLiveScope.js";
import {
  computeCrowdCalibrationAccuracy, computeExpiryCorrectness, assemblePilotMetrics,
} from "../lib/intelPilotMetrics.js";

/** A metrics fixture that clears every threshold. */
const PASSING: PilotDensityMetrics = {
  activeReliableContributorsCitywide: 20,
  minContributorsPerCluster: 3,
  qualifyingWeeklyObservations: 250,
  minIndependentSourcesPerKeyVenueNight: 3,
  outcomeConfirmations: 100,
  crowdCalibrationAccuracy: 0.75,
  expiryCorrectness: 0.999,
  criticalPrivacyIncidents: 0,
};

describe("IG-09 — density gate (§26)", () => {
  it("passes exactly at the thresholds", () => {
    const r = evaluateDensityGate(PASSING);
    assert.equal(r.met, true);
    assert.deepEqual(r.failures, []);
  });
  it("names the specific threshold that fails, one at a time", () => {
    assert.deepEqual(evaluateDensityGate({ ...PASSING, activeReliableContributorsCitywide: 19 }).failures, ["contributors_citywide"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, minContributorsPerCluster: 2 }).failures, ["contributors_per_cluster"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, qualifyingWeeklyObservations: 249 }).failures, ["weekly_observations"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, minIndependentSourcesPerKeyVenueNight: 2 }).failures, ["independent_sources"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, outcomeConfirmations: 99 }).failures, ["outcome_confirmations"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, crowdCalibrationAccuracy: 0.74 }).failures, ["calibration_accuracy"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, expiryCorrectness: 0.99 }).failures, ["expiry_correctness"]);
    assert.deepEqual(evaluateDensityGate({ ...PASSING, criticalPrivacyIncidents: 1 }).failures, ["privacy_incidents"]);
    assert.equal(DENSITY_GATE_V1.crowdCalibrationAccuracy, 0.75);
  });
});

describe("IG-09 — mayExposeLive combines the pilot flag, the stop, and the gate", () => {
  it("is true only when promoted, not stopped, and the gate is met", () => {
    assert.equal(mayExposeLive(PASSING, { pilotEnabled: true, emergencyStopEngaged: false }), true);
    assert.equal(mayExposeLive(PASSING, { pilotEnabled: true, emergencyStopEngaged: true }), false, "kill wins");
    assert.equal(mayExposeLive(PASSING, { pilotEnabled: false, emergencyStopEngaged: false }), false, "not promoted");
    assert.equal(mayExposeLive({ ...PASSING, outcomeConfirmations: 0 }, { pilotEnabled: true, emergencyStopEngaged: false }), false, "gate not met");
    assert.equal(densityGateMet(PASSING), true);
  });
  it("scopeKey is stable and distinguishes scopes", () => {
    assert.equal(scopeKey({ city: "lis", zone: "z1", claimFamily: "crowd.level" }), scopeKey({ city: "lis", zone: "z1", claimFamily: "crowd.level", cohort: null }));
    assert.notEqual(scopeKey({ city: "lis", zone: "z1", claimFamily: "crowd.level" }), scopeKey({ city: "lis", zone: "z2", claimFamily: "crowd.level" }));
  });
});

describe("IG-09 — calibration + expiry inputs", () => {
  it("ordinal calibration counts within-one-step as correct, off-scale as wrong", () => {
    // busy(3) vs packed(4) is within 1 step → correct; dead(0) vs packed(4) is not.
    const pairs = [
      { predicted: "busy", actual: "packed" },
      { predicted: "moderate", actual: "moderate" },
      { predicted: "dead", actual: "packed" },
      { predicted: "nonsense", actual: "busy" },
    ];
    assert.equal(computeCrowdCalibrationAccuracy(pairs), 2 / 4);
    assert.equal(computeCrowdCalibrationAccuracy([]), 1);
    assert.equal(computeCrowdCalibrationAccuracy([{ predicted: "busy", actual: "packed" }], 0), 0, "tolerance 0 needs exact match");
  });
  it("expiry correctness is the share NOT shown stale", () => {
    assert.equal(computeExpiryCorrectness([]), 1);
    assert.equal(computeExpiryCorrectness([{ shownAfterExpiry: false }, { shownAfterExpiry: false }, { shownAfterExpiry: true }]), 2 / 3);
  });
  it("assemblePilotMetrics takes the weakest cluster/venue", () => {
    const m = assemblePilotMetrics({
      activeReliableContributorsCitywide: 25,
      contributorsPerCluster: [5, 3, 8],
      qualifyingWeeklyObservations: 300,
      independentSourcesPerKeyVenueNight: [4, 3, 6],
      outcomeConfirmations: 120,
      calibrationPairs: [{ predicted: "busy", actual: "busy" }],
      expirySamples: [{ shownAfterExpiry: false }],
      criticalPrivacyIncidents: 0,
    });
    assert.equal(m.minContributorsPerCluster, 3);
    assert.equal(m.minIndependentSourcesPerKeyVenueNight, 3);
    assert.equal(m.crowdCalibrationAccuracy, 1);
    assert.equal(densityGateMet(m), true);
  });
});
