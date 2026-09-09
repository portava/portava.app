/**
 * TripStageSpineCard — §5.1 reaching a screen.
 *
 * Three things a tidier card would get wrong, pinned here:
 *   an ORPHANED reference is displayed, not swallowed — the FKs make it
 *     impossible, which is exactly why silence about one is a dropped row
 *   a stage with NO dates says so, rather than rendering a blank range
 *   the party size is `goingUserIds`, not participants.length — counting
 *     `interested` and `maybe` books transport for six people who are four
 *
 * RNTL v14: always await render().
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { TripStageSpineCard, stageDates } from '../trip/TripStageSpineCard.tsx';
import type { StructureRead, TripStructure } from '../../services/tripDecisions.ts';

const TRIP_ID = 'trip-spine-test';

function structure(over: Partial<TripStructure> = {}): TripStructure {
  return {
    tripId: TRIP_ID,
    stages: [], legs: [], commitments: [], planAttendance: [], outcomes: [],
    orphanedLegs: [], orphanedCommitments: [], orphanedAttendance: [],
    ...over,
  };
}
const stage = (o: Partial<TripStructure['stages'][number]> = {}): TripStructure['stages'][number] => ({
  id: 's1', stageType: 'city', placeId: null, cityId: 'c1', timezone: 'Europe/Paris',
  startsAt: null, endsAt: null, state: 'planned', sequence: 1,
  legsFrom: [], legsTo: [], commitmentIds: [], ...o,
});

const loader = (r: StructureRead) => jest.fn(async () => r);
const ok = (s: TripStructure): StructureRead => ({ state: 'ok', structure: s });

describe('TripStageSpineCard', () => {
  it('renders the stages with their legs and commitment counts', async () => {
    const { findByText, findByTestId } = await render(
      <TripStageSpineCard
        tripId={TRIP_ID}
        load={loader(ok(structure({
          stages: [stage({ id: 's1', sequence: 1, legsFrom: ['l1'], commitmentIds: ['c1', 'c2'] })],
          legs: [{
            id: 'l1', fromStageId: 's1', toStageId: 's2', legType: 'train',
            startsAt: null, endsAt: null, sourceRef: null,
          }],
        })))}
      />,
    );
    expect(await findByTestId('stage-s1')).toBeTruthy();
    expect(await findByText(/2 commitments/)).toBeTruthy();
    expect(await findByText('train')).toBeTruthy();
  });

  it('a stage with no dates says so rather than rendering a blank range', async () => {
    // A stage nobody has dated is not a zero-length stage.
    const { findByText } = await render(
      <TripStageSpineCard tripId={TRIP_ID} load={loader(ok(structure({ stages: [stage()] })))} />,
    );
    expect(await findByText(/no dates yet/)).toBeTruthy();
  });

  it('an ORPHANED reference is displayed, not tidied away', async () => {
    const { findByTestId, findByText } = await render(
      <TripStageSpineCard
        tripId={TRIP_ID}
        load={loader(ok(structure({
          stages: [stage()],
          orphanedLegs: ['l-bad'], orphanedAttendance: ['pi:u'],
        })))}
      />,
    );
    expect(await findByTestId('trip-spine-orphans')).toBeTruthy();
    expect(await findByText(/2 items point somewhere missing/)).toBeTruthy();
    expect(await findByText(/should not be possible/)).toBeTruthy();
  });

  it('the party size is goingUserIds, not the participant count', async () => {
    const { findByText } = await render(
      <TripStageSpineCard
        tripId={TRIP_ID}
        load={loader(ok(structure({
          stages: [stage()],
          planAttendance: [{
            planId: 'pi1',
            participants: [
              { userId: 'a', attendanceState: 'going', role: null },
              { userId: 'b', attendanceState: 'interested', role: null },
              { userId: 'c', attendanceState: 'maybe', role: null },
            ],
            goingUserIds: ['a'],
          }],
        })))}
      />,
    );
    // One, not three.
    expect(await findByText(/1 plan attendance confirmed/)).toBeTruthy();
  });

  it('commitments with no stage are named, not shown as an empty card', async () => {
    const { findByText } = await render(
      <TripStageSpineCard
        tripId={TRIP_ID}
        load={loader(ok(structure({
          commitments: [{
            id: 'c1', stageId: null, type: 'event', startsAt: null, requiredArrivalAt: null,
            placeId: null, latenessTolerance: null, prepDuration: null,
            flexibility: 'flexible', confidence: null, sourceRef: null,
          }],
        })))}
      />,
    );
    expect(await findByText(/1 commitment not attached to a stage yet/)).toBeTruthy();
  });

  it("an unavailable read says so, and denies meaning 'this trip has no stages'", async () => {
    const { findByTestId, findByText } = await render(
      <TripStageSpineCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'HTTP 503' })} />,
    );
    expect(await findByTestId('trip-spine-unavailable')).toBeTruthy();
    expect(await findByText(/isn't the same as it having none/)).toBeTruthy();
  });

  it('an unexpected throw is unavailable, never off', async () => {
    const { findByTestId } = await render(
      <TripStageSpineCard tripId={TRIP_ID} load={(jest.fn(async () => { throw new Error('x'); })) as any} />,
    );
    expect(await findByTestId('trip-spine-unavailable')).toBeTruthy();
  });

  it('renders nothing when the structure was READ and is genuinely empty', async () => {
    const { toJSON, queryByTestId } = await render(
      <TripStageSpineCard tripId={TRIP_ID} load={loader(ok(structure()))} />,
    );
    await waitFor(() => expect(queryByTestId('trip-spine-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });
});

describe('stageDates', () => {
  it('says which end is known when only one is', () => {
    expect(stageDates('2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')).toBe('2026-10-01 → 2026-10-05');
    expect(stageDates('2026-10-01T00:00:00Z', null)).toBe('from 2026-10-01');
    expect(stageDates(null, '2026-10-05T00:00:00Z')).toBe('until 2026-10-05');
  });

  it('never renders a blank range for a stage nobody has dated', () => {
    expect(stageDates(null, null)).toBe('no dates yet');
  });
});
