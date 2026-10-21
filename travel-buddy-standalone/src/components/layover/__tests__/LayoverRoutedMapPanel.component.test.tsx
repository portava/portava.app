import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { LayoverRoutedMapPanel } from '../LayoverRoutedMapPanel.tsx';
import type { RoutedMapData } from '../../../lib/layoverRoutedMap.ts';

const NOW = Date.parse('2026-10-19T09:00:00Z');
const SNAP = `snap:${'a'.repeat(32)}`;
const data: RoutedMapData = {
  snapshotId: SNAP,
  envelope: { centre: { lat: 25, lng: 121 }, basis: 'routed_union', certifiedInward: true, certifiedOutward: false, polygonInteriorCertified: false,
    outerBound: { basis: 'straight_line_lower_bound', radiusMetres: 20000 }, windowStartsAt: new Date(NOW).toISOString(), hardReturnBy: '2026-10-19T12:00:00Z',
    usableMinutes: 180, dwellFloorMinutes: 30, confidence: 'MEDIUM', expiresAt: '2026-10-19T09:05:00Z',
    members: [{ key: 'a', point: { lat: 25.01, lng: 121 }, band: 'TIGHT', distanceMetres: 1113, bearingDeg: 0 }],
    excluded: [{ key: 'b', point: { lat: 25.02, lng: 121 }, band: 'BLOCKED', reason: 'Return deadline would be missed' }],
    sectors: [{ index: 1, fromDeg: 45, toDeg: 90, measured: false, reachMetres: null, vertexKey: null }], polygon: [{ lat: 25.01, lng: 121 }] },
  cards: [{ id: 'a', title: 'Museum', routing: { state: 'FEASIBLE', band: 'TIGHT', reason: 'One way back', absence: null, outboundMinutes: 12, conservativeReturnMinutes: 32, expiresAt: '2026-10-19T09:05:00Z',
    returnContract: { hardReturnBy: '2026-10-19T12:00:00Z', leaveBy: '2026-10-19T11:28:00Z', route: { mode: 'drive', departAt: '2026-10-19T10:00:00Z', minutes: 20, conservativeMinutes: 32, forecast: true, independentRoutes: 1, offeredRoutes: 1, transferCount: 0, interruptibility: 'interruptible', conveyances: [{ mode: 'drive', minutes: 20, interruptibility: 'interruptible', endsAt: null }] } } } }],
};
test('draws the named server outline and blocked point, with a complete return itinerary and deadline', async () => {
  await render(<LayoverRoutedMapPanel data={data} currentSnapshotId={SNAP} selectedRecommendationIds={['a']} timezone="UTC" nowMs={NOW} />);
  expect(screen.getByTestId('layover-routed-outline')).toBeTruthy();
  expect(screen.getByTestId('layover-routed-point-BLOCKED-b')).toBeTruthy();
  expect(screen.getByText(/Polygon interior has not been certified/)).toBeTruthy();
  expect(screen.getByText(/Allow 32 min/)).toBeTruthy();
  expect(screen.getByText(/Leave by 11:28/)).toBeTruthy();
  expect(screen.getByText(/airport by 12:00/)).toBeTruthy();
});
test('a different active snapshot withholds the old geometry and route minutes', async () => {
  await render(<LayoverRoutedMapPanel data={data} currentSnapshotId={`snap:${'b'.repeat(32)}`} selectedRecommendationIds={['a']} timezone="UTC" nowMs={NOW} />);
  expect(screen.queryByTestId('layover-routed-outline')).toBeNull();
  expect(screen.queryByText(/Allow 32 min/)).toBeNull();
  expect(screen.getByText(/changed.*refresh/i)).toBeTruthy();
});
test('offline expired routes remain readable and explicitly stale; a budget answer never borrows the full area', async () => {
  const { rerender } = await render(<LayoverRoutedMapPanel data={data} selectedRecommendationIds={['a']} timezone="UTC" nowMs={NOW + 600000} offline />);
  expect(screen.getByText(/STALE/)).toBeTruthy();
  expect(screen.getByText(/Allow 32 min/)).toBeTruthy();
  await rerender(<LayoverRoutedMapPanel data={data} selectedRecommendationIds={['a']} timezone="UTC" nowMs={NOW} budgetActive />);
  expect(screen.queryByTestId('layover-routed-outline')).toBeNull();
  expect(screen.getByText(/area.*not.*measured.*budget/i)).toBeTruthy();
});
