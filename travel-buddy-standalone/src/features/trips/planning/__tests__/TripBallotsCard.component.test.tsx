/**
 * TRIP-F15: TripBallotsCard — open votes with the server's tally and the
 * viewer's own ballot; a vote is recorded only on the kernel's word.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripBallotsCard } from '../TripBallotsCard.tsx';
import type { DecisionRead } from '../tripDecisions.ts';

const proposal = (over: Record<string, unknown> = {}) => ({
  id: 'p1', type: 'change_plan', status: 'pending', decisionRule: 'majority', proposedBy: 'u2', expiresAt: null,
  payload: { title: 'Dinner at 8pm' }, myVote: null,
  tally: { found: true, decision_rule: 'majority', electorate: 3, yes: 1, no: 0, abstain: 0, cast: 1, majority_met: false }, ...over,
});
const board = (proposals: unknown[]): DecisionRead => ({
  state: 'ok',
  board: { tripId: 't1', asOf: 'x', goals: [], decisionTasks: [], risks: [], proposals: proposals as any, tallyFailures: 0, recommendations: [], elementRisks: [] },
});

it('shows each open vote with its tally and the viewer\'s own ballot, and not decided ones', async () => {
  const load = jest.fn().mockResolvedValue(board([proposal(), proposal({ id: 'p2', status: 'accepted', payload: { title: 'Old one' } })]));
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} />);
  await waitFor(() => screen.getByText('Dinner at 8pm'));
  expect(screen.getByTestId('ballot-tally-p1').props.children).toBe('1 yes · 0 no · 0 abstain — 1 of 3 voted');
  expect(screen.getByTestId('ballot-myvote-p1').props.children).toBe('You have not voted');
  expect(screen.queryByText('Old one')).toBeNull();
  // Not the owner, rule not met: no Accept offered.
  expect(screen.queryByTestId('ballot-p1-accept')).toBeNull();
});

it('a vote goes to the kernel with a fresh key and the board is re-read; only then is it "recorded"', async () => {
  const load = jest.fn().mockResolvedValueOnce(board([proposal()])).mockResolvedValue(board([proposal({ myVote: 'yes' })]));
  const cast = jest.fn().mockResolvedValue({ state: 'recorded', duplicate: false });
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} cast={cast} />);
  await waitFor(() => screen.getByTestId('ballot-p1-yes'));
  await fireEvent.press(screen.getByTestId('ballot-p1-yes'));
  await waitFor(() => screen.getByTestId('ballot-recorded-p1'));
  expect(cast).toHaveBeenCalledWith('t1', 'p1', 'yes', expect.stringMatching(/^ballot:p1:yes:/));
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('ballot-myvote-p1').props.children).toBe('You voted yes');
});

it('when the kernel could not be reached, "try again" re-sends THE SAME key — a retry cannot count twice', async () => {
  const load = jest.fn().mockResolvedValue(board([proposal()]));
  const cast = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValue({ state: 'recorded', duplicate: true });
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} cast={cast} />);
  await waitFor(() => screen.getByTestId('ballot-p1-no'));
  await fireEvent.press(screen.getByTestId('ballot-p1-no'));
  await waitFor(() => screen.getByTestId('ballot-retry-p1'));
  await fireEvent.press(screen.getByTestId('ballot-retry-p1'));
  await waitFor(() => screen.getByTestId('ballot-recorded-p1'));
  expect(cast.mock.calls[0][3]).toBe(cast.mock.calls[1][3]);
});

it('a refusal is shown by name, and nothing is marked voted', async () => {
  const load = jest.fn().mockResolvedValue(board([proposal()]));
  const cast = jest.fn().mockResolvedValue({ state: 'refused', reason: 'TRIP_PROPOSAL_NOT_PENDING', detail: 'this vote has already been decided' });
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} cast={cast} />);
  await waitFor(() => screen.getByTestId('ballot-p1-yes'));
  await fireEvent.press(screen.getByTestId('ballot-p1-yes'));
  await waitFor(() => screen.getByTestId('ballot-refused-p1'));
  expect(screen.getByTestId('ballot-myvote-p1').props.children).toBe('You have not voted');
});

it('the owner is offered accept / reject, which go to the kernel as ACCEPT/REJECT decisions', async () => {
  const load = jest.fn().mockResolvedValue(board([proposal()]));
  const decide = jest.fn().mockResolvedValue({ state: 'recorded', duplicate: false });
  await render(<TripBallotsCard tripId="t1" isOwner load={load} decide={decide} />);
  await waitFor(() => screen.getByTestId('ballot-p1-accept'));
  await fireEvent.press(screen.getByTestId('ballot-p1-accept'));
  await waitFor(() => expect(decide).toHaveBeenCalledWith('t1', 'p1', 'accept', expect.stringMatching(/^ballot:p1:accept:/)));
});

it('a failed read says so with a retry, and an empty board says there are no open votes', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' }).mockResolvedValue(board([]));
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} />);
  await waitFor(() => screen.getByTestId('trip-ballots-unavailable'));
  await fireEvent.press(screen.getByTestId('trip-ballots-retry'));
  await waitFor(() => screen.getByTestId('trip-ballots-empty'));
});
