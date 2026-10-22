import React from 'react';
import { render, act } from '@testing-library/react-native';
import { useRoutedMapRefresh, EXPIRED_REFRESH_MIN_INTERVAL_MS } from '../useRoutedMapRefresh.ts';
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
test('BOTH snapshot ids new on every read (production: canonical snapshot off, safety engine on) — one refresh, not a loop (2026-10-22)', async () => {
  // The overview certifies a new snapshot per GET, and the recommendations GET regenerates with Date.now() in its input
  // hash, so the routed answer's id is new per read too. Any key holding either id was new after every refresh.
  const refresh = jest.fn(async () => undefined);
  const routed = (d: string): RoutedMapData => ({ ...sample(NOW + 600000), snapshotId: `snap:${d.repeat(32)}` });
  const view = await render(<Harness data={routed('a')} refresh={refresh} current={`snap:${'1'.repeat(32)}`} />);
  expect(refresh).toHaveBeenCalledTimes(1);
  for (const [r, o] of [['b', '2'], ['c', '3'], ['d', '4'], ['e', '5'], ['f', '6'], ['0', '7'], ['9', '8'], ['8', '9']]) {
    await view.rerender(<Harness data={routed(r)} refresh={refresh} current={`snap:${o.repeat(32)}`} />);
    await act(async () => {});
  }
  expect(refresh).toHaveBeenCalledTimes(1);
});
test('an answer that arrives already expired refreshes at most once a minute, however many reads come back expired', async () => {
  const refresh = jest.fn(async () => undefined);
  const view = await render(<Harness data={sample(NOW - 1000)} refresh={refresh} />);
  expect(refresh).toHaveBeenCalledTimes(1);
  for (let i = 1; i <= 5; i++) {
    // each read: a NEW, already-past expiry instant (a new key every time), a few seconds apart
    await view.rerender(<Harness data={sample(NOW - 1000 + i)} refresh={refresh} now={NOW + i * 5000} />);
    await act(async () => { jest.advanceTimersByTime(5000); });
  }
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(EXPIRED_REFRESH_MIN_INTERVAL_MS); });
  expect(refresh).toHaveBeenCalledTimes(2);
});
