import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuousWalkingCoverage, coverageGeometry, walkingCoverageBudget } from '../services/airport/LayoverContinuousCoverage.js';
import { certifySessionFeasibility } from '../services/airport/LayoverFeasibility.js';
import { withRoutesRequestBudget, currentRoutesRequestBudget } from '../domain/trips/contracts/RoutesRequestBudget.js';
const NOW = Date.parse('2030-06-14T09:00:00Z');
const record = certifySessionFeasibility({ id: 'test', iataCode: 'SIN', timezone: 'Asia/Singapore', verified: true, domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 },
  { id: 's', arrivalTime: '2030-06-14T08:00:00Z', departureTime: '2030-06-14T20:00:00Z', boardingTime: null, flightType: 'international', immigrationRequired: true, checkedBags: false, wantsToLeave: true, comfortLevel: 'safe_only' }, { nowMs: NOW });
const ring = (x: number, y: number, s: number) => [[x,y],[x+s,y],[x+s,y+s],[x,y+s],[x,y]];
const geometry = { type: 'MultiPolygon', coordinates: [[ring(103.9, 1.3, .1), ring(103.94, 1.34, .01)], [ring(104.1, 1.3, .02)]] };
const readEnv = (n: string) => n === 'LAYOVER_GOOGLE_ISOCHRONES_ENABLED' ? 'true' : n === 'GOOGLE_ISOCHRONES_API_KEY' ? 'fixture-key' : undefined;
const base = { record, airport: { lat: 1.35, lng: 103.98 }, landsideAllowed: true, dwellMinutes: 30, readEnv, now: () => new Date(NOW) };
const scope = { userId: 'u', layoverSessionId: 's' };
test('budget is a round trip plus dwell and conservative uncertainty, and lower confidence never expands it', () => {
  for (const usable of [35, 60, 120, 240, 600]) for (const confidence of ['HIGH', 'MEDIUM', 'LOW']) {
    const b = walkingCoverageBudget(usable, 30, confidence); if (!b) continue;
    assert.ok(b.outbound + b.conservativeBack + 30 <= usable); assert.ok(b.back <= 120); assert.ok(b.conservativeBack > b.back);
  }
  assert.ok(walkingCoverageBudget(120, 30, 'LOW')!.outbound <= walkingCoverageBudget(120, 30, 'HIGH')!.outbound);
  assert.equal(walkingCoverageBudget(120, 30, 'INSUFFICIENT'), null);
});
test('actual bidirectional contract charges two calls, requests unsmoothed WALK, and preserves holes and islands', async () => {
  const requests: any[] = []; let charged = 0;
  const result = await withRoutesRequestBudget(scope, () => continuousWalkingCoverage({ ...base, spendGate: { decide: async () => { charged++; return 'granted'; } },
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ isochrone: { geoJson: geometry } }), { status: 200 }); } }));
  assert.equal(result.state, 'available', JSON.stringify(result)); if (result.state !== 'available') return;
  assert.equal(charged, 2); assert.deepEqual(requests.map(x => x.travelDirection), ['FROM', 'TO']);
  assert.ok(requests.every(x => x.travelMode === 'WALK' && x.enableSmoothing === false && x.polygonFidelity === 'HIGH' && !('departureTime' in x)));
  assert.equal(result.geometry.coordinates.length, 2); assert.equal(result.geometry.coordinates[0]!.length, 2);
  assert.ok(result.outboundBudgetMinutes + result.conservativeReturnMinutes + result.dwellMinutes <= result.usableMinutes);
});
test('two contours are intersected rather than unioned or replaced by their convex hull', async () => {
  let call = 0;
  const result = await withRoutesRequestBudget(scope, () => continuousWalkingCoverage({ ...base, spendGate: { decide: async () => 'granted' }, fetchImpl: async () => new Response(JSON.stringify({ isochchrone: null, isochrone: { geoJson: { type: 'Polygon', coordinates: [ring(call++ ? 103.95 : 103.9, 1.3, .1)] } } }), { status: 200 }) }));
  assert.equal(result.state, 'available'); if (result.state !== 'available') return;
  const xs = result.geometry.coordinates.flat(2).map(p => p[0]); assert.ok(Math.min(...xs) >= 103.95); assert.ok(Math.max(...xs) <= 104.000000001);
});
test('default-off, unscoped, future drive, closed landside and one remaining call make no provider request', async () => {
  let called = 0; const fetchImpl: typeof fetch = async () => { called++; throw new Error('must not fetch'); };
  const off = await continuousWalkingCoverage({ ...base, fetchImpl, readEnv: () => undefined }); assert.deepEqual(off, { state: 'unavailable', reason: 'isochrones_not_configured' });
  assert.equal((await continuousWalkingCoverage({ ...base, fetchImpl })).state, 'unavailable');
  for (const over of [{ mode: 'drive' as const }, { landsideAllowed: false }, {}]) await withRoutesRequestBudget(scope, () => continuousWalkingCoverage({ ...base, ...over, fetchImpl }), { maxCalls: 1 });
  assert.equal(called, 0);
});
test('second spend refusal and malformed provider response cannot produce partial coverage', async () => {
  let charged = 0, fetched = 0;
  const r = await withRoutesRequestBudget(scope, () => continuousWalkingCoverage({ ...base, spendGate: { decide: async () => ++charged === 2 ? 'budget_exhausted' : 'granted' }, fetchImpl: async () => { fetched++; return new Response(JSON.stringify({ isochrone: { geoJson: geometry } }), { status: 200 }); } }));
  assert.deepEqual(r, { state: 'unavailable', reason: 'isochrone_spend_budget_exhausted' }); assert.equal(fetched, 1);
  const bad = await withRoutesRequestBudget(scope, () => continuousWalkingCoverage({ ...base, spendGate: { decide: async () => 'granted' }, fetchImpl: async () => new Response(JSON.stringify({ isochrone: { geoJson: { type: 'Polygon', coordinates: [] } } })) }));
  assert.deepEqual(bad, { state: 'unavailable', reason: 'isochrone_geometry_invalid' });
});
test('the same request counter is shared with routes and never reset by coverage', async () => {
  await withRoutesRequestBudget(scope, async () => {
    currentRoutesRequestBudget()!.counter.attempts = 11;
    const r = await continuousWalkingCoverage({ ...base, fetchImpl: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(r, { state: 'unavailable', reason: 'isochrone_two_call_budget_unavailable' });
    assert.equal(currentRoutesRequestBudget()!.counter.attempts, 11);
  }, { maxCalls: 12 });
  assert.equal(coverageGeometry({ type: 'Polygon', coordinates: [[[0,0],[1,0],[1,1],[0,1]]] }), null, 'unclosed rings cannot be certified');
});

import { routeLayoverCandidates } from '../services/airport/LayoverRoutedFeasibility.js';
import { createGoogleRoutesCorridorProvider } from '../lib/providers/googleRoutesCorridorProvider.js';
test('the actual routed pass reserves two of twelve calls for coverage, then publishes its response geometry', async()=>{
  let routeCalls=0, contourCalls=0;
  const provider=createGoogleRoutesCorridorProvider({memo:true,readEnv:n=>n==='LAYOVER_ROUTED_CORRIDOR_ENABLED'?'true':n==='GOOGLE_MAPS_API_KEY'?'fixture-key':undefined,now:()=>new Date(NOW),layoverSpendGate:{decide:async()=> 'granted'},
    fetchImpl:async()=>{routeCalls++;return new Response(JSON.stringify({routes:[{duration:'300s',legs:[{steps:[{travelMode:'WALK',staticDuration:'300s',distanceMeters:500}]}]}]}));}});
  await withRoutesRequestBudget(scope,async()=>{
    const result=await routeLayoverCandidates({record,airport:base.airport,landsideAllowed:true,outerBound:null,corridorProvider:provider,
      candidates:Array.from({length:6},(_,i)=>({key:`c${i}`,point:{lat:1.351+i*.0003,lng:103.981},minExperienceMin:30})),
      coverageOptions:{readEnv,now:()=>new Date(NOW),spendGate:{decide:async()=> 'granted'},fetchImpl:async()=>{contourCalls++;return new Response(JSON.stringify({isochrone:{geoJson:geometry}}));}} });
    assert.equal(result.summary.routed,5);assert.equal(result.byKey.get('c5')?.prefilter,'candidate_cap');
    assert.equal(result.envelope?.continuous?.state,'available');assert.equal(currentRoutesRequestBudget()!.counter.attempts,12);
  },{maxCalls:12});
  assert.equal(routeCalls,10);assert.equal(contourCalls,2);
});
