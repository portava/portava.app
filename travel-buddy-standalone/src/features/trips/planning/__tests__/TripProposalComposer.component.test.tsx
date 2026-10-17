/**
 * census-trips TR154 (§9.3 decisionRule; populates TR88): a crew member can
 * propose a change under a rule they choose, from the votes card, and the new
 * proposal joins the open votes when the kernel has recorded it.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripProposalComposer } from '../TripProposalComposer.tsx';
import { TripBallotsCard } from '../TripBallotsCard.tsx';
import type { DecisionRead, DecisionBoard } from '../tripDecisions.ts';

const recorded = { state: 'recorded' as const, duplicate: false, id: 'prop-1' };
const board = (proposals: unknown[]): DecisionRead => ({
  state: 'ok',
  board: { tripId: 't1', asOf: 'x', goals: [], decisionTasks: [], risks: [], proposals: proposals as DecisionBoard['proposals'], tallyFailures: 0, recommendations: [], elementRisks: [] },
});

async function fillIn() {
  await fireEvent.press(screen.getByTestId('proposal-compose-open'));
  await fireEvent.changeText(screen.getByTestId('proposal-title'), 'Leave Hoi An a day early');
}

it('proposes with the chosen kind and rule — the host\'s rule shown selected, not applied unseen — and the optional why and impact', async () => {
  const propose = jest.fn().mockResolvedValue(recorded);
  const onProposed = jest.fn();
  await render(<TripProposalComposer tripId="t1" propose={propose} onProposed={onProposed} />);
  await fillIn();
  expect(screen.getByTestId('proposal-rule-host').props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByTestId('proposal-compose-submit').props.accessibilityState).toEqual({ disabled: true }); // no kind yet
  expect(screen.getByTestId('proposal-effect-note').props.children).toBe("Accepting it records the crew's decision. It doesn't change the trip by itself.");
  await fireEvent.press(screen.getByTestId('proposal-type-stage_change'));
  await fireEvent.press(screen.getByTestId('proposal-rule-majority'));
  await fireEvent.changeText(screen.getByTestId('proposal-rationale'), 'the storm');
  await fireEvent.changeText(screen.getByTestId('proposal-impact'), 'one night less in Hoi An');
  await fireEvent.press(screen.getByTestId('proposal-compose-submit'));
  await waitFor(() => screen.getByTestId('proposal-compose-recorded'));
  expect(propose).toHaveBeenCalledWith('t1', { proposalType: 'stage_change', decisionRule: 'majority', title: 'Leave Hoi An a day early', rationale: 'the storm', impactSummary: 'one night less in Hoi An' }, expect.stringMatching(/^proposal:create:/));
  expect(onProposed).toHaveBeenCalledTimes(1);
  // the form resets to the defaults
  expect(screen.getByTestId('proposal-title').props.value).toBe('');
  expect(screen.getByTestId('proposal-rule-host').props.accessibilityState).toEqual({ selected: true });
});

it('offers only the kinds whose acceptance changes nothing by itself, and all four rules', async () => {
  await render(<TripProposalComposer tripId="t1" propose={jest.fn()} />);
  await fireEvent.press(screen.getByTestId('proposal-compose-open'));
  for (const t of ['stage_change', 'add_commitment', 'other']) expect(screen.getByTestId(`proposal-type-${t}`)).toBeTruthy();
  for (const t of ['add_plan', 'move_plan', 'cancel_plan']) expect(screen.queryByTestId(`proposal-type-${t}`)).toBeNull();
  for (const r of ['host', 'majority', 'unanimous', 'anyone']) expect(screen.getByTestId(`proposal-rule-${r}`)).toBeTruthy();
  expect(screen.getByLabelText('Everyone must agree')).toBeTruthy();
});

it('a refusal is shown with its reason and nothing claims "Proposed"', async () => {
  const propose = jest.fn().mockResolvedValue({ state: 'refused', reason: 'trust_restriction', detail: 'You cannot propose changes on this trip right now.' });
  const onProposed = jest.fn();
  await render(<TripProposalComposer tripId="t1" propose={propose} onProposed={onProposed} />);
  await fillIn();
  await fireEvent.press(screen.getByTestId('proposal-type-other'));
  await fireEvent.press(screen.getByTestId('proposal-compose-submit'));
  await waitFor(() => screen.getByTestId('proposal-compose-refused'));
  expect(screen.getByText(/Not proposed — You cannot propose changes on this trip right now\./)).toBeTruthy();
  expect(screen.queryByTestId('proposal-compose-recorded')).toBeNull();
  expect(onProposed).not.toHaveBeenCalled();
});

it('an unreachable kernel says nothing was proposed, and Try again re-sends THE SAME proposal and key', async () => {
  const propose = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValueOnce(recorded);
  await render(<TripProposalComposer tripId="t1" propose={propose} />);
  await fillIn();
  await fireEvent.press(screen.getByTestId('proposal-type-add_commitment'));
  await fireEvent.press(screen.getByTestId('proposal-compose-submit'));
  await waitFor(() => screen.getByTestId('proposal-compose-unavailable'));
  expect(screen.getByText(/Nothing was proposed/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('proposal-compose-retry'));
  await waitFor(() => screen.getByTestId('proposal-compose-recorded'));
  expect(propose).toHaveBeenCalledTimes(2);
  expect(propose.mock.calls[1]).toEqual(propose.mock.calls[0]);
});

it('mounted in the votes card: with no open votes it is offered, and the new proposal joins the open votes once read back', async () => {
  const load = jest.fn().mockResolvedValueOnce(board([])).mockResolvedValue(board([{
    id: 'prop-1', type: 'stage_change', status: 'pending', decisionRule: 'majority', proposedBy: 'me', expiresAt: null,
    payload: { title: 'Leave Hoi An a day early' }, myVote: null, tally: { found: true, decision_rule: 'majority', electorate: 3, yes: 0, no: 0, abstain: 0, cast: 0, majority_met: false },
  }]));
  const propose = jest.fn().mockResolvedValue(recorded);
  await render(<TripBallotsCard tripId="t1" isOwner={false} load={load} propose={propose} />);
  await waitFor(() => screen.getByTestId('trip-ballots-empty'));
  await fillIn();
  await fireEvent.press(screen.getByTestId('proposal-type-stage_change'));
  await fireEvent.press(screen.getByTestId('proposal-compose-submit'));
  await waitFor(() => screen.getByTestId('ballot-prop-1'));
  expect(screen.getByText('Leave Hoi An a day early')).toBeTruthy();
  expect(screen.getByText('Rule: majority of the crew')).toBeTruthy();
  // the composer kept its place: the confirmation survived the card's re-read
  expect(screen.getByTestId('proposal-compose-recorded')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});
