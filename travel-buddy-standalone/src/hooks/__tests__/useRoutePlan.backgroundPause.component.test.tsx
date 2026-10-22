/**
 * useRoutePlan — the plan (10 s) and member (30 s) polls pause while Portava is in the background.
 *
 * Neither poll checked the app state, so an open route plan kept reading from a pocket (2026-10-22 refresh-loop hunt).
 */
import React from 'react';
import { AppState, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

const mockFetchPlan = jest.fn(async () => ({ plan: { id: 'rp-1', tripId: null }, stops: [] }));
// NOTE: intentionally exhaustive — only the plan read is exercised by the poll.
jest.mock('../../services/routePlan.ts', () => ({
  fetchRoutePlan: () => mockFetchPlan(),
  fetchRoutePlanMembers: jest.fn(async () => ({ members: [] })),
  patchRoutePlanStop: jest.fn(),
}));

import { useRoutePlan } from '../useRoutePlan.ts';

const listeners = new Set<(s: string) => void>();
function Harness() {
  const r = useRoutePlan({ planId: 'rp-1' });
  return <Text>{r.plan ? 'loaded' : 'loading'}</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetchPlan.mockClear();
  listeners.clear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, fn: (s: string) => void) => {
    listeners.add(fn);
    return { remove: () => { listeners.delete(fn); } };
  }) as never);
});
afterEach(() => { jest.useRealTimers(); });

it('no plan re-read while backgrounded; polling resumes on return', async () => {
  await render(<Harness />);
  await act(async () => {});
  const afterLoad = mockFetchPlan.mock.calls.length;
  await act(async () => { for (const fn of [...listeners]) fn('background'); });
  await act(async () => { jest.advanceTimersByTime(120_000); });
  expect(mockFetchPlan.mock.calls.length).toBe(afterLoad);
  await act(async () => { for (const fn of [...listeners]) fn('active'); });
  await act(async () => { jest.advanceTimersByTime(10_500); });
  expect(mockFetchPlan.mock.calls.length).toBeGreaterThan(afterLoad);
});
