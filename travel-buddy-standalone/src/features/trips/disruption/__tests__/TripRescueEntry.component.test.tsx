/**
 * TripRescueEntry — §17.3's entry under §17.2's switch. census-trips TR318.
 *
 *   - renders only when the mode is not NORMAL
 *   - the problems are the server's vocabulary; a chosen one asks for a plan
 *   - the plan renders as given; "declared" is the server's word, "not declared" with the kernel off
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

import { TripRescueEntry } from '../TripRescueEntry.tsx';
import type { RescueResult, RescueResponse } from '../tripRescue.ts';

const TRIP_ID = 'trip-rescue-test';
const ok = (declared: RescueResponse['declared']): RescueResult => ({
  state: 'ok',
  response: {
    tripId: TRIP_ID,
    plan: { problem: 'lost_crew', severity: 'major', declare: { kind: 'safety', severity: 'major', note: 'lost' },
      steps: [{ order: 1, action: 'Regroup', who: 'crew', detail: 'at the last meeting point' }], escalation: [{ to: 'trip_crew', why: 'they know where you were', when: 'now' }],
      compass: { may: [], mustNot: [] }, safeReturn: 'offer', explanation: [] },
    declared,
  },
});

describe('TripRescueEntry', () => {
  it('renders nothing under NORMAL, and the problems under a switch', async () => {
    const off = await render(<TripRescueEntry tripId={TRIP_ID} attentionMode="NORMAL" request={jest.fn()} />);
    expect(off.toJSON()).toBeNull();
    const { findByTestId, getByText } = await render(<TripRescueEntry tripId={TRIP_ID} attentionMode="SAFETY_EVENT" request={jest.fn()} />);
    await findByTestId('trip-rescue-entry');
    expect(getByText('Need help right now?')).toBeTruthy();
    expect(getByText('Lost the crew')).toBeTruthy();
    expect(getByText('Emergency')).toBeTruthy();
  });
  it('a chosen problem asks the server and renders its plan with "declared" in the server\'s words', async () => {
    const request = jest.fn(async () => ok({ ok: true, disruptionId: 'd1', duplicate: false, reason: null, skipped: null }));
    const { findByTestId, getByText } = await render(<TripRescueEntry tripId={TRIP_ID} attentionMode="AT_RISK_MODE" request={request} />);
    fireEvent.press(await findByTestId('trip-rescue-problem-lost_crew'));
    await findByTestId('trip-rescue-plan');
    expect(request).toHaveBeenCalledWith(TRIP_ID, 'lost_crew');
    expect(getByText('Lost the crew — major')).toBeTruthy();
    expect(getByText(/1\. Regroup/)).toBeTruthy();
    expect(getByText('Escalate to trip crew now: they know where you were')).toBeTruthy();
    expect(getByText('Disruption declared — the trip is now under attention')).toBeTruthy();
  });
  it('with the kernel off the plan still renders and the declaration says "not declared"; a failed request tells the traveller to call local emergency services', async () => {
    const request = jest.fn(async () => ok({ ok: false, disruptionId: null, duplicate: false, reason: null, skipped: 'trip_kernel_enabled is false' }));
    const { findByTestId, getByText } = await render(<TripRescueEntry tripId={TRIP_ID} attentionMode="SAFETY_EVENT" request={request} />);
    fireEvent.press(await findByTestId('trip-rescue-problem-emergency'));
    await findByTestId('trip-rescue-declared');
    expect(getByText('Disruption not declared: trip_kernel_enabled is false')).toBeTruthy();
    const failing = jest.fn(async () => ({ state: 'unavailable' as const, detail: 'network down' }));
    const r2 = await render(<TripRescueEntry tripId={TRIP_ID} attentionMode="SAFETY_EVENT" request={failing} />);
    fireEvent.press(await r2.findByTestId('trip-rescue-problem-stranded'));
    await r2.findByTestId('trip-rescue-unavailable');
    expect(r2.getByText(/Could not get a plan: network down\. Call local emergency services if you are unsafe/)).toBeTruthy();
    await waitFor(() => expect(failing).toHaveBeenCalled());
  });
});
