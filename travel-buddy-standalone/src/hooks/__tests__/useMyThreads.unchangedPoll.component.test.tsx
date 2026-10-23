/**
 * useMyThreads — an unchanged inbox poll costs nothing.
 *
 * The inbox polls GET /threads every 7 s for as long as the app is open (the Messages tab stays mounted once
 * visited), and every tick called setData + saveSnapshot even when nothing had changed: two re-renders and an
 * AsyncStorage write every 7 s (2026-10-22 refresh-loop hunt). Now a poll whose answer is byte-identical to the
 * previous poll's is dropped; a changed answer still lands.
 */
import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

const T1 = [{ id: 'th-1', lastMessageAt: '2026-10-22T10:00:00Z', unreadCount: 0 }];
const T2 = [{ id: 'th-1', lastMessageAt: '2026-10-22T10:05:00Z', unreadCount: 1 }];
let answer: unknown[] = T1;
const mockGetMyThreads = jest.fn(async () => ({ ok: true, data: { threads: answer } }));
const mockSave = jest.fn();

// NOTE: intentionally exhaustive — only the inbox read is exercised; the real module pulls the API client.
jest.mock('../../services/messaging.ts', () => ({ getMyThreads: () => mockGetMyThreads() }));
// NOTE: intentionally exhaustive — realtime is not under test; subscribe returns an unsubscribe.
jest.mock('../../services/telegraphRealtimeService.ts', () => ({ telegraphRealtime: { subscribe: () => () => {} } }));
// NOTE: intentionally exhaustive — the snapshot cache is observed through its save.
jest.mock('../useSnapshotCache.ts', () => ({ useSnapshotCache: () => ({ snapshot: null, save: mockSave, clear: jest.fn() }) }));
// NOTE: intentionally exhaustive — the inbox hook does not read the session in this path.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: 'u-1', isAuthed: true }) }));

import { useMyThreads } from '../useMessaging.ts';

let renders = 0;
function Harness() {
  const { data } = useMyThreads();
  renders += 1;
  return <Text>{data.length}</Text>;
}

beforeEach(() => { Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true }); jest.useFakeTimers(); mockGetMyThreads.mockClear(); mockSave.mockClear(); answer = T1; renders = 0; });
afterEach(() => { jest.useRealTimers(); });

it('identical answers neither re-render nor write the snapshot; a changed one does', async () => {
  await render(<Harness />);
  await act(async () => {});
  const savesAfterLoad = mockSave.mock.calls.length;
  // first poll establishes the baseline (it may write once)
  await act(async () => { jest.advanceTimersByTime(7_000); });
  await act(async () => {});
  const baselineSaves = mockSave.mock.calls.length;
  const baselineRenders = renders;
  for (let i = 0; i < 5; i++) {
    await act(async () => { jest.advanceTimersByTime(7_000); });
    await act(async () => {});
  }
  expect(mockGetMyThreads.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(mockSave.mock.calls.length).toBe(baselineSaves);
  expect(renders).toBe(baselineRenders);
  expect(baselineSaves - savesAfterLoad).toBeLessThanOrEqual(1);

  answer = T2;
  await act(async () => { jest.advanceTimersByTime(7_000); });
  await act(async () => {});
  expect(mockSave.mock.calls.length).toBe(baselineSaves + 1);
  expect(mockSave).toHaveBeenLastCalledWith(T2);
});
