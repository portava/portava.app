/**
 * census-trips TR13 / TR65: TripStageControls — a stage can be dated in its own
 * time zone and started and completed, and the screen says so only on the
 * kernel's word.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripStageControls } from '../TripStageControls.tsx';
import type { StructureRead, TripStructure } from '../../planning/tripDecisions.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const recorded = { state: 'recorded' as const, duplicate: false };

function stage(id: string, sequence: number, over: Partial<TripStructure['stages'][number]> = {}): TripStructure['stages'][number] {
  return { id, stageType: 'city', placeId: null, cityId: 'c', timezone: 'Asia/Ho_Chi_Minh', startsAt: null, endsAt: null, state: 'planned', sequence, legsFrom: [], legsTo: [], commitmentIds: [], ...over };
}
function structureOf(stages: TripStructure['stages']): StructureRead {
  return { state: 'ok', structure: { tripId: 't1', stages, legs: [], commitments: [], planAttendance: [], outcomes: [], orphanedLegs: [], orphanedCommitments: [], orphanedAttendance: [] } };
}

it('shows each stage\'s state and its boundaries in the stage\'s own zone, and offers the one arrow its state allows', async () => {
  const load = jest.fn().mockResolvedValue(structureOf([
    stage(S2, 2, { state: 'active', stageType: 'lodging' }),
    stage(S1, 1, { startsAt: '2026-10-20T07:00:00+00:00', endsAt: '2026-10-23T04:00:00+00:00' }),
  ]));
  await render(<TripStageControls tripId="t1" load={load} />);
  await waitFor(() => screen.getByTestId('stage-controls'));
  expect(screen.getByText('1. City · Planned')).toBeTruthy();
  expect(screen.getByTestId(`stage-control-dates-${S1}`).props.children).toEqual(['Starts ', 'Tue 20 Oct 2026, 14:00', ' · Ends ', 'Fri 23 Oct 2026, 11:00', ' — ', 'Asia/Ho_Chi_Minh']);
  expect(screen.getByTestId(`stage-control-dates-${S2}`).props.children).toEqual(['Starts ', 'not set', ' · Ends ', 'not set', ' — ', 'Asia/Ho_Chi_Minh']);
  expect(screen.getByLabelText('Start stage 1. City')).toBeTruthy();
  expect(screen.queryByTestId(`stage-control-complete-${S1}`)).toBeNull();
  expect(screen.getByLabelText('Complete stage 2. Lodging')).toBeTruthy();
  expect(screen.queryByTestId(`stage-control-start-${S2}`)).toBeNull();
});

it('Start stage sends START_STAGE for that stage, says "Started" on the kernel\'s word, and re-reads', async () => {
  const load = jest.fn()
    .mockResolvedValueOnce(structureOf([stage(S1, 1)]))
    .mockResolvedValue(structureOf([stage(S1, 1, { state: 'active' })]));
  const move = jest.fn().mockResolvedValue(recorded);
  const onChanged = jest.fn();
  await render(<TripStageControls tripId="t1" load={load} move={move} onChanged={onChanged} />);
  await waitFor(() => screen.getByTestId(`stage-control-start-${S1}`));
  await fireEvent.press(screen.getByTestId(`stage-control-start-${S1}`));
  await waitFor(() => screen.getByTestId(`stage-control-recorded-${S1}`));
  expect(move).toHaveBeenCalledWith('t1', S1, 'planned', 'start', expect.stringMatching(new RegExp(`^stage-control:${S1}:start:`)));
  expect(screen.getByText('Started')).toBeTruthy();
  expect(onChanged).toHaveBeenCalledTimes(1);
  await waitFor(() => screen.getByText('1. City · In progress'));
  expect(screen.getByLabelText('Complete stage 1. City')).toBeTruthy();
});

it('Set dates: the typed wall times are read back in the stage\'s zone and only the boundaries that changed are sent', async () => {
  const load = jest.fn().mockResolvedValue(structureOf([stage(S1, 1, { startsAt: '2026-10-20T07:00:00+00:00' })]));
  const setBounds = jest.fn().mockResolvedValue(recorded);
  await render(<TripStageControls tripId="t1" load={load} setBounds={setBounds} />);
  await waitFor(() => screen.getByTestId(`stage-control-edit-${S1}`));
  await fireEvent.press(screen.getByTestId(`stage-control-edit-${S1}`));
  // the start is prefilled as the stage's wall clock; nothing changed yet, so nothing can be saved
  expect(screen.getByTestId(`stage-control-starts-${S1}-date`).props.value).toBe('2026-10-20');
  expect(screen.getByTestId(`stage-control-starts-${S1}-time`).props.value).toBe('14:00');
  expect(screen.getByTestId(`stage-control-save-${S1}`).props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-date`), '2026-10-23');
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-time`), '11:00');
  expect(screen.getByTestId(`stage-control-ends-${S1}-reads`).props.children).toEqual(['Fri 23 Oct 2026', ', ', '11:00', ' (', 'GMT+7', ')']);
  await fireEvent.press(screen.getByTestId(`stage-control-save-${S1}`));
  await waitFor(() => screen.getByText('Dates saved'));
  expect(setBounds).toHaveBeenCalledWith('t1', S1,
    { startsAt: '2026-10-20T07:00:00+00:00', endsAt: null },
    { startsAt: '2026-10-20T14:00:00+07:00', endsAt: '2026-10-23T11:00:00+07:00' },
    expect.stringMatching(/^stage-control:.*:dates:/));
});

it('an end before the start, a skipped time and an ambiguous time each keep Save disabled and say why; a picked one is sent', async () => {
  const load = jest.fn().mockResolvedValue(structureOf([stage(S1, 1, { timezone: 'Europe/Lisbon' })]));
  const setBounds = jest.fn().mockResolvedValue(recorded);
  await render(<TripStageControls tripId="t1" load={load} setBounds={setBounds} />);
  await waitFor(() => screen.getByTestId(`stage-control-edit-${S1}`));
  await fireEvent.press(screen.getByTestId(`stage-control-edit-${S1}`));
  const save = () => screen.getByTestId(`stage-control-save-${S1}`).props.accessibilityState;
  await fireEvent.changeText(screen.getByTestId(`stage-control-starts-${S1}-date`), '2026-10-24');
  await fireEvent.changeText(screen.getByTestId(`stage-control-starts-${S1}-time`), '10:00');
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-date`), '2026-10-23');
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-time`), '10:00');
  expect(screen.getByTestId(`stage-control-problem-${S1}`).props.children).toBe('The stage would end before it starts.');
  expect(save()).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-date`), '2027-03-28');
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-time`), '01:30');
  expect(screen.getByTestId(`stage-control-ends-${S1}-problem`).props.children).toMatch(/doesn't happen that day in Europe\/Lisbon — the clocks go forward/);
  expect(save()).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId(`stage-control-ends-${S1}-date`), '2026-10-25');
  expect(screen.getByTestId(`stage-control-ends-${S1}-problem`).props.children).toMatch(/happens twice that day in Europe\/Lisbon/);
  expect(save()).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId(`stage-control-ends-${S1}-pick-later`));
  await fireEvent.changeText(screen.getByTestId(`stage-control-starts-${S1}-date`), '2026-10-24');
  expect(save()).toEqual({ disabled: false });
  await fireEvent.press(screen.getByTestId(`stage-control-save-${S1}`));
  await waitFor(() => expect(setBounds).toHaveBeenCalledTimes(1));
  expect(setBounds.mock.calls[0][3]).toEqual({ startsAt: '2026-10-24T10:00:00+01:00', endsAt: '2026-10-25T01:30:00+00:00' });
});

it('a refusal is shown with its reason and nothing claims a change; the stage is read again', async () => {
  const load = jest.fn().mockResolvedValue(structureOf([stage(S1, 1)]));
  const move = jest.fn().mockResolvedValue({ state: 'refused', reason: 'TRIP_STAGE_INVALID_TRANSITION', detail: 'the stage has moved on since this screen read it' });
  const onChanged = jest.fn();
  await render(<TripStageControls tripId="t1" load={load} move={move} onChanged={onChanged} />);
  await waitFor(() => screen.getByTestId(`stage-control-start-${S1}`));
  await fireEvent.press(screen.getByTestId(`stage-control-start-${S1}`));
  await waitFor(() => screen.getByTestId(`stage-control-refused-${S1}`));
  expect(screen.getByText(/Not changed — the stage has moved on since this screen read it/)).toBeTruthy();
  expect(screen.queryByTestId(`stage-control-recorded-${S1}`)).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it('an unreachable kernel says nothing was changed, and Try again re-sends THE SAME command and key', async () => {
  const load = jest.fn().mockResolvedValue(structureOf([stage(S1, 1, { state: 'active' })]));
  const move = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValueOnce(recorded);
  await render(<TripStageControls tripId="t1" load={load} move={move} />);
  await waitFor(() => screen.getByTestId(`stage-control-complete-${S1}`));
  await fireEvent.press(screen.getByTestId(`stage-control-complete-${S1}`));
  await waitFor(() => screen.getByTestId(`stage-control-unavailable-${S1}`));
  expect(screen.getByText(/Nothing was changed/)).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId(`stage-control-retry-${S1}`));
  await waitFor(() => screen.getByText('Completed'));
  expect(move).toHaveBeenCalledTimes(2);
  expect(move.mock.calls[1]).toEqual(move.mock.calls[0]);
});

it('a structure read that failed is said, not drawn as no stages; Try again reads again; an empty trip draws nothing', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' }).mockResolvedValueOnce(structureOf([stage(S1, 1)]));
  const { unmount } = await render(<TripStageControls tripId="t1" load={load} />);
  await waitFor(() => screen.getByTestId('stage-controls-read-failed'));
  expect(screen.getByText(/Couldn.t read this trip.s stages — HTTP 503/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('stage-controls-reread'));
  await waitFor(() => screen.getByTestId('stage-controls'));
  await unmount();
  await render(<TripStageControls tripId="t1" load={jest.fn().mockResolvedValue(structureOf([]))} />);
  await waitFor(() => expect(screen.queryByTestId('stage-controls-loading')).toBeNull());
  expect(screen.queryByTestId('stage-controls')).toBeNull();
});

it('a stage whose zone cannot be computed here is not offered for dating, so an empty field can never clear its dates', async () => {
  await render(<TripStageControls tripId="t1" load={jest.fn().mockResolvedValue(structureOf([stage(S1, 1, { timezone: 'Not/AZone', startsAt: '2026-10-20T07:00:00+00:00' })]))} />);
  await waitFor(() => screen.getByTestId('stage-controls'));
  expect(screen.getByTestId(`stage-control-zone-unusable-${S1}`)).toBeTruthy();
  expect(screen.queryByTestId(`stage-control-edit-${S1}`)).toBeNull();
  expect(screen.getByTestId(`stage-control-dates-${S1}`).props.children[1]).toBe('2026-10-20T07:00:00+00:00');
});

// Independent verification (wave 5, pass 2), hardening: a served boundary this
// phone cannot parse would prefill as an empty field and CLEAR that boundary on
// Save. Such a stage is not offered for dating, exactly like an unusable zone.
it('a stage whose served boundary cannot be parsed is not offered for dating', async () => {
  await render(<TripStageControls tripId="t1" load={jest.fn().mockResolvedValue(structureOf([stage(S1, 1, { startsAt: 'not-an-instant' })]))} />);
  await waitFor(() => screen.getByTestId('stage-controls'));
  expect(screen.queryByTestId(`stage-control-edit-${S1}`)).toBeNull();
  expect(screen.getByTestId(`stage-control-zone-unusable-${S1}`).props.children).toBe('This stage\'s saved dates can\'t be read on this phone, so they can\'t be changed here.');
});
