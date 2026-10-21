import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerRouteGeometryOf, continuousCoverageOf } from '../layoverProviderGeometry.ts';
import { airportTopologyOf, airportTopologyCurrent } from '../layoverAirportGeometry.ts';
import { routedMapForStorage, type RoutedMapData } from '../layoverRoutedMap.ts';
import { googleMapContent } from '../layoverGoogleMap.ts';
const NOW = Date.parse('2030-06-14T09:00:00Z'), SNAP = `snap:${'a'.repeat(32)}`;
const line = { provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', geometry: { type: 'LineString', coordinates: [[103.9, 1.3], [103.91, 1.31]] } };
const envelope = { centre: { lat: 1.3, lng: 103.9 }, basis: 'routed_union', certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
  outerBound: null, windowStartsAt: new Date(NOW).toISOString(), hardReturnBy: new Date(NOW+3600000).toISOString(), usableMinutes: 60, dwellFloorMinutes: 30,
  confidence: 'LOW', members: [], excluded: [], sectors: [], polygon: [], expiresAt: new Date(NOW+300000).toISOString(), displayPolicy: 'google_map_only' };
const data = { snapshotId: SNAP, envelope, cards: [{ id: 'c', title: 'Garden', routing: { state: 'FEASIBLE', band: 'SAFE', reason: null, absence: null, outboundMinutes: 5, conservativeReturnMinutes: 10, returnContract: null, expiresAt: envelope.expiresAt, geometry: { outbound: line, returnLeg: line } } }] } as unknown as RoutedMapData;
test('provider display and storage policy is required, coordinates are bounded, and extensions do not survive parsing', () => {
  assert.equal(providerRouteGeometryOf({ ...line, displayPolicy: 'independent_map' }), null);
  assert.equal(providerRouteGeometryOf({ ...line, geometry: { type: 'LineString', coordinates: [[0,0],[181,0]] } }), null);
  assert.equal('secret' in providerRouteGeometryOf({ ...line, secret: 'do not retain' })!, false);
});
test('selected single route carries actual outward and return lines; multi-stop never draws airport legs as between-stop travel', () => {
  const props = { data, currentSnapshotId: SNAP, selectedIds: ['c'], airport: { lat: 1.3, lng: 103.9, iataCode: 'SIN' }, nowMs: NOW };
  assert.deepEqual(googleMapContent(props)?.lines.map(l => l.direction), ['outbound', 'return']);
  assert.deepEqual(googleMapContent({ ...props, selectedIds: ['other', 'c'] })?.lines.map(l => l.direction), ['return']);
  for (const over of [{ offline: true }, { budgetActive: true }, { nowMs: NOW+300000 }, { currentSnapshotId: `snap:${'b'.repeat(32)}` }]) assert.equal(googleMapContent({ ...props, ...over }), null);
});
test('persistent cache strips restricted route and contour geometry, retaining only the own selected timetable contract', () => {
  const saved = routedMapForStorage(data)!;
  assert.equal(saved.envelope, null);
  assert.deepEqual(saved.cards[0]!.routing.geometry, { outbound: null, returnLeg: null });
  assert.equal(saved.cards[0]!.routing.outboundMinutes, 5);
  assert.doesNotMatch(JSON.stringify(saved), /103\.9|LineString|MultiPolygon/);
});
test('airport-owned geometry is independently cacheable but expires and is structurally whitelisted', () => {
  const raw = { available: true, reason: null, source: 'published_airport_topology', displayPolicy: 'independent_map', cachePolicy: 'until_expiry', factId: 'f', topologyVersion: 2,
    expiresAt: envelope.expiresAt, features: [{ id: 't1', kind: 'terminal', label: 'Terminal 1', terminalId: 'T1', minutes: null, geometry: { type: 'Point', coordinates: [103.9, 1.3] }, private: 'secret' }] };
  const value = airportTopologyOf(raw)!; assert.ok(value); assert.equal(airportTopologyCurrent(value,NOW), true); assert.equal(airportTopologyCurrent(value,NOW+300000), false);
  assert.doesNotMatch(JSON.stringify(value), /secret|private/);
  assert.equal(airportTopologyOf({ ...raw, displayPolicy: 'google_map_only' }), null);
});
test('continuous coverage parser retains holes and refuses an unclosed ring', () => {
  const ring = [[0,0],[1,0],[1,1],[0,1],[0,0]], hole = [[.2,.2],[.3,.2],[.3,.3],[.2,.3],[.2,.2]];
  const raw = { state: 'available', basis: 'bidirectional_walking_network', provider: 'google_maps', displayPolicy: 'google_map_only', cachePolicy: 'no_store', mode: 'walk', scope: 'walking_network_with_dwell_floor',
    geometry: { type: 'MultiPolygon', coordinates: [[ring,hole]] }, expiresAt: envelope.expiresAt, windowStartsAt: envelope.windowStartsAt, hardReturnBy: envelope.hardReturnBy,
    outboundBudgetMinutes: 10, returnBudgetMinutes: 10, conservativeReturnMinutes: 20, dwellMinutes: 30, usableMinutes: 60, uncertaintyMinutes: 10 };
  const r = continuousCoverageOf(raw); assert.equal(r?.state, 'available'); if (r?.state === 'available') assert.equal(r.geometry.coordinates[0]!.length, 2);
  assert.equal(continuousCoverageOf({ ...raw, geometry: { type: 'MultiPolygon', coordinates: [[ring.slice(0,-1)]] } }), null);
});
