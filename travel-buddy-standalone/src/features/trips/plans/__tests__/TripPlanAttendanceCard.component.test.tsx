/**
 * census-trips TR149 (§9.1 attendance; populates TR83): TripPlanAttendanceCard
 * — who's going on each plan, and the viewer's own answer, set through the
 * kernel and shown only on its word.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripPlanAttendanceCard } from '../TripPlanAttendanceCard.tsx';
import type { StructureRead, TripStructure } from '../../planning/tripDecisions.ts';
import type { TripPlanResult } from '../../planning/tripPlan.ts';

const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const P3 = '77777777-7777-4777-8777-777777777777';
const recorded = { state: 'recorded' as const, duplicate: false };

function plans(items: Array<{ id: string; title: string; status?: string }>): TripPlanResult {
  return { items: items.map((p) => ({ status: 'tentative', ...p })) as unknown as TripPlanResult['items'], canEdit: true };
}
function structureOf(planAttendance: TripStructure['planAttendance']): StructureRead {
  return { state: 'ok', structure: { tripId: 't1', stages: [], legs: [], commitments: [], planAttendance, outcomes: [], orphanedLegs: [], orphanedCommitments: [], orphanedAttendance: [] } };
}

it('lists open plans with the server\'s going count and the viewer\'s own answer; closed plans are not offered', async () => {
  const loadPlans = jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }, { id: P2, title: 'Boat trip' }, { id: P3, title: 'Museum', status: 'cancelled' }]));
  const loadStructure = jest.fn().mockResolvedValue(structureOf([
    { planId: P1, participants: [{ userId: 'me', attendanceState: 'maybe', role: null }, { userId: 'ana', attendanceState: 'going', role: null }, { userId: 'bo', attendanceState: 'interested', role: null }], goingUserIds: ['ana'] },
  ]));
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={loadPlans} loadStructure={loadStructure} />);
  await waitFor(() => screen.getByTestId('plan-attendance-card'));
  expect(screen.getByTestId(`plan-attendance-summary-${P1}`).props.children).toEqual(['1 going', ' · ', 'You: Maybe']);
  expect(screen.getByTestId(`plan-attendance-summary-${P2}`).props.children).toEqual(['No one has answered yet', ' · ', "You haven't answered"]);
  expect(screen.queryByTestId(`plan-attendance-${P3}`)).toBeNull();
  expect(screen.getByTestId(`plan-attendance-${P1}-maybe`).props.accessibilityState).toEqual({ selected: true, disabled: true });
  expect(screen.getByTestId(`plan-attendance-${P1}-leave`)).toBeTruthy();
  expect(screen.queryByTestId(`plan-attendance-${P2}-leave`)).toBeNull();
  expect(screen.getByLabelText("Can't go — Boat trip")).toBeTruthy();
});

it('answering sends the viewer\'s move with a fresh key, says "Answer saved" on the kernel\'s word, and re-reads who is going', async () => {
  const loadStructure = jest.fn()
    .mockResolvedValueOnce(structureOf([]))
    .mockResolvedValue(structureOf([{ planId: P1, participants: [{ userId: 'me', attendanceState: 'going', role: null }], goingUserIds: ['me'] }]));
  const answer = jest.fn().mockResolvedValue(recorded);
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]))} loadStructure={loadStructure} answer={answer} />);
  await waitFor(() => screen.getByTestId(`plan-attendance-${P1}-going`));
  await fireEvent.press(screen.getByTestId(`plan-attendance-${P1}-going`));
  await waitFor(() => screen.getByTestId(`plan-attendance-recorded-${P1}`));
  expect(answer).toHaveBeenCalledWith('t1', P1, null, 'going', expect.stringMatching(new RegExp(`^attendance:${P1}:going:`)));
  expect(screen.getByText('Answer saved')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId(`plan-attendance-summary-${P1}`).props.children).toEqual(['1 going', ' · ', 'You: Going']));
});

it('Leave sends the leave from the answer held, and says so', async () => {
  const answer = jest.fn().mockResolvedValue(recorded);
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]))}
    loadStructure={jest.fn().mockResolvedValue(structureOf([{ planId: P1, participants: [{ userId: 'me', attendanceState: 'going', role: null }], goingUserIds: ['me'] }]))} answer={answer} />);
  await waitFor(() => screen.getByTestId(`plan-attendance-${P1}-leave`));
  await fireEvent.press(screen.getByTestId(`plan-attendance-${P1}-leave`));
  await waitFor(() => screen.getByText('You left this plan'));
  expect(answer).toHaveBeenCalledWith('t1', P1, 'going', 'leave', expect.any(String));
});

it('a refusal is shown with its reason and nothing claims an answer', async () => {
  const answer = jest.fn().mockResolvedValue({ state: 'refused', reason: 'TRIP_PLAN_NOT_FOUND', detail: 'that plan is no longer on this trip' });
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]))} loadStructure={jest.fn().mockResolvedValue(structureOf([]))} answer={answer} />);
  await waitFor(() => screen.getByTestId(`plan-attendance-${P1}-maybe`));
  await fireEvent.press(screen.getByTestId(`plan-attendance-${P1}-maybe`));
  await waitFor(() => screen.getByTestId(`plan-attendance-refused-${P1}`));
  expect(screen.getByText(/Not changed — that plan is no longer on this trip/)).toBeTruthy();
  expect(screen.queryByTestId(`plan-attendance-recorded-${P1}`)).toBeNull();
});

it('an unreachable kernel says nothing was changed, and Try again re-sends THE SAME answer and key', async () => {
  const answer = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValueOnce(recorded);
  const loadStructure = jest.fn().mockResolvedValue(structureOf([]));
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]))} loadStructure={loadStructure} answer={answer} />);
  await waitFor(() => screen.getByTestId(`plan-attendance-${P1}-cant_go`));
  await fireEvent.press(screen.getByTestId(`plan-attendance-${P1}-cant_go`));
  await waitFor(() => screen.getByTestId(`plan-attendance-unavailable-${P1}`));
  expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
  expect(loadStructure).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId(`plan-attendance-retry-${P1}`));
  await waitFor(() => screen.getByText('Answer saved'));
  expect(answer).toHaveBeenCalledTimes(2);
  expect(answer.mock.calls[1]).toEqual(answer.mock.calls[0]);
});

it('a failed read of the plans or of who is going is said, not drawn as nobody going; Try again reads both again', async () => {
  const loadPlans = jest.fn().mockRejectedValueOnce(new Error('fetchTripPlan 503')).mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]));
  const loadStructure = jest.fn().mockResolvedValue(structureOf([]));
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={loadPlans} loadStructure={loadStructure} />);
  await waitFor(() => screen.getByTestId('plan-attendance-read-failed'));
  expect(screen.getByText(/fetchTripPlan 503\. That isn.t the same as nobody going/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('plan-attendance-reread'));
  await waitFor(() => screen.getByTestId('plan-attendance-card'));
  expect(loadStructure).toHaveBeenCalledTimes(2);
});

it('signed out draws nothing; a trip with no open plans draws nothing', async () => {
  const { unmount } = await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner' }]))} loadStructure={jest.fn().mockResolvedValue({ state: 'off' })} />);
  await waitFor(() => expect(screen.queryByTestId('plan-attendance-loading')).toBeNull());
  expect(screen.queryByTestId('plan-attendance-card')).toBeNull();
  await unmount();
  await render(<TripPlanAttendanceCard tripId="t1" currentUserId="me" loadPlans={jest.fn().mockResolvedValue(plans([{ id: P1, title: 'Dinner', status: 'done' }]))} loadStructure={jest.fn().mockResolvedValue(structureOf([]))} />);
  await waitFor(() => expect(screen.queryByTestId('plan-attendance-loading')).toBeNull());
  expect(screen.queryByTestId('plan-attendance-card')).toBeNull();
});
