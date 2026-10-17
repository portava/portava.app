import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateRiskTriggers,
  RISK_MITIGATIONS,
  type RiskTriggerInputs,
} from "../domain/trips/services/TripRiskTriggers.js";

function fixture(): RiskTriggerInputs {
  return {
    now: Date.parse("2026-10-16T12:00:00.000Z"),
    commitments: [],
    plans: [{
      id: "dinner", title: "Dinner", startsAt: "2026-10-16T15:00:00.000Z",
      endsAt: null, weatherSensitive: false, partySize: 6, participantIds: ["attending-member"],
    }],
    transport: [{
      id: "taxi", mode: "taxi", state: "booked", plannedDepartureAt: "2026-10-16T14:00:00.000Z",
      partySize: 6, capacity: null, servesId: "dinner",
    }],
    signals: [],
    crewSize: 6,
  };
}

function transportRisk(inputs: RiskTriggerInputs) {
  return evaluateRiskTriggers(inputs).find((trigger) => trigger.kind === "crew_transport_mismatch")!;
}

describe("transport capacity risk follows the segment lifecycle", () => {
  for (const state of ["cancelled", "CANCELLED"]) {
    for (const partySource of ["segment", "plan", "crew"]) {
      it(`${state} clears the risk and recipients with the ${partySource} party size`, () => {
        const inputs = fixture();
        const segment = inputs.transport[0]!;
        if (partySource !== "segment") segment.partySize = null;
        if (partySource === "crew") segment.servesId = null;

        const before = transportRisk(inputs);
        assert.equal(before.fired, true);
        assert.equal(before.magnitude, 2);
        assert.deepEqual(before.affectedIds, ["taxi"]);

        segment.state = state;
        const after = transportRisk(inputs);
        assert.equal(after.fired, false);
        assert.equal(after.magnitude, null);
        assert.deepEqual(after.affectedIds, []);
        assert.deepEqual(after.participantIds, []);
        assert.equal(after.mitigation, RISK_MITIGATIONS.crew_transport_mismatch);
      });
    }
  }

  for (const state of ["planned", "booked", "waiting", "in_progress", "disrupted"]) {
    it(`${state} still reports an over-capacity upcoming segment`, () => {
      const inputs = fixture();
      inputs.transport[0]!.state = state;
      const trigger = transportRisk(inputs);
      assert.equal(trigger.fired, true);
      assert.equal(trigger.magnitude, 2);
      assert.deepEqual(trigger.affectedIds, ["taxi"]);
      assert.deepEqual(trigger.participantIds, ["attending-member"]);
    });
  }

  for (const state of ["completed", "COMPLETED"]) {
    it(`${state} remains excluded even when its planned departure is still future`, () => {
      const inputs = fixture();
      inputs.transport[0]!.state = state;
      const trigger = transportRisk(inputs);
      assert.equal(trigger.fired, false);
      assert.equal(trigger.magnitude, null);
      assert.deepEqual(trigger.affectedIds, []);
      assert.deepEqual(trigger.participantIds, []);
    });
  }

  it("a cancelled larger party cannot inflate the live risk or add recipients", () => {
    const inputs = fixture();
    inputs.plans.push({
      id: "old-plan", title: "Old plan", startsAt: "2026-10-16T15:00:00.000Z",
      endsAt: null, weatherSensitive: false, partySize: 30, participantIds: ["cancelled-member"],
    });
    inputs.transport.push({
      id: "cancelled-taxi", mode: "taxi", state: "cancelled", plannedDepartureAt: "2026-10-16T13:00:00.000Z",
      partySize: null, capacity: 4, servesId: "old-plan",
    });

    const trigger = transportRisk(inputs);
    assert.equal(trigger.fired, true);
    assert.equal(trigger.magnitude, 2);
    assert.deepEqual(trigger.affectedIds, ["taxi"]);
    assert.deepEqual(trigger.participantIds, ["attending-member"]);
    assert.equal(trigger.evidence, "1 segment(s) carry a party 2 over the vehicle's seats");
  });
});
