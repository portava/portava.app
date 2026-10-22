/**
 * TripCloseoutCard — asked only while the kernel can record the answer.
 *
 * In production (2026-10-22) `trip_kernel_enabled` is OFF, and POST /trips/:id/closeout/answers refuses every
 * answer with 503 TRIP_KERNEL_UNAVAILABLE (routes/tripPostTrip.ts). A completed trip still showed "Yes, made it /
 * No, skipped it", and every tap printed "Not recorded — TRIP_KERNEL_UNAVAILABLE: trip_kernel_enabled is off: …".
 *   K1  flag OFF → the card renders nothing and the closeout is not even read;
 *   K2  flag ON, a refusal → said in the traveller's words: no reason code, no flag name;
 *   K3  flag ON → the question and its two answers are offered.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripCloseoutCard } from '../TripCloseoutCard.tsx';
import type { CloseoutRead, AnswerResult } from '../tripCloseout.ts';

const mockFlagsOn = new Set<string>();
// NOTE: intentionally exhaustive — the card reads one flag through the context; the provider fetches over HTTP.
jest.mock('../../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlagsOn.has(k), loading: false }),
}));

const TRIP_ID = 'trip-kernel-gate';
const READ: CloseoutRead = {
  state: 'ok',
  closeout: {
    tripId: TRIP_ID, tripStatus: 'completed', performedAt: '2026-10-22T10:00:00Z',
    steps: [{ step: 'reconcile_uncertain_plan_outcomes', status: 'actionable', ids: ['p1'], detail: '1 plan(s)' }],
    questions: [{ planId: 'p1', question: 'Did you make it to Hoi An?', answers: ['completed', 'skipped'] }],
    unread: [],
  },
};
const KERNEL_REFUSAL: AnswerResult = { state: 'refused', reason: 'TRIP_KERNEL_UNAVAILABLE', detail: 'trip_kernel_enabled is off: an outcome is recorded only through the kernel' };

beforeEach(() => { mockFlagsOn.clear(); });

describe('TripCloseoutCard — trip_kernel_enabled gate', () => {
  it('K1: with the kernel flag off the card renders nothing and reads nothing', async () => {
    const load = jest.fn(async () => READ);
    const view = await render(<TripCloseoutCard tripId={TRIP_ID} load={load} record={jest.fn(async () => KERNEL_REFUSAL)} />);
    await waitFor(() => expect(screen.queryByTestId('trip-closeout-loading')).toBeNull());
    expect(screen.queryByTestId('trip-closeout-answer-p1-completed')).toBeNull();
    expect(screen.queryByText('Yes, made it')).toBeNull();
    expect(view.toJSON()).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('K2: a refusal is "Not recorded" in words — never the reason code or the flag name', async () => {
    mockFlagsOn.add('trip_kernel_enabled');
    await render(<TripCloseoutCard tripId={TRIP_ID} load={jest.fn(async () => READ)} record={jest.fn(async () => KERNEL_REFUSAL)} />);
    await fireEvent.press(await screen.findByTestId('trip-closeout-answer-p1-completed'));
    const line = await screen.findByTestId('trip-closeout-not-recorded-p1');
    const said = [line.props.children].flat().join('');
    expect(said).toBe("Not recorded — answers can't be saved yet.");
    expect(screen.queryByText(/TRIP_KERNEL_UNAVAILABLE|trip_kernel_enabled/)).toBeNull();
  });

  it('K3: with the kernel flag on the question and its two answers are offered', async () => {
    mockFlagsOn.add('trip_kernel_enabled');
    await render(<TripCloseoutCard tripId={TRIP_ID} load={jest.fn(async () => READ)} record={jest.fn(async () => KERNEL_REFUSAL)} />);
    expect(await screen.findByTestId('trip-closeout-answer-p1-completed')).toBeTruthy();
    expect(screen.getByText('Did you make it to Hoi An?')).toBeTruthy();
    expect(screen.getByText('No, skipped it')).toBeTruthy();
  });
});
