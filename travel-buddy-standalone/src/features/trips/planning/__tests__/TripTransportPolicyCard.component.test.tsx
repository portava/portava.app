/**
 * TRIP-F16: TripTransportPolicyCard — the owner sets the modes the trip does
 * not use; a gate that is off is said, not drawn as "every mode allowed".
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripTransportPolicyCard } from '../TripTransportPolicyCard.tsx';

const report = (transportPolicy: unknown) => ({
  state: 'ok' as const,
  report: {
    tripId: 't1', commitmentCount: 0, evaluatedHops: 0, verdict: 'UNKNOWN', confidence: null, worstSlackMinutes: null, offendingHopIndex: null,
    hops: [], unresolvedPlaceIds: [], provider: { id: 'straight_line', routed: false }, disclosure: 'd',
    consistency: { verdict: 'UNCHECKABLE', findings: [] }, transportPolicy,
  } as any,
});

it('with the gate off (no policy in the response) it says the rules cannot be set here', async () => {
  const load = jest.fn().mockResolvedValue(report(null));
  await render(<TripTransportPolicyCard tripId="t1" isOwner load={load} />);
  await waitFor(() => screen.getByTestId('trip-transport-not-here'));
  expect(screen.queryByTestId('trip-transport-mode-walk')).toBeNull();
});

it('the owner toggles a mode off and saves; the save sends the disallowed set and re-reads', async () => {
  const load = jest.fn().mockResolvedValue(report({ disallowedModes: [], note: null }));
  const save = jest.fn().mockResolvedValue({ state: 'done', data: { disallowedModes: ['drive'], note: null, updatedAt: null }, status: 200 });
  await render(<TripTransportPolicyCard tripId="t1" isOwner load={load} save={save} />);
  await waitFor(() => screen.getByTestId('trip-transport-mode-drive'));
  expect(screen.queryByTestId('trip-transport-save')).toBeNull();
  await fireEvent.press(screen.getByTestId('trip-transport-mode-drive'));
  await fireEvent.press(screen.getByTestId('trip-transport-save'));
  await waitFor(() => expect(save).toHaveBeenCalledWith('t1', ['drive'], null));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it('a refused save is shown by name and nothing claims it was saved', async () => {
  const load = jest.fn().mockResolvedValue(report({ disallowedModes: [], note: null }));
  const save = jest.fn().mockResolvedValue({ state: 'refused', status: 404, reason: 'feature_disabled', detail: 'Trip operational projections are not enabled' });
  await render(<TripTransportPolicyCard tripId="t1" isOwner load={load} save={save} />);
  await waitFor(() => screen.getByTestId('trip-transport-mode-walk'));
  await fireEvent.press(screen.getByTestId('trip-transport-mode-walk'));
  await fireEvent.press(screen.getByTestId('trip-transport-save'));
  await waitFor(() => screen.getByTestId('trip-transport-not-saved'));
  expect(screen.getByText('Trip operational projections are not enabled')).toBeTruthy();
  expect(screen.queryByTestId('trip-transport-saved')).toBeNull();
});

it('a crew member sees the policy but cannot change it', async () => {
  const load = jest.fn().mockResolvedValue(report({ disallowedModes: ['transit'], note: null }));
  await render(<TripTransportPolicyCard tripId="t1" isOwner={false} load={load} />);
  await waitFor(() => screen.getByText('Not used: Public transit.'));
  await fireEvent.press(screen.getByTestId('trip-transport-mode-walk'));
  expect(screen.queryByTestId('trip-transport-save')).toBeNull();
  expect(screen.getByText('Only the trip owner can change these.')).toBeTruthy();
});

it('a failed read says so, with a retry', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 500' }).mockResolvedValue(report(null));
  await render(<TripTransportPolicyCard tripId="t1" isOwner load={load} />);
  await waitFor(() => screen.getByTestId('trip-transport-unavailable'));
  await fireEvent.press(screen.getByTestId('trip-transport-retry'));
  await waitFor(() => screen.getByTestId('trip-transport-not-here'));
});
