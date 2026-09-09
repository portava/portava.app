/**
 * TripFeasibilityCard — §7 reaching a screen, and telling the truth there.
 *
 * The engine behind this card has 44 tests and the route has 13, and until this
 * card existed NONE of it was reachable from the product: no client file named
 * /feasibility at all. A capability nothing can display is a library.
 *
 * What is pinned here is what the card is allowed to SAY:
 *
 *   - INFEASIBLE is the one proven verdict and is drawn as an alarm
 *   - FEASIBLE_UNVERIFIED never appears without the server's disclosure, or it
 *     reads as "checked and fine" — a measurement nobody made
 *   - UNKNOWN renders; it does not hide, because a hidden card and a clean
 *     card look identical
 *   - an unavailable READ says so, and explicitly denies being reassurance
 *   - only `off` renders nothing
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { TripFeasibilityCard } from '../trip/TripFeasibilityCard.tsx';
import type { FeasibilityRead, FeasibilityReport } from '../../services/tripFeasibility.ts';

const TRIP_ID = 'trip-feasibility-test';
const DISCLOSURE =
  'Travel times are straight-line lower bounds, not measured routes. A schedule shown as workable may still not be.';

function report(over: Partial<FeasibilityReport> = {}): FeasibilityReport {
  return {
    tripId: TRIP_ID,
    commitmentCount: 2,
    evaluatedHops: 1,
    verdict: 'FEASIBLE_UNVERIFIED',
    confidence: 'LOW',
    worstSlackMinutes: 12,
    offendingHopIndex: null,
    hops: [],
    unresolvedPlaceIds: [],
    provider: { id: 'straight-line', routed: false },
    disclosure: DISCLOSURE,
    // Route availability is UNCHECKABLE in every real response, so the default
    // fixture carries it. A fixture that omitted it would be testing a shape
    // the server never sends.
    consistency: {
      verdict: 'UNCHECKABLE' as const,
      findings: [{
        check: 'ROUTE_AVAILABILITY', verdict: 'UNCHECKABLE' as const,
        reason: 'NO_TRANSPORT_MODE_POLICY', planIds: [], stageId: null,
        detail: 'Nothing in this system records which transport modes a trip will or will not use.',
      }],
    },
    ...over,
  };
}

const loader = (read: FeasibilityRead) => jest.fn(async () => read);

describe('TripFeasibilityCard', () => {
  it('renders nothing ONLY when the feature is off', async () => {
    const { toJSON, queryByTestId } = await render(
      <TripFeasibilityCard tripId={TRIP_ID} load={loader({ state: 'off' })} />,
    );
    await waitFor(() => expect(queryByTestId('trip-feasibility-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });

  it('says the check failed — and denies that this means the schedule is fine', async () => {
    // The forbidden shape: a card that disappears on a failed read looks
    // exactly like a card that checked and found nothing wrong. The thing being
    // hidden here is "you cannot get there in time".
    const { findByText, getByTestId } = await render(
      <TripFeasibilityCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'HTTP 503' })} />,
    );
    expect(await findByText(/Schedule check unavailable/)).toBeTruthy();
    expect(await findByText(/not a sign that they do/)).toBeTruthy();
    expect(getByTestId('trip-feasibility-unavailable')).toBeTruthy();
  });

  it('an unexpected throw is unavailable, never off', async () => {
    const throwing = jest.fn(async () => { throw new Error('boom'); });
    const { findByTestId } = await render(
      <TripFeasibilityCard tripId={TRIP_ID} load={throwing as any} />,
    );
    expect(await findByTestId('trip-feasibility-unavailable')).toBeTruthy();
  });

  it('INFEASIBLE names the shortfall and the offending hop', async () => {
    const { findByText } = await render(
      <TripFeasibilityCard
        tripId={TRIP_ID}
        load={loader({
          state: 'ok',
          report: report({ verdict: 'INFEASIBLE', worstSlackMinutes: -14, offendingHopIndex: 0, evaluatedHops: 3 }),
        })}
      />,
    );
    expect(await findByText(/doesn't work — you're 14 min short/)).toBeTruthy();
    expect(await findByText(/tightest hop is #1 of 3/)).toBeTruthy();
  });

  it('FEASIBLE_UNVERIFIED never appears without the disclosure', async () => {
    // Without this sentence the headline reads as "checked and fine". The
    // journey was checked against a straight-line LOWER BOUND; the real one is
    // longer by an unknown amount.
    const { findByText } = await render(
      <TripFeasibilityCard tripId={TRIP_ID} load={loader({ state: 'ok', report: report() })} />,
    );
    expect(await findByText(/Nothing here is impossible on paper/)).toBeTruthy();
    expect(await findByText(/not measured routes/)).toBeTruthy();
  });

  it('UNKNOWN renders rather than hiding, and says why', async () => {
    const { findByText, getByTestId } = await render(
      <TripFeasibilityCard
        tripId={TRIP_ID}
        load={loader({
          state: 'ok',
          report: report({
            verdict: 'UNKNOWN',
            worstSlackMinutes: null,
            hops: [{
              fromCommitmentId: 'a', toCommitmentId: 'b', verdict: 'UNKNOWN',
              slackMinutes: null, travelMinutes: null, prepMinutes: 0,
              latenessToleranceMinutes: 0, usedStartAsArrival: true,
              confidence: null, unknownReason: 'NO_COORDINATES', routed: false,
            }],
          }),
        })}
      />,
    );
    expect(await findByText(/can't check this schedule yet/)).toBeTruthy();
    expect(await findByText(/no location, so travel time/)).toBeTruthy();
    expect(getByTestId('trip-feasibility-card')).toBeTruthy();
  });

  it('§7.4: an INCONSISTENT finding is rendered in words', async () => {
    const { findByText, findByTestId } = await render(
      <TripFeasibilityCard
        tripId={TRIP_ID}
        load={loader({
          state: 'ok',
          report: report({
            consistency: {
              verdict: 'INCONSISTENT',
              findings: [
                {
                  check: 'STAGE_LOCALITY_TIME', verdict: 'INCONSISTENT',
                  reason: 'PLAN_OUTSIDE_STAGE_INTERVAL', planIds: ['pi1'], stageId: 's1',
                  detail: 'This plan is scheduled outside the dates of the stage it belongs to.',
                },
                {
                  check: 'ROUTE_AVAILABILITY', verdict: 'UNCHECKABLE',
                  reason: 'NO_TRANSPORT_MODE_POLICY', planIds: [], stageId: null,
                  detail: 'No transport-mode policy exists.',
                },
              ],
            },
          }),
        })}
      />,
    );
    expect(await findByTestId('consistency-PLAN_OUTSIDE_STAGE_INTERVAL')).toBeTruthy();
    expect(await findByText(/outside the dates of the stage/)).toBeTruthy();
  });

  it('§7.4: UNCHECKABLE findings are COUNTED, not listed as warnings', async () => {
    // A list full of "we could not check this" teaches a reader to skim past
    // the entry that says "this plan is in the wrong city".
    const { findByTestId, queryByText, findByText } = await render(
      <TripFeasibilityCard
        tripId={TRIP_ID}
        load={loader({
          state: 'ok',
          report: report({
            consistency: {
              verdict: 'UNCHECKABLE',
              findings: [
                {
                  check: 'STAGE_LOCALITY_PLACE', verdict: 'UNCHECKABLE',
                  reason: 'NO_COORDINATES', planIds: ['pi1'], stageId: 's1',
                  detail: 'Either this plan or its stage has no coordinates.',
                },
                {
                  check: 'ROUTE_AVAILABILITY', verdict: 'UNCHECKABLE',
                  reason: 'NO_TRANSPORT_MODE_POLICY', planIds: [], stageId: null,
                  detail: 'No transport-mode policy exists.',
                },
              ],
            },
          }),
        })}
      />,
    );
    expect(await findByTestId('consistency-unchecked')).toBeTruthy();
    expect(await findByText(/2 consistency checks could not be run/)).toBeTruthy();
    // Counted, not spelled out one by one.
    expect(queryByText(/Either this plan or its stage has no coordinates/)).toBeNull();
  });

  it('a dangling place id is surfaced — those hops were not checked at all', async () => {
    const { findByText } = await render(
      <TripFeasibilityCard
        tripId={TRIP_ID}
        load={loader({ state: 'ok', report: report({ unresolvedPlaceIds: ['p1', 'p2'] }) })}
      />,
    );
    expect(await findByText(/2 commitments point at a place we can't find/)).toBeTruthy();
  });
});
