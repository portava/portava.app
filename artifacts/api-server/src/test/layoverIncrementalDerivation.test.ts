import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifyFeasibility, feasibilityInputs, recomputeFeasibility, feasibilityDerivationTrace, type FeasibilityAirport, type FeasibilitySession } from '../services/airport/LayoverFeasibility.js';
import { NO_LIVE_CONDITIONS } from '../services/airport/LayoverSafetyEngine.js';
import { handleEvent, normalizeEvent } from '../services/airport/LayoverEventReplanner.js';

const NOW = Date.parse('2030-06-14T09:00:00Z');
const airport: FeasibilityAirport = { id: 'airport-tpe', iataCode: 'TPE', timezone: 'Asia/Taipei', verified: true,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 };
const session: FeasibilitySession = { id: 'session-1', arrivalTime: '2030-06-14T08:00:00Z', departureTime: '2030-06-14T20:00:00Z', boardingTime: null,
  flightType: 'international', immigrationRequired: true, checkedBags: false, wantsToLeave: true };
const inputs = () => feasibilityInputs(airport, session, { nowMs: NOW, liveConditions: { ...NO_LIVE_CONDITIONS } });

test('a changed queue recomputes affected nodes and reuses unrelated derivations; full replay is identical', () => {
  const before = certifyFeasibility(inputs());
  const changed = { ...before.inputs, liveConditions: { ...NO_LIVE_CONDITIONS, securityWaitExtraMin: 23 } };
  const after = recomputeFeasibility(before, changed);
  const trace = feasibilityDerivationTrace(after)!;
  assert.ok(trace.recomputed.includes('buffer.liveExtra'));
  assert.ok(trace.recomputed.includes('deadline'));
  assert.ok(trace.recomputed.includes('envelope'));
  for (const id of ['buffer.baseBuffer', 'buffer.immigrationExtra', 'buffer.bagsExtra', 'buffer.trafficExtra', 'buffer.timeOfDayExtra', 'buffer.returnTransportExtra', 'exitDelay']) {
    assert.ok(trace.reused.includes(id), id);
    assert.ok(!trace.recomputed.includes(id), id);
  }
  assert.deepEqual(after, certifyFeasibility(changed));
  assert.equal(before.deadline.breakdown.liveExtra, 0);
  assert.equal(after.deadline.breakdown.liveExtra, 23);
});

test('incremental schedule, entry, bags and clock edits equal a fresh certification without trusting a supplied node list', () => {
  let previous = certifyFeasibility(inputs());
  for (const delta of [
    { session: { ...session, arrivalTime: '2030-06-14T09:30:00Z' } },
    { session: { ...session, departureTime: '2030-06-14T19:00:00Z', checkedBags: true } },
    { nowMs: NOW + 9 * 60 * 60000 },
    { entry: { state: 'unresolved' as const, reason: 'no_passport_on_file' as const } },
  ]) {
    const next = { ...previous.inputs, ...delta };
    const incremental = recomputeFeasibility(previous, next);
    assert.deepEqual(incremental, certifyFeasibility(next));
    previous = incremental;
  }
});

test('callers cannot poison reusable node values by changing a prior returned record', () => {
  const before = certifyFeasibility(inputs());
  before.deadline.breakdown.baseBuffer = -10000;
  before.envelope.usableMinutes = 10000;
  const after = recomputeFeasibility(before, inputs());
  assert.deepEqual(after, certifyFeasibility(inputs()));
  const copied = structuredClone(before);
  const untrusted = recomputeFeasibility(copied, inputs());
  assert.equal(feasibilityDerivationTrace(untrusted)!.reused.length, 0);
  assert.deepEqual(untrusted, certifyFeasibility(inputs()));
});

test('reachable event pipeline uses incremental derivation after an observed security change', () => {
  const event = normalizeEvent({ eventId: 'queue-1', eventType: 'airport.security_wait_changed', source: 'test', sourceEventId: 'queue-1', occurredAt: new Date(NOW).toISOString(), subjectRefs: [{ kind: 'airport', ref: 'TPE' }], payload: { waitMinutes: 40 } }, { receivedAtMs: NOW });
  assert.ok(event.ok);
  const result = handleEvent(event.event, { airport, sessions: [{ session, airportRef: 'TPE', status: 'active' }], candidates: {}, nowMs: NOW });
  const after = result.replanned[0]!.after;
  assert.ok(feasibilityDerivationTrace(after)!.reused.includes('buffer.baseBuffer'));
  assert.equal(after.deadline.breakdown.liveExtra, 40);
  assert.deepEqual(after, certifyFeasibility(after.inputs));
});
