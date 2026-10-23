/**
 * useNotificationStream — one reconnect per failed connection, on the 5 → 10 → 20 s ladder.
 *
 * React Native's XHR fires BOTH onreadystatechange(readyState 4) and onerror when a request fails on the network.
 * Each scheduled a reconnect, so every failure doubled the backoff twice: the waits ran 10 → 40 → 160 s instead of
 * 5 → 10 → 20 s (independent verification of the 2026-10-22 reconnect fix). The real policy runs; only the XHR is a
 * double.
 */
import React from 'react';
import { AppState } from 'react-native';
import { act, render } from '@testing-library/react-native';

type FakeXhr = { readyState: number; status: number; responseText: string; onprogress?: () => void; onreadystatechange?: () => void; onerror?: () => void; send: jest.Mock; abort: jest.Mock };
const opened: FakeXhr[] = [];
// NOTE: intentionally exhaustive at the seam — _connectOnce is replaced by a fake XHR maker; the reconnect policy
// (nextStreamReconnectDelay / grownReconnectDelay) is the real one.
jest.mock('../notificationStreamUtils.ts', () => ({
  ...jest.requireActual('../notificationStreamUtils.ts'),
  _connectOnce: () => {
    const xhr: FakeXhr = { readyState: 1, status: 0, responseText: '', send: jest.fn(), abort: jest.fn() };
    opened.push(xhr);
    return xhr;
  },
}));
// NOTE: intentionally exhaustive — token minting is not under test.
jest.mock('../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'tok') }));
// NOTE: intentionally exhaustive — the toast is not under test.
jest.mock('../../components/NotificationToast.tsx', () => ({ showNotificationToast: jest.fn() }));

import { useNotificationStream } from '../useNotifications.ts';

function Harness() { useNotificationStream(); return null; }

/** A network failure the way RN reports it: readyState 4 with status 0, then onerror. */
function failOnNetwork(xhr: FakeXhr) {
  xhr.readyState = 4; xhr.status = 0;
  xhr.onreadystatechange?.();
  xhr.onerror?.();
}

beforeEach(() => {
  opened.length = 0;
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
afterEach(() => { jest.useRealTimers(); });

it('a failure that fires both events reconnects once, and the waits are 5 s then 10 s', async () => {
  await render(<Harness />);
  await act(async () => {});
  expect(opened).toHaveLength(1);

  await act(async () => { failOnNetwork(opened[0]!); });
  await act(async () => { jest.advanceTimersByTime(4_999); });
  expect(opened).toHaveLength(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  await act(async () => {});
  expect(opened).toHaveLength(2);

  await act(async () => { failOnNetwork(opened[1]!); });
  await act(async () => { jest.advanceTimersByTime(9_999); });
  expect(opened).toHaveLength(2);
  await act(async () => { jest.advanceTimersByTime(1); });
  await act(async () => {});
  expect(opened).toHaveLength(3);
});

it('a 401 does not reconnect at all while the app stays in the foreground', async () => {
  await render(<Harness />);
  await act(async () => {});
  await act(async () => { const x = opened[0]!; x.readyState = 4; x.status = 401; x.onreadystatechange?.(); });
  await act(async () => { jest.advanceTimersByTime(600_000); });
  expect(opened).toHaveLength(1);
});
