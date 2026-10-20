import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifySessionFeasibility, certifyFeasibility, type FeasibilityAirport, type FeasibilitySession } from '../services/airport/LayoverFeasibility.js';
import { constrainFreedomWindow } from '../domain/temporal/TemporalFreedomPolicy.js';
import { replayDecision } from '../services/airport/layoverReplay.js';
import { decisionRecordFor } from '../services/airport/layoverLedger.js';
const nowMs = Date.parse('2030-06-14T09:00:00Z');
const airport: FeasibilityAirport = { id: 'tpe', iataCode: 'TPE', timezone: 'Asia/Taipei', verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 };
const session: FeasibilitySession = { id: 's', arrivalTime: '2030-06-14T08:00:00Z', departureTime: '2030-06-14T20:00:00Z', boardingTime: null,
  flightType: 'international', immigrationRequired: true, checkedBags: false, wantsToLeave: true, comfortLevel: 'safe_only', vibeChips: ['food', 'quiet'] };
test('the real adapter carries supplied preferences and explicit non-probabilistic risk and uncertainty budgets', () => {
  const r = certifySessionFeasibility(airport, session, { nowMs });
  const w = r.envelope.freedomWindow!;
  assert.deepEqual(w.riskBudget, { maxLatenessMinutes: 0, unsafeActionsPermitted: false });
  assert.ok(w.softConstraints?.some(p => p.key === 'comfortLevel' && p.value === 'safe_only'));
  assert.ok(w.softConstraints?.some(p => p.key === 'vibe' && p.value === 'quiet'));
  assert.equal(w.uncertaintyBudget?.basis, 'policy_reserve');
  assert.ok(w.uncertaintyBudget!.reservedMinutes > 0);
  assert.ok(w.usableMinutes! <= r.envelope.usableMinutes);
  assert.deepEqual(r, certifyFeasibility(r.inputs));
  assert.notEqual(r.inputHash, certifySessionFeasibility(airport, { ...session, vibeChips: ['art'] }, { nowMs }).inputHash);
  const tighter = { ...r.inputs, freedomPolicy: { ...r.inputs.freedomPolicy!, uncertaintyShares: { ...r.inputs.freedomPolicy!.uncertaintyShares, LOW: .75 } } };
  const changed = certifyFeasibility(tighter);
  assert.notEqual(changed.inputHash, r.inputHash);
  assert.ok(changed.envelope.freedomWindow!.usableMinutes! <= w.usableMinutes!);
});
test('risk and uncertainty policy can only narrow a computed freedom window', () => {
  const r = certifySessionFeasibility(airport, session, { nowMs }); const w = r.envelope.freedomWindow!;
  const base = { maxLatenessMinutes: 0, unsafeActionsPermitted: false as const, uncertaintyShare: 0, softConstraints: [] };
  const small = constrainFreedomWindow(w, { ...base, uncertaintyShare: .1 }, nowMs);
  const larger = constrainFreedomWindow(w, { ...base, uncertaintyShare: .5 }, nowMs);
  assert.ok(larger.usableMinutes! < small.usableMinutes!);
  for (const maxLatenessMinutes of [-5, 0, 90, NaN]) {
    const x = constrainFreedomWindow(w, { ...base, maxLatenessMinutes }, nowMs);
    assert.ok(Date.parse(x.endsAt) <= Date.parse(w.endsAt));
    assert.ok(x.usableMinutes! <= w.usableMinutes!);
    assert.equal(x.riskBudget?.unsafeActionsPermitted, false);
  }
});
test('historical inputs lacking the named policy are refused by shape version; current identities replay reproducibly', () => {
  const r = certifySessionFeasibility(airport, session, { nowMs });
  const decision = decisionRecordFor('s', r);
  const oldInputs = { ...r.inputs, feasibilityVersion: '2026.10.06-1' }; delete oldInputs.freedomPolicy;
  const old = replayDecision({ sessionId: 's', inputs: oldInputs, decision });
  assert.equal(old.status, 'refused'); assert.equal(old.refusal, 'RECORD_SHAPE_CHANGED');
  const fresh = replayDecision({ sessionId: 's', inputs: JSON.parse(JSON.stringify(r.inputs)), decision });
  assert.equal(fresh.status, 'match');
  assert.equal(certifyFeasibility(JSON.parse(JSON.stringify(r.inputs))).inputHash, r.inputHash);
});
