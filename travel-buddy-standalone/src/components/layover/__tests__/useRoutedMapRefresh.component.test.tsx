import React from 'react';
import { render, act } from '@testing-library/react-native';
import { useRoutedMapRefresh } from '../useRoutedMapRefresh.ts';
import type { RoutedMapData } from '../../../lib/layoverRoutedMap.ts';

const NOW = Date.parse('2026-10-19T09:00:00Z');
const SNAP = `snap:${'a'.repeat(32)}`;
function Harness({ data, refresh, current = SNAP, now = NOW }: { data: RoutedMapData; refresh: () => Promise<void>; current?: string; now?: number }) {
  useRoutedMapRefresh('session', data, current, refresh, now); return null;
}
const sample = (expires: number): RoutedMapData => ({ snapshotId: SNAP, cards: [], envelope: { expiresAt: new Date(expires).toISOString() } as RoutedMapData['envelope'] });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(() => { jest.useRealTimers(); });
test('expiry requests a fresh server answer once; unchanged answers cannot loop', async () => {
  const refresh = jest.fn(async () => undefined);
  const data = sample(NOW + 60000);
  const view = await render(<Harness data={data} refresh={refresh} />);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(60001); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness data={{ ...data }} refresh={refresh} now={NOW + 60001} />);
  await act(async () => { jest.advanceTimersByTime(60000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness data={sample(NOW + 180000)} refresh={refresh} now={NOW + 120001} />);
  await act(async () => { jest.advanceTimersByTime(60000); });
  expect(refresh).toHaveBeenCalledTimes(2);
});
test('route_stale and snapshot replacement refresh immediately; unmount cancels a future timer', async () => {
  const refresh = jest.fn(async () => undefined);
  const data = sample(NOW + 60000);
  const view = await render(<Harness data={data} refresh={refresh} current={`snap:${'b'.repeat(32)}`} />);
  expect(refresh).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness data={{ snapshotId: SNAP, envelope: null, cards: [{ id: 'a', title: 'Museum', routing: { state: 'UNMEASURED', band: 'UNCERTIFIED', reason: null, absence: 'route_stale', outboundMinutes: null, conservativeReturnMinutes: null, expiresAt: null, returnContract: null } }] }} refresh={refresh} />);
  expect(refresh).toHaveBeenCalledTimes(2);
  await view.rerender(<Harness data={sample(NOW + 180000)} refresh={refresh} />);
  await view.unmount();
  await act(async () => { jest.advanceTimersByTime(180001); });
  expect(refresh).toHaveBeenCalledTimes(2);
});
