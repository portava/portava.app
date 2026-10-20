import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeSelectedExperiences } from '../services/airport/LayoverExperienceRouting.js';
import type { LayoverFeasibilityRecord } from '../services/airport/LayoverFeasibility.js';
import { bothDirections, measured, unmeasured, type CorridorQuery, type RouteCorridorProvider } from '../lib/providers/routeCorridorProvider.js';

const NOW = Date.parse('2026-10-19T09:00:00.000Z');
const airport = { lat: 25, lng: 121 };
const a = { lat: 25.1, lng: 121.1 };
const b = { lat: 25.2, lng: 121.2 };
const record = { inputs: { nowMs: NOW - 60000, session: { arrivalTime: new Date(NOW - 3600000).toISOString() } }, confidence: 'MEDIUM', deadline: { hardReturnTime: new Date(NOW + 5 * 3600000) }, envelope: { earliestOutTime: new Date(NOW - 60000) } } as LayoverFeasibilityRecord;
function provider(over: { absentAt?: number; fallback?: boolean; expired?: boolean; mismatch?: boolean; minutes?: number } = {}) {
  const asked: CorridorQuery[] = [];
  const p: RouteCorridorProvider = { id: 'fixture', routed: true,
    async corridor(q) {
      asked.push(q);
      if (asked.length === over.absentAt) return { ok: false, provider: 'fixture', reason: 'PROVIDER_REJECTED', detail: 'read cap', envVar: null };
      const minutes = over.minutes ?? (asked.length === 2 ? 37 : 20);
      return { ok: true, value: { from: q.from!, to: q.to!, departAt: new Date(q.departAt.getTime() + (over.mismatch ? 1 : 0)).toISOString(),
        routes: [0, 1].map(() => ({ legs: [{ mode: q.mode ?? 'drive', minutes, distanceMeters: 1000, interruptibility: 'interruptible' as const, transferPointId: null }], totalMinutes: minutes, transferCount: 0 })),
        independentRouteCount: 2, reliability: measured({ spreadMinutes: 0, optionCount: 2 }, 'LIVE', 'MEDIUM', ['fixture']),
        queueFriction: unmeasured('no feed'), weather: unmeasured('no feed'), airportReentryMinutes: unmeasured('no feed'),
        observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + (over.expired ? -1 : 300000)).toISOString(),
        sourceClass: 'LIVE', confidence: 'MEDIUM', sourceRefs: over.fallback ? ['google:routes.v2:fallback:FALLBACK_TRAFFIC_UNAWARE'] : ['fixture'] } };
    }, async bidirectional(q) { return bothDirections(p, q); } };
  return { p, asked };
}
const args = { session: { id: 's', userId: 'u', tripId: null }, record, airportPoint: airport, nowMs: NOW,
  stops: [{ key: 'a', point: a, activityTimeMin: 30 }, { key: 'b', point: b, activityTimeMin: 40 }] };

test('L183 routes each ordered hop at its actual future departure, including final return', async () => {
  const { p, asked } = provider();
  const answer = await routeSelectedExperiences({ ...args, corridorProvider: p });
  assert.equal(answer.ok, true);
  if (!answer.ok) return;
  assert.equal(asked.length, 3);
  assert.deepEqual(asked.map(q => [q.from, q.to]), [[airport, a], [a, b], [b, airport]]);
  assert.equal(asked[0]!.departAt.getTime(), NOW, 'planning clock, not old snapshot clock');
  assert.equal(asked[1]!.departAt.toISOString(), answer.activities[0]!.leavesAt);
  assert.equal(Date.parse(answer.activities[0]!.leavesAt) - Date.parse(answer.activities[0]!.arrivesAt), 30 * 60000);
  assert.equal(asked[2]!.departAt.toISOString(), answer.activities[1]!.leavesAt);
  assert.equal(answer.hops[1]!.minutes, 37, 'actual between-stop answer, not airport-place time');
  assert.ok(answer.returnLeg!.conservativeMinutes > answer.returnLeg!.minutes);
  assert.equal(answer.returnLeg!.hardReturnBy, record.deadline.hardReturnTime.toISOString());
  assert.equal(answer.expiresAt, new Date(NOW + 300000).toISOString());
  assert.doesNotMatch(JSON.stringify(answer), /\"lat\"|\"lng\"/);
});
test('an unavailable middle hop stops compilation with its named absence', async () => {
  const { p, asked } = provider({ absentAt: 2 });
  const answer = await routeSelectedExperiences({ ...args, corridorProvider: p });
  assert.deepEqual(answer, { ok: false, reason: 'PROVIDER_REJECTED', atKey: 'b' });
  assert.equal(asked.length, 2);
});
test('stale, mismatched and unforecast corridors cannot yield a plan', async () => {
  for (const [over, reason] of [[{ expired: true }, 'route_stale'], [{ mismatch: true }, 'PROVIDER_MALFORMED'], [{ fallback: true }, 'return_forecast_unavailable']] as const) {
    const answer = await routeSelectedExperiences({ ...args, corridorProvider: provider(over).p });
    assert.equal(answer.ok, false); if (!answer.ok) assert.equal(answer.reason, reason);
  }
});
test('a slow real chain refuses against the same hard return time', async () => {
  const answer = await routeSelectedExperiences({ ...args, corridorProvider: provider({ minutes: 120 }).p });
  assert.equal(answer.ok, false); if (!answer.ok) assert.equal(answer.reason, 'return_deadline_exceeded');
});
test('airside prefix and suffix share the airport; re-exit after re-entry is not assumed', async () => {
  const { p, asked } = provider();
  const inside = { key: 'lounge', point: null, insideAirport: true, activityTimeMin: 10 };
  const result = await routeSelectedExperiences({ ...args, corridorProvider: p, stops: [inside, args.stops[0]!, { ...inside, key: 'gate' }] });
  assert.equal(result.ok, true);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1]!.to, airport);
  const refused = await routeSelectedExperiences({ ...args, corridorProvider: p, stops: [args.stops[0]!, inside, args.stops[1]!] });
  assert.deepEqual(refused, { ok: false, reason: 'mixed_airside_sequence_unverified', atKey: 'b' });
});
test('missing position or unstated activity duration spends nothing', async () => {
  const { p, asked } = provider();
  for (const stop of [{ key: 'x', point: null, activityTimeMin: 30 }, { key: 'x', point: a, activityTimeMin: 0 }]) {
    assert.equal((await routeSelectedExperiences({ ...args, corridorProvider: p, stops: [stop] })).ok, false);
  }
  assert.equal(asked.length, 0);
});
test('all-airside needs no coordinate or route; its deadline is the boarding cutoff', async () => {
  const { p, asked } = provider();
  const cutoffMs = NOW + 20 * 60000;
  const answer = await routeSelectedExperiences({ ...args, record: { ...record, deadline: { ...record.deadline, cutoffMs } },
    airportPoint: null, corridorProvider: p, stops: [{ key: 'lounge', point: null, insideAirport: true, activityTimeMin: 15 }] });
  assert.equal(answer.ok, true); if (!answer.ok) return;
  assert.equal(answer.hardReturnBy, new Date(cutoffMs).toISOString());
  assert.equal(answer.returnLeg, null);
  assert.equal(answer.expiresAt, null, 'no fabricated provider expiry for an unrouted itinerary');
  assert.equal(asked.length, 0);
});
test('before arrival an airside itinerary begins only once the inbound flight arrives', async () => {
  const arrivalTime = new Date(NOW + 60 * 60000).toISOString();
  const answer = await routeSelectedExperiences({ ...args, record: { ...record, inputs: { ...record.inputs, session: { ...record.inputs.session, arrivalTime } }, deadline: { ...record.deadline, cutoffMs: NOW + 3 * 3600000 } },
    airportPoint: null, stops: [{ key: 'lounge', point: null, insideAirport: true, activityTimeMin: 15 }] });
  assert.equal(answer.ok, true); if (!answer.ok) return;
  assert.equal(answer.departAt, arrivalTime);
  assert.equal(answer.activities[0]!.arrivesAt, arrivalTime);
});
