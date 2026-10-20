import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeLayoverCandidates, routedCardContract } from '../services/airport/LayoverRoutedFeasibility.js';
import type { LayoverFeasibilityRecord } from '../services/airport/LayoverFeasibility.js';
import { bothDirections, measured, unmeasured, type CorridorQuery, type RouteCorridorProvider } from '../lib/providers/routeCorridorProvider.js';
import { createGoogleRoutesCorridorProvider, CREDENTIAL_ENV, ENABLEMENT_ENV } from '../lib/providers/googleRoutesCorridorProvider.js';
import { withLayoverRoutesBudget } from '../services/airport/LayoverTravelTime.js';

const NOW = Date.parse('2026-10-19T09:00:00Z');
const airport = { lat: 25, lng: 121 }, point = { lat: 25.1, lng: 121.1 };
const record = { inputs: { nowMs: NOW }, confidence: 'MEDIUM', deadline: { hardReturnTime: new Date(NOW + 5 * 3600000) }, envelope: { earliestOutTime: new Date(NOW), usableMinutes: 300 } } as LayoverFeasibilityRecord;
function provider(transit: 'measured' | 'refused' | 'expired' = 'measured') {
  const asked: CorridorQuery[] = [];
  const p: RouteCorridorProvider = { id: 'transit-fixture', routed: true,
    async corridor(q) {
      asked.push(q);
      if (q.mode === 'transit' && transit === 'refused') return { ok: false, provider: 'fixture', reason: 'PROVIDER_REJECTED', detail: 'request_hop_cap', envVar: null };
      const rail = q.mode === 'transit';
      const minutes = rail ? 12 : q.to?.lat === airport.lat ? 80 : 20;
      return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(),
        routes: [{ totalMinutes: minutes, transferCount: rail ? 2 : 0, legs: Array.from({ length: rail ? 3 : 1 }, (_,i) => ({ mode: rail ? 'transit' as const : 'drive' as const, minutes: minutes / (rail ? 3 : 1), distanceMeters: 5000, interruptibility: rail ? 'committed' as const : 'interruptible' as const, transferPointId: rail && i < 2 ? `station${i}` : null })) }],
        independentRouteCount: 1, reliability: measured({ spreadMinutes: 0, optionCount: 1 }, 'LIVE', 'MEDIUM', ['fixture']),
        queueFriction: unmeasured('no feed'), weather: unmeasured('no feed'), airportReentryMinutes: unmeasured('no feed'),
        observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + (rail && transit === 'expired' ? -1 : 300000)).toISOString(),
        sourceClass: 'LIVE', confidence: 'MEDIUM', sourceRefs: ['fixture'] } };
    }, async bidirectional(q) { return bothDirections(p, q); } };
  return { p, asked };
}
async function evaluate(option: 'measured' | 'refused' | 'expired') {
  const fixture = provider(option);
  const result = await routeLayoverCandidates({ record, airport, landsideAllowed: true, outerBound: null, corridorProvider: fixture.p, candidates: [{ key: 'place', point, minExperienceMin: 45 }] });
  return { ...fixture, result: result.candidates[0]! };
}
test('L71 asks an additional future transit return and applies actual transfer/committed margins', async () => {
  const { asked, result } = await evaluate('measured');
  const transit = asked.find(q => q.mode === 'transit');
  assert.ok(transit, 'production evaluation must actually ask transit');
  assert.deepEqual(transit.from, point); assert.deepEqual(transit.to, airport);
  assert.equal(transit.departAt.getTime(), NOW + 65 * 60000);
  assert.equal(result.terms?.robustness.transferCount, 2);
  assert.equal(result.terms?.robustness.transferMinutes, 10);
  assert.equal(result.terms?.robustness.nonInterruptibleMinutes, 5);
  assert.equal(result.terms?.confidence, 'LOW');
  assert.equal(routedCardContract(result)?.returnContract?.route.mode, 'transit');
});
test('unsupported or expired transit cannot remove the independently measured drive return', async () => {
  for (const option of ['refused', 'expired'] as const) {
    const { result } = await evaluate(option);
    assert.equal(result.terms?.returnMinutes, 80);
    assert.equal(routedCardContract(result)?.returnContract?.route.mode, 'drive');
  }
});
test('real Google adapter sends a third TRANSIT query at the future return time under the layover budget', async () => {
  const bodies: Array<Record<string, any>> = [];
  let charged = 0;
  const google = createGoogleRoutesCorridorProvider({ now: () => new Date(NOW), memo: true,
    readEnv: n => n === CREDENTIAL_ENV ? 'test-key' : n === ENABLEMENT_ENV ? 'true' : undefined,
    layoverSpendGate: { async decide() { charged++; return 'granted'; } },
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const name = body.travelMode === 'TRANSIT' ? 'transit-return.json' : body.destination.location.latLng.latitude === airport.lat ? 'drive-alternatives-return.json' : 'drive-alternatives-outbound.json';
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(new URL(`./fixtures/googleRoutes/${name}`, import.meta.url), 'utf8')) } as Response;
    }) as typeof fetch });
  await withLayoverRoutesBudget({ id: 's', userId: 'u', tripId: null }, () => routeLayoverCandidates({ record, airport, landsideAllowed: true, outerBound: null, corridorProvider: google, candidates: [{ key: 'place', point, minExperienceMin: 45 }] }));
  assert.equal(charged, 3);
  assert.deepEqual(bodies.map(b => b.travelMode), ['DRIVE', 'DRIVE', 'TRANSIT']);
  assert.equal(bodies[2]!.departureTime, bodies[1]!.departureTime);
  assert.equal(bodies[2]!.computeAlternativeRoutes, true);
  assert.equal('routingPreference' in bodies[2]!, false, 'Google transit query has no DRIVE-only traffic preference');
});
