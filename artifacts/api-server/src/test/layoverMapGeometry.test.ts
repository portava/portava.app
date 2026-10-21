import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airportTopologyGeometry, topologyGeometryIssues } from '../services/airport/airportTopologyGeometry.js';
import { validateCuratedFact } from '../services/airport/airportCurationPolicy.js';
import { googleRouteGeometry } from '../lib/providers/providerMapGeometry.js';
import { createGoogleRoutesCorridorProvider, memoisedCorridor } from '../lib/providers/googleRoutesCorridorProvider.js';
import { routedLegOf } from '../services/airport/LayoverReturnCorridor.js';
const NOW = Date.parse('2030-06-14T09:00:00Z');
const point = { lat: 1.35, lng: 103.98 }, point2 = { lat: 1.351, lng: 103.981 };
const topology = { terminals: [{ id: 'T1', name: 'Terminal 1', point }, { id: 'T2', name: 'Terminal 2', point: point2 }],
  gates: [{ terminalId: 'T1', label: 'A1', point }], checkpoints: [{ id: 'security', terminalId: 'T1', kind: 'security', point }],
  walkingLinks: [{ fromTerminalId: 'T1', toTerminalId: 'T2', minutes: 5, mode: 'walk', path: [point, point2] }] };
const source = { kind: 'official_airport' as const, url: 'https://airport.example/layout', title: 'Layout', note: null, retrievedAt: new Date(NOW).toISOString() };
const airport = { ...point, terminalInfo: topology, curation: { timing: null, transport: null, calibration: null, topologyVersion: 4,
  topology: { factId: 'published-layout', expiresAt: new Date(NOW + 86400_000).toISOString() } } };
test('published geometry is sourced, whitelisted, fresh, and retains actual paths', () => {
  const report = validateCuratedFact('terminal_topology', topology, source, NOW + 86400_000, NOW, { publishedTerminals: null, airportPoint: point });
  assert.equal(report.ok, true, JSON.stringify(report));
  const result = airportTopologyGeometry(airport, NOW);
  assert.equal(result.available, true); assert.equal(result.features.length, 5); assert.equal(result.factId, 'published-layout');
  assert.deepEqual(result.features.at(-1)?.geometry, { type: 'LineString', coordinates: [[103.98, 1.35], [103.981, 1.351]] });
  assert.equal(airportTopologyGeometry(airport, NOW + 86400_000).reason, 'topology_expired');
  assert.equal(airportTopologyGeometry({ ...airport, curation: undefined }, NOW).reason, 'not_curated');
});
test('judgment, distant coordinates, missing airport, wrong link endpoints and unknown coordinate fields fail validation', () => {
  assert.ok(topologyGeometryIssues(topology, point, 'curator_judgment').some(x => x.path === 'source.kind'));
  assert.ok(topologyGeometryIssues(topology, null, 'official_airport').length);
  const far = structuredClone(topology); far.terminals[0]!.point.lat = 20;
  assert.ok(topologyGeometryIssues(far, point, 'official_airport').some(x => /25 km/.test(x.problem)));
  const wrong = structuredClone(topology); wrong.walkingLinks[0]!.path[0] = { lat: 1.4, lng: 104 };
  assert.ok(topologyGeometryIssues(wrong, point, 'official_airport').some(x => /500 m/.test(x.problem)));
  const injected = { ...topology, terminals: [{ ...topology.terminals[0], point: { ...point, altitude: 1 } }] };
  assert.ok(topologyGeometryIssues(injected, point, 'official_airport').some(x => /WGS84/.test(x.problem)));
});
test('route geometry refuses malformed lines and carries strict display/cache policy', () => {
  const line = { type: 'LineString', coordinates: [[103.98, 1.35], [103.99, 1.36]] };
  assert.equal(googleRouteGeometry(line)?.displayPolicy, 'google_map_only');
  assert.equal(googleRouteGeometry(line)?.cachePolicy, 'no_store');
  for (const raw of [{ type: 'LineString', coordinates: [[1, 2]] }, { ...line, coordinates: [[Infinity, 0], [1, 2]] }, { ...line, coordinates: [[181, 0], [1, 2]] }, { ...line, type: 'Polygon' }]) assert.equal(googleRouteGeometry(raw), null);
});
test('actual Google adapter requests basic route geometry and carries the returned polyline into the measured leg', async () => {
  let body: any, mask = '';
  const line = { type: 'LineString', coordinates: [[103.98, 1.35], [103.981, 1.351]] };
  const provider = createGoogleRoutesCorridorProvider({ readEnv: n => n === 'LAYOVER_ROUTED_CORRIDOR_ENABLED' ? 'true' : n === 'GOOGLE_MAPS_API_KEY' ? 'fixture-key' : undefined,
    now: () => new Date(NOW), spendScope: () => ({ userId: 'u', tripId: 't' }), spendGate: { decide: async () => 'granted' },
    fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); mask = new Headers(init?.headers).get('X-Goog-FieldMask') ?? ''; return new Response(JSON.stringify({ routes: [{ duration: '600s', polyline: { geoJsonLinestring: line }, legs: [{ steps: [{ travelMode: 'WALK', staticDuration: '600s', distanceMeters: 500 }] }] }] }), { status: 200 }); } });
  const result = await provider.corridor({ from: point, to: point2, mode: 'walk', departAt: new Date(NOW + 60_000) });
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
  assert.equal(body.polylineEncoding, 'GEO_JSON_LINESTRING'); assert.match(mask, /routes.polyline.geoJsonLinestring/);
  assert.equal(body.extraComputations, undefined, 'basic geometry does not opt into higher-SKU traffic overlays');
  assert.deepEqual(routedLegOf(result.value, 'walk').geometry?.geometry, line);
});

import { withRoutesRequestBudget } from '../domain/trips/contracts/RoutesRequestBudget.js';
test('provider memo retains geometry only for the active request and never the cross-request cache', async () => {
  const geometry = googleRouteGeometry({ type: 'LineString', coordinates: [[103.98,1.35],[103.981,1.351]] });
  let calls = 0;
  const memo = memoisedCorridor(async () => { calls++; return { ok: true, value: { expiresAt: new Date(NOW+300000).toISOString(), routes: [{ geometry }] } } as any; }, () => new Date(NOW));
  const q = { from: point, to: point2, mode: 'walk' as const, departAt: new Date(NOW) };
  await withRoutesRequestBudget({userId:'u',layoverSessionId:'s'},async()=>{
    const a=await memo(q), b=await memo(q); assert.ok(a.ok&&b.ok); if(a.ok&&b.ok) assert.equal(b.value.routes[0]?.geometry?.geometry.type,'LineString');
  });
  await withRoutesRequestBudget({userId:'u',layoverSessionId:'s'},async()=>{
    const c=await memo(q); assert.ok(c.ok); if(c.ok) assert.equal(c.value.routes[0]?.geometry,null);
  });
  assert.equal(calls,1,'no extra billed request is made to replace intentionally uncached geometry');
});
