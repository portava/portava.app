/**
 * TripCloseoutCard — §20.3's question set asked by a screen at last. census-trips TR390, TR385.
 *
 *   - the questions render in the spec's words with the two answers
 *   - an answer posts through the recorder and shows "recorded" only on the server's 201
 *   - a refusal by name (TRIP_KERNEL_UNAVAILABLE) shows "Not recorded" — never a tick
 *   - unavailable says so; off renders nothing
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { TripCloseoutCard } from '../TripCloseoutCard.tsx';
import type { CloseoutRead, TripCloseout, AnswerResult } from '../tripCloseout.ts';

const TRIP_ID = 'trip-closeout-test';
function closeout(over: Partial<TripCloseout> = {}): TripCloseout {
  return {
    tripId: TRIP_ID, tripStatus: 'completed', performedAt: '2026-09-15T10:00:00Z',
    steps: [{ step: 'reconcile_uncertain_plan_outcomes', status: 'actionable', ids: ['p1'], detail: '1 plan(s)' }, { step: 'project_passport_memory_candidates', status: 'deferred', detail: 'kernel off' }],
    questions: [{ planId: 'p1', question: 'Did you make it to Hoi An?', answers: ['completed', 'skipped'] }],
    unread: [],
    ...over,
  };
}
const loader = (read: CloseoutRead) => jest.fn(async () => read);
const recorder = (result: AnswerResult) => jest.fn(async () => result);

describe('TripCloseoutCard', () => {
  it('asks the question in the spec\'s words with its two answers and summarises the steps', async () => {
    const { findByTestId, getByText } = await render(<TripCloseoutCard tripId={TRIP_ID} load={loader({ state: 'ok', closeout: closeout() })} record={recorder({ state: 'recorded', planId: 'p1', answer: 'completed', duplicate: false })} />);
    await findByTestId('trip-closeout-card');
    expect(getByText('One thing to confirm')).toBeTruthy();
    expect(getByText('1 step(s) would act on completion · 1 deferred here')).toBeTruthy();
    expect(getByText('Did you make it to Hoi An?')).toBeTruthy();
    expect(getByText('Yes, made it')).toBeTruthy();
    expect(getByText('No, skipped it')).toBeTruthy();
  });
  it('an answer is recorded through the recorder and shown as recorded only on the server\'s word', async () => {
    const record = recorder({ state: 'recorded', planId: 'p1', answer: 'skipped', duplicate: false });
    const { findByTestId, getByText } = await render(<TripCloseoutCard tripId={TRIP_ID} load={loader({ state: 'ok', closeout: closeout() })} record={record} />);
    fireEvent.press(await findByTestId('trip-closeout-answer-p1-skipped'));
    await findByTestId('trip-closeout-recorded-p1');
    expect(record).toHaveBeenCalledWith(TRIP_ID, 'p1', 'skipped');
    expect(getByText('No, skipped it — recorded')).toBeTruthy();
  });
  it('a refusal by name is "Not recorded" with the reason — never a tick', async () => {
    const record = recorder({ state: 'refused', reason: 'TRIP_KERNEL_UNAVAILABLE', detail: 'trip_kernel_enabled is off: an outcome is recorded only through the kernel' });
    const { findByTestId, getByText, queryByTestId } = await render(<TripCloseoutCard tripId={TRIP_ID} load={loader({ state: 'ok', closeout: closeout() })} record={record} />);
    fireEvent.press(await findByTestId('trip-closeout-answer-p1-completed'));
    await findByTestId('trip-closeout-not-recorded-p1');
    expect(getByText(/Not recorded — TRIP_KERNEL_UNAVAILABLE: trip_kernel_enabled is off/)).toBeTruthy();
    expect(queryByTestId('trip-closeout-recorded-p1')).toBeNull();
  });
  it('unavailable says nothing was asked; off renders nothing', async () => {
    const { findByTestId, getByText } = await render(<TripCloseoutCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'not crew' })} />);
    await findByTestId('trip-closeout-unavailable');
    expect(getByText(/not crew\. Nothing was asked and nothing is answered/)).toBeTruthy();
    const off = await render(<TripCloseoutCard tripId={TRIP_ID} load={loader({ state: 'off' })} />);
    await waitFor(() => expect(off.queryByTestId('trip-closeout-loading')).toBeNull());
    expect(off.toJSON()).toBeNull();
  });
});
