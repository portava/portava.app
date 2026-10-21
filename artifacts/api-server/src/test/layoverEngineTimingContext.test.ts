import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifySessionFeasibility, certifyFeasibility, recomputeFeasibility, type FeasibilityAirport, type FeasibilitySession } from '../services/airport/LayoverFeasibility.js';
import { estimateExitDelay, estimateExitComponents } from '../services/airport/LayoverSafetyEngine.js';
const nowMs = Date.parse('2030-06-14T09:00:00Z');
const airport: FeasibilityAirport = { id: 'tpe', iataCode: 'TPE', timezone: 'Asia/Taipei', verified: true, lat: 25.0797, lng: 121.2342,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 };
const session: FeasibilitySession = { id: 's', arrivalTime: '2030-06-14T08:00:00Z', departureTime: '2030-06-14T20:00:00Z', boardingTime: null, flightType: 'international', immigrationRequired: true, checkedBags: true, wantsToLeave: true };

test('exit timing separates deplane, immigration, baggage and exit friction as explicit assumptions without changing the total', () => {
  for (const flightType of ['international', 'domestic'] as const) for (const immigrationRequired of [false, true]) for (const checkedBags of [false, true]) {
    const s = { ...session, flightType, immigrationRequired, checkedBags };
    const c = estimateExitComponents(s);
    assert.equal(c.baggageClaim, checkedBags ? 20 : 0);
    assert.equal(c.arrivalImmigration, flightType === 'international' && immigrationRequired ? 20 : 0);
    assert.equal(c.deplane + c.arrivalImmigration + c.baggageClaim + c.exitFriction, estimateExitDelay(s));
    const r = certifySessionFeasibility(airport, s, { nowMs });
    for (const key of ['deplane', 'arrivalImmigration', 'baggageClaim', 'exitFriction'] as const) {
      assert.equal(r.estimates[key].valueMinutes, c[key]);
      assert.equal(r.estimates[key].sourceClass, 'STATIC_DEFAULT');
      assert.equal(r.estimates[key].confidence, 'LOW');
      assert.equal(r.estimates[key].observedAt, null);
    }
  }
});

test('the actual named airport location reaches the generalized origin and destination and is replayable', () => {
  const r = certifySessionFeasibility(airport, session, { nowMs });
  assert.deepEqual(r.envelope.freedomWindow?.origin?.point, { lat: airport.lat, lng: airport.lng });
  assert.deepEqual(r.envelope.freedomWindow?.requiredDestination?.point, { lat: airport.lat, lng: airport.lng });
  assert.ok(!r.envelope.freedomWindow?.hardConstraints.some(c => c.kind === 'NO_ORIGIN'));
  assert.deepEqual(r, certifyFeasibility(r.inputs));
  const moved = { ...r.inputs, airport: { ...r.inputs.airport, lat: 24, lng: 120 } };
  const incremental = recomputeFeasibility(r, moved);
  assert.deepEqual(incremental, certifyFeasibility(moved));
  assert.deepEqual(incremental.envelope.freedomWindow?.origin?.point, { lat: 24, lng: 120 });
});

test('missing or invalid airport positions stay unknown; coordinate projection never invents a current GPS fix', () => {
  for (const pos of [{ lat: null, lng: null }, { lat: NaN, lng: 121 }, { lat: 95, lng: 121 }]) {
    const r = certifySessionFeasibility({ ...airport, ...pos }, session, { nowMs });
    assert.equal(r.envelope.freedomWindow?.origin?.point, null);
    assert.ok(r.envelope.freedomWindow?.hardConstraints.some(c => c.kind === 'NO_ORIGIN'));
  }
});
