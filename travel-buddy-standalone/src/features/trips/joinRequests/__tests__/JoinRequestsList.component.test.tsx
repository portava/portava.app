/**
 * TRIP-F06: JoinRequestsList — the owner's review, on the trip page and on
 * app/trip/join-requests.tsx.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { JoinRequestsList } from '../JoinRequestsList.tsx';

const req = (id: string, tripId: string, createdAt: string, user: unknown = { id: 'u', handle: 'ana', name: 'Ana', avatarUrl: null }) =>
  ({ id, tripId, status: 'pending', message: null, createdAt, user });

it('on the trip page: only this trip\'s requests; approve is reported only on the server\'s word', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: [req('r1', 't1', '2026-09-01'), req('r2', 't2', '2026-09-02')] });
  const approve = jest.fn().mockResolvedValue({ state: 'done', data: { status: 'approved' }, status: 200 });
  const onApproved = jest.fn();
  await render(<JoinRequestsList tripId="t1" load={load} approve={approve} onApproved={onApproved} />);
  await waitFor(() => screen.getByTestId('join-request-r1'));
  expect(screen.queryByTestId('join-request-r2')).toBeNull();
  await fireEvent.press(screen.getByTestId('join-request-approve-r1'));
  await waitFor(() => screen.getByTestId('join-request-approved-r1'));
  expect(approve).toHaveBeenCalledWith('t1', 'r1', expect.stringMatching(/^join-approve:r1:/));
  expect(onApproved).toHaveBeenCalled();
});

it('an approval that got no answer is retried with the same key, so the member cannot be added twice', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: [req('r1', 't1', '2026-09-01')] });
  const approve = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValue({ state: 'done', data: {}, status: 200 });
  await render(<JoinRequestsList tripId="t1" load={load} approve={approve} />);
  await waitFor(() => screen.getByTestId('join-request-approve-r1'));
  await fireEvent.press(screen.getByTestId('join-request-approve-r1'));
  await waitFor(() => screen.getByTestId('join-request-failed-r1'));
  expect(screen.getByText('Try approving again')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('join-request-approve-r1'));
  await waitFor(() => screen.getByTestId('join-request-approved-r1'));
  expect(approve.mock.calls[0][2]).toBe(approve.mock.calls[1][2]);
});

it('decline, and a refusal stays visible with the request still actionable', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: [req('r1', 't1', '2026-09-01')] });
  const decline = jest.fn().mockResolvedValueOnce({ state: 'refused', status: 409, reason: 'invalid_state_transition', detail: 'Request is already cancelled' });
  await render(<JoinRequestsList tripId="t1" load={load} decline={decline} />);
  await waitFor(() => screen.getByTestId('join-request-decline-r1'));
  await fireEvent.press(screen.getByTestId('join-request-decline-r1'));
  await waitFor(() => screen.getByText('Request is already cancelled'));
});

it('the review screen groups by trip, says when nobody is waiting, and never shows a failed read as empty', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: [req('r1', 't1', '2026-09-01'), req('r2', 't2', '2026-09-03', null)] });
  await render(<JoinRequestsList tripTitles={{ t1: 'Lisbon' }} load={load} />);
  await waitFor(() => screen.getByTestId('join-requests-trip-t1'));
  expect(screen.getByText('Lisbon')).toBeTruthy();
  expect(screen.getByText('One of your trips')).toBeTruthy();
  expect(screen.getByText('Someone (profile unavailable)')).toBeTruthy();

  const empty = jest.fn().mockResolvedValue({ state: 'ok', data: [] });
  const r2 = await render(<JoinRequestsList load={empty} />);
  await waitFor(() => r2.getByTestId('join-requests-empty'));

  const failed = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 500' }).mockResolvedValue({ state: 'ok', data: [] });
  const r3 = await render(<JoinRequestsList load={failed} />);
  await waitFor(() => r3.getByTestId('join-requests-unavailable'));
  await fireEvent.press(r3.getByTestId('join-requests-retry'));
  await waitFor(() => r3.getByTestId('join-requests-empty'));
});

it('on the trip page an empty queue renders nothing', async () => {
  const load = jest.fn().mockResolvedValue({ state: 'ok', data: [] });
  const r = await render(<JoinRequestsList tripId="t1" load={load} />);
  await waitFor(() => expect(load).toHaveBeenCalled());
  await waitFor(() => expect(r.queryByTestId('join-requests-loading')).toBeNull());
  expect(r.queryByTestId('join-requests-card')).toBeNull();
});
