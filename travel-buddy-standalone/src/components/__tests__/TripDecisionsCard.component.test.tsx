/**
 * TripDecisionsCard — §8 reaching a screen without becoming reassurance there.
 *
 * The engine returns three outcomes and the middle one is the fragile one:
 * INSUFFICIENT_BASIS says the question was not answerable on what was
 * available. The natural UI mistake is to render nothing for it, or a neutral
 * grey row, both of which read to a user as "no problem here". Every test
 * below is that mistake, in one of its forms.
 *
 * RNTL v14: always await render().
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { TripDecisionsCard } from '../trip/TripDecisionsCard.tsx';
import type { DecisionRead, DecisionBoard } from '../../services/tripDecisions.ts';

const TRIP_ID = 'trip-decisions-test';

function board(over: Partial<DecisionBoard> = {}): DecisionBoard {
  return {
    tripId: TRIP_ID,
    asOf: '2026-10-01T12:00:00.000Z',
    goals: [],
    decisionTasks: [{
      id: 't1', type: 'booking', deadlineAt: null,
      consequence: null, assignedUserId: null, status: 'pending',
    }],
    risks: [],
    proposals: [],
    tallyFailures: 0,
    recommendations: [],
    elementRisks: [],
    ...over,
  };
}

const loader = (read: DecisionRead) => jest.fn(async () => read);
const ok = (b: DecisionBoard): DecisionRead => ({ state: 'ok', board: b });

describe('TripDecisionsCard', () => {
  it('renders INSUFFICIENT_BASIS in words, and shows its reason', async () => {
    // The whole point. Not a blank, not a grey nothing.
    const { findByText } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          recommendations: [{
            decisionTaskId: 't1', kind: 'INSUFFICIENT_BASIS', proposalId: null,
            reasons: ['TIED_ON_AVAILABLE_EVIDENCE'], options: [],
          }],
        })))}
      />,
    );
    expect(await findByText(/Not enough to go on yet/)).toBeTruthy();
    expect(await findByText(/tied on what we know/)).toBeTruthy();
  });

  it('DO_NOT_RECOMMEND is not softened into a shrug', async () => {
    const { findByText } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          recommendations: [{
            decisionTaskId: 't1', kind: 'DO_NOT_RECOMMEND', proposalId: null,
            reasons: ['ALL_OPTIONS_DISQUALIFIED'], options: [],
          }],
        })))}
      />,
    );
    expect(await findByText(/None of these work/)).toBeTruthy();
    expect(await findByText(/every option was ruled out/)).toBeTruthy();
  });

  it("a recommendation shows its GROUNDS, not just its verdict", async () => {
    // Advice whose reasons are hidden is an instruction.
    const { findByText } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          recommendations: [{
            decisionTaskId: 't1', kind: 'RECOMMEND', proposalId: 'p1',
            reasons: ['SERVES_GOAL'], options: [],
          }],
          proposals: [{
            id: 'p1', type: 'add_plan', status: 'pending', decisionRule: 'majority',
            proposedBy: 'u1', expiresAt: null, payload: {},
            tally: { found: true, majority_met: true, electorate: 3, yes: 2, no: 0, abstain: 0, cast: 2 },
          }],
        })))}
      />,
    );
    expect(await findByText(/Recommended/)).toBeTruthy();
    expect(await findByText(/serves a goal you set/)).toBeTruthy();
    expect(await findByText(/ready to accept/)).toBeTruthy();
  });

  it("a missing vote tally says 'we couldn't check', never 'not yet agreed'", async () => {
    // NULL is not false. Those are different things to tell someone who is
    // holding a decision open.
    const { findByText } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          recommendations: [{
            decisionTaskId: 't1', kind: 'RECOMMEND', proposalId: 'p1',
            reasons: ['SERVES_GOAL'], options: [],
          }],
          proposals: [{
            id: 'p1', type: 'add_plan', status: 'pending', decisionRule: 'majority',
            proposedBy: 'u1', expiresAt: null, payload: {}, tally: null,
          }],
          tallyFailures: 1,
        })))}
      />,
    );
    expect(await findByText(/couldn't check the vote/)).toBeTruthy();
    // And the absence is stated at card level too, so it is not something a
    // reader has to infer from one row.
    expect(await findByText(/vote count could not be read/)).toBeTruthy();
  });

  it('§8.4: open risks and the plan elements they reach are both shown', async () => {
    const { findByText, findByTestId } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          risks: [
            { id: 'r1', likelihood: 'low', impact: 'high', status: 'open', trigger: {}, mitigation: {} },
            { id: 'r2', likelihood: 'high', impact: 'low', status: 'closed', trigger: {}, mitigation: {} },
          ],
          elementRisks: [{ elementId: 'e1', riskIds: ['r1'], worstImpact: 'high', worstLikelihood: 'low' }],
        })))}
      />,
    );
    expect(await findByTestId('trip-decisions-risks')).toBeTruthy();
    // Only the OPEN one is counted.
    expect(await findByText(/1 open risk/)).toBeTruthy();
    expect(await findByText(/1 plan element affected/)).toBeTruthy();
  });

  it('a risk register that names no element says so, rather than implying none exist', async () => {
    const { findByText } = await render(
      <TripDecisionsCard
        tripId={TRIP_ID}
        load={loader(ok(board({
          risks: [{ id: 'r1', likelihood: 'low', impact: 'high', status: 'open', trigger: {}, mitigation: {} }],
          elementRisks: [],
        })))}
      />,
    );
    expect(await findByText(/None of them names a plan element yet/)).toBeTruthy();
  });

  it("an unavailable read says so, and denies meaning 'nothing pending'", async () => {
    const { findByText, findByTestId } = await render(
      <TripDecisionsCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'HTTP 503' })} />,
    );
    expect(await findByTestId('trip-decisions-unavailable')).toBeTruthy();
    expect(await findByText(/isn't the same as nothing/)).toBeTruthy();
  });

  it('an unexpected throw is unavailable, never off', async () => {
    const { findByTestId } = await render(
      <TripDecisionsCard tripId={TRIP_ID} load={(jest.fn(async () => { throw new Error('x'); })) as any} />,
    );
    expect(await findByTestId('trip-decisions-unavailable')).toBeTruthy();
  });

  it('renders nothing when the board was READ and is genuinely empty', async () => {
    // The one honest empty state: nothing is pending and no risk is open.
    // Distinct from `off` and from `unavailable`, both of which are also blank
    // — but only this one is a measurement.
    const { toJSON, queryByTestId } = await render(
      <TripDecisionsCard tripId={TRIP_ID} load={loader(ok(board()))} />,
    );
    await waitFor(() => expect(queryByTestId('trip-decisions-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });
});
