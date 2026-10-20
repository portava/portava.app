import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routedMapFeatures } from '../layoverRoutedMapGeometry.ts';
import { buildRoutedMapData } from '../layoverRoutedMap.ts';
const NOW = Date.parse('2026-10-19T09:00:00Z'), SNAP = `snap:${'a'.repeat(32)}`;
const data = buildRoutedMapData(SNAP, { basis: 'routed_union', centre: { lat: 25, lng: 121 }, certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
  windowStartsAt: new Date(NOW).toISOString(), hardReturnBy: '2026-10-19T12:00:00Z', usableMinutes: 180, dwellFloorMinutes: 30, confidence: 'MEDIUM', expiresAt: '2026-10-19T09:05:00Z',
  outerBound: { basis: 'straight_line_lower_bound', radiusMetres: 10000 }, sectors: [], polygon: [{ lat: 25.01, lng: 121 }, { lat: 25, lng: 121.01 }],
  members: [{ key: 'a', point: { lat: 25.01, lng: 121 }, band: 'TIGHT', distanceMetres: 1113, bearingDeg: 0 }], excluded: [{ key: 'b', point: { lat: 25.02, lng: 121 }, band: 'BLOCKED', reason: 'Return deadline' }] }, []);
test('native geography uses exact server coordinates and bands with no certified polygon fill', () => {
  const result = routedMapFeatures(data, SNAP, NOW, false);
  assert.ok(result);
  assert.ok(result.features.every(f => String(f.geometry.type) !== 'Polygon'));
  const member = result.features.find(f => f.id === 'a')!;
  assert.deepEqual(member.geometry, { type: 'Point', coordinates: [121, 25.01] });
  assert.equal(member.properties?.band, 'TIGHT');
  assert.equal(result.features.find(f => f.id === 'b')?.properties?.band, 'BLOCKED');
  assert.ok(result.features.some(f => f.properties?.kind === 'outer-bound'));
});
test('superseded or budget-mismatched geography is withheld; expired points are grey', () => {
  assert.equal(routedMapFeatures(data, `snap:${'b'.repeat(32)}`, NOW, false), null);
  assert.equal(routedMapFeatures(data, SNAP, NOW, true), null);
  const stale = routedMapFeatures(data, SNAP, NOW + 600000, false)!;
  assert.equal(stale.features.find(f => f.id === 'a')?.properties?.displayBand, 'STALE');
});
