/**
 * TripTimelineConflictsCard — §7.3's conflicts reaching a screen. census-trips TR130.
 *
 *   - a day carrying a conflict is named with its plans and the §7.3 kind
 *   - a measured, clean timeline renders nothing (the one silence that is right)
 *   - a failed read renders as unavailable and denies being clean
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { TripTimelineConflictsCard } from '../TripTimelineConflictsCard.tsx';
import type { TimelineRead, TripTimelineRead } from '../tripTimeline.ts';

const TRIP_ID = 'trip-conflicts-test';
function timeline(over: Partial<TripTimelineRead> = {}): TripTimelineRead {
  return {
    projectionSchemaVersion: 1, generatedAt: '2026-09-13T12:00:00.000Z', sourceTripVersion: 4, freshness: 'live',
    tripId: TRIP_ID,
    days: [
      { iso: '2026-09-12', dateLabel: 'Sat 12 Sep', dateSub: 'Day 1', items: [{ id: 'a', title: 'Arrive' }], conflictIds: [] },
      { iso: '2026-09-13', dateLabel: 'Sun 13 Sep', dateSub: 'Day 2', items: [{ id: 'b', title: 'Louvre' }, { id: 'c', title: 'Lunch' }], conflictIds: ['b', 'c'] },
    ],
    conflicts: [{ kind: 'PLAN_OVERLAP', planIds: ['b', 'c'], detail: 'overlap' }],
    atRiskPlanIds: ['b', 'c'], atRiskReading: 'AT_RISK is derived, not stored',
    ...over,
  };
}
const loader = (read: TimelineRead) => jest.fn(async () => read);

describe('TripTimelineConflictsCard', () => {
  it('names the conflicted day, its plans and the kind', async () => {
    const { findByTestId, getByText } = await render(<TripTimelineConflictsCard tripId={TRIP_ID} load={loader({ state: 'ok', timeline: timeline() })} />);
    await findByTestId('trip-conflicts-card');
    expect(getByText('1 day has a conflict')).toBeTruthy();
    await findByTestId('trip-conflict-day-2026-09-13');
    expect(getByText('Sun 13 Sep · Day 2')).toBeTruthy();
    expect(getByText('Two plans overlap in time')).toBeTruthy();
    expect(getByText('Louvre / Lunch')).toBeTruthy();
    expect(getByText('AT_RISK is derived, not stored')).toBeTruthy();
  });
  it('a measured, clean timeline renders nothing', async () => {
    const { toJSON, queryByTestId } = await render(
      <TripTimelineConflictsCard tripId={TRIP_ID} load={loader({ state: 'ok', timeline: timeline({ conflicts: [], atRiskPlanIds: [], days: [{ iso: '2026-09-12', dateLabel: 'Sat 12 Sep', dateSub: 'Day 1', items: [{ id: 'a', title: 'Arrive' }], conflictIds: [] }] }) })} />,
    );
    await waitFor(() => expect(queryByTestId('trip-conflicts-loading')).toBeNull());
    expect(toJSON()).toBeNull();
  });
  it('a failed read says so and denies being clean; off renders nothing', async () => {
    const { findByTestId, getByText } = await render(<TripTimelineConflictsCard tripId={TRIP_ID} load={loader({ state: 'unavailable', detail: 'no dates' })} />);
    await findByTestId('trip-conflicts-unavailable');
    expect(getByText(/no dates\. A timeline that could not be read is not a clean one/)).toBeTruthy();
    const off = await render(<TripTimelineConflictsCard tripId={TRIP_ID} load={loader({ state: 'off' })} />);
    await waitFor(() => expect(off.queryByTestId('trip-conflicts-loading')).toBeNull());
    expect(off.toJSON()).toBeNull();
  });
});
