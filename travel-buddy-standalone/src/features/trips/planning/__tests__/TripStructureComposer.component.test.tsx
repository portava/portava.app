/**
 * census-trips TR78 / TR79 / TR81 / TR84: TripStructureComposer — the product
 * can now add a stage, a leg, a commitment and a goal, and says "Added" only
 * on the kernel's word.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripStructureComposer, type CityPickerProps } from '../TripStructureComposer.tsx';
import type { StructureRead, DecisionRead, TripStructure, DecisionBoard } from '../tripDecisions.ts';
import type { Place } from '../../../../lib/location/placeTypes.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const CITY = '33333333-3333-4333-8333-333333333333';
const recorded = { state: 'recorded' as const, duplicate: false, id: 'new-row' };

function stage(id: string, sequence: number, stageType = 'city'): TripStructure['stages'][number] {
  return { id, stageType, placeId: null, cityId: CITY, timezone: 'Europe/Lisbon', startsAt: null, endsAt: null, state: 'planned', sequence, legsFrom: [], legsTo: [], commitmentIds: [] };
}
function structureOf(stages: TripStructure['stages']): StructureRead {
  return { state: 'ok', structure: { tripId: 't1', stages, legs: [], commitments: [], planAttendance: [], outcomes: [], orphanedLegs: [], orphanedCommitments: [], orphanedAttendance: [] } };
}
function boardOf(goals: DecisionBoard['goals']): DecisionRead {
  return { state: 'ok', board: { tripId: 't1', asOf: '2026-10-17T00:00:00Z', goals, decisionTasks: [], risks: [], proposals: [], tallyFailures: 0, recommendations: [], elementRisks: [] } };
}

function placeOf(over: Partial<Place>): Place {
  return {
    id: 'nominatim:1', type: 'city', name: 'Lisbon', displayName: 'Lisbon, Portugal', country: 'Portugal', countryCode: 'PT',
    region: null, city: 'Lisbon', district: null, lat: 38.72, lng: -9.14, timezone: 'Europe/Lisbon', source: 'canonical', canonicalId: CITY,
    ...over,
  };
}
/** Stands in for GlobalPlacePicker: when open, one button that picks `place`. */
function pickerPicking(place: Place) {
  return function FakePicker({ visible, onSelect, mode, assistContext }: CityPickerProps) {
    if (!visible) return null;
    return (
      <Pressable testID="fake-picker-select" onPress={() => onSelect(place)}>
        <Text>{`pick (${mode ?? 'all'}, ${assistContext ?? 'no gateway'})`}</Text>
      </Pressable>
    );
  };
}

it('adds a stage at the next free position, anchored to the picked city and its time zone, and re-reads the spine', async () => {
  const loadStructure = jest.fn().mockResolvedValue(structureOf([stage(S1, 1), stage(S2, 2)]));
  const addStageEntry = jest.fn().mockResolvedValue(recorded);
  const onAdded = jest.fn();
  await render(<TripStructureComposer tripId="t1" loadStructure={loadStructure} addStageEntry={addStageEntry} onAdded={onAdded} PlacePicker={pickerPicking(placeOf({}))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  await fireEvent.press(screen.getByTestId('stage-type-lodging'));
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  expect(screen.getByText('pick (city, city_picker)')).toBeTruthy(); // cities only, through the canonical gateway (its rows carry a time zone)
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  expect(screen.getByText('City: Lisbon, Portugal')).toBeTruthy();
  expect(screen.getByTestId('stage-timezone').props.children).toEqual(['Time zone: ', 'Europe/Lisbon', '']);
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: false });
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addStageEntry).toHaveBeenCalledWith('t1', { stageType: 'lodging', cityId: CITY, timezone: 'Europe/Lisbon', sequence: 3 }, expect.stringMatching(/^structure-entry:stage:/));
  expect(onAdded).toHaveBeenCalledWith('stage');
  await waitFor(() => expect(loadStructure).toHaveBeenCalledTimes(2));
});

it('a city with no canonical id is not sent; a city with no time zone takes the trip\'s, said as such', async () => {
  const loadStructure = jest.fn().mockResolvedValue(structureOf([]));
  const addStageEntry = jest.fn().mockResolvedValue(recorded);
  const { unmount } = await render(<TripStructureComposer tripId="t1" loadStructure={loadStructure} addStageEntry={addStageEntry} PlacePicker={pickerPicking(placeOf({ canonicalId: null }))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  await fireEvent.press(screen.getByTestId('stage-type-city'));
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  expect(screen.getByTestId('stage-city-unmatched')).toBeTruthy();
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  expect(addStageEntry).not.toHaveBeenCalled();
  await unmount();

  await render(<TripStructureComposer tripId="t1" tripTimezone="Asia/Manila" loadStructure={loadStructure} addStageEntry={addStageEntry} PlacePicker={pickerPicking(placeOf({ timezone: null }))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  await fireEvent.press(screen.getByTestId('stage-type-city'));
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  expect(screen.getByTestId('stage-timezone').props.children).toEqual(['Time zone: ', 'Asia/Manila', " (the trip's)"]);
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addStageEntry).toHaveBeenCalledWith('t1', { stageType: 'city', cityId: CITY, timezone: 'Asia/Manila', sequence: 1 }, expect.any(String));
});

it('a city with no time zone and a trip with none: nothing is sent until the phone\'s zone is CHOSEN, and it is labelled as the phone\'s', async () => {
  const addStageEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" tripTimezone={null} deviceTimezone={() => 'Europe/Berlin'} loadStructure={jest.fn().mockResolvedValue(structureOf([]))} addStageEntry={addStageEntry} PlacePicker={pickerPicking(placeOf({ timezone: null }))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  await fireEvent.press(screen.getByTestId('stage-type-city'));
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  expect(screen.getByText('No time zone is known for that city.')).toBeTruthy();
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  expect(screen.getByLabelText("Use this phone's time zone, Europe/Berlin")).toBeTruthy();
  await fireEvent.press(screen.getByTestId('stage-timezone-device'));
  expect(screen.getByTestId('stage-timezone').props.children).toEqual(['Time zone: ', 'Europe/Berlin', " (this phone's)"]);
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addStageEntry).toHaveBeenCalledWith('t1', { stageType: 'city', cityId: CITY, timezone: 'Europe/Berlin', sequence: 1 }, expect.any(String));
});

it('a leg needs two stages; with two, it joins the chosen pair by the chosen mode', async () => {
  const one = jest.fn().mockResolvedValue(structureOf([stage(S1, 1)]));
  const { unmount } = await render(<TripStructureComposer tripId="t1" loadStructure={one} />);
  await fireEvent.press(screen.getByTestId('structure-compose-leg'));
  await waitFor(() => screen.getByTestId('structure-compose-leg-needs-stages'));
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await unmount();

  const two = jest.fn().mockResolvedValue(structureOf([stage(S2, 2, 'lodging'), stage(S1, 1)]));
  const addLegEntry = jest.fn().mockResolvedValue(recorded);
  const onAdded = jest.fn();
  await render(<TripStructureComposer tripId="t1" loadStructure={two} addLegEntry={addLegEntry} onAdded={onAdded} />);
  await fireEvent.press(screen.getByTestId('structure-compose-leg'));
  await waitFor(() => screen.getByTestId('structure-compose-leg-form'));
  expect(screen.getByLabelText('From stage 1. City')).toBeTruthy();
  expect(screen.getByLabelText('To stage 2. Lodging')).toBeTruthy();
  await fireEvent.press(screen.getByTestId(`leg-from-${S1}`));
  await fireEvent.press(screen.getByTestId(`leg-to-${S1}`));
  expect(screen.getByTestId('leg-same-stage')).toBeTruthy();
  await fireEvent.press(screen.getByTestId(`leg-to-${S2}`));
  await fireEvent.press(screen.getByTestId('leg-type-train'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addLegEntry).toHaveBeenCalledWith('t1', { legType: 'train', fromStageId: S1, toStageId: S2 }, expect.stringMatching(/^structure-entry:leg:/));
  expect(onAdded).toHaveBeenCalledWith('leg');
});

it('a commitment is added by type and flexibility (the kernel default shown selected), with or without a stage', async () => {
  const loadStructure = jest.fn().mockResolvedValue(structureOf([stage(S1, 1)]));
  const addCommitmentEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" loadStructure={loadStructure} addCommitmentEntry={addCommitmentEntry} />);
  await fireEvent.press(screen.getByTestId('structure-compose-commitment'));
  await waitFor(() => screen.getByTestId(`commitment-stage-${S1}`));
  expect(screen.getByTestId('commitment-flex-flexible').props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByTestId('commitment-stage-none').props.accessibilityState).toEqual({ selected: true });
  await fireEvent.press(screen.getByTestId('commitment-type-event'));
  await fireEvent.press(screen.getByTestId('commitment-flex-fixed'));
  await fireEvent.press(screen.getByTestId(`commitment-stage-${S1}`));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addCommitmentEntry).toHaveBeenCalledWith('t1', { type: 'event', flexibility: 'fixed', stageId: S1 }, expect.stringMatching(/^structure-entry:commitment:/));
  // the form resets to the defaults; the next one with no stage sends stageId null
  await fireEvent.press(screen.getByTestId('commitment-type-lodging'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => expect(addCommitmentEntry).toHaveBeenCalledTimes(2));
  expect(addCommitmentEntry.mock.calls[1][1]).toEqual({ type: 'lodging', flexibility: 'flexible', stageId: null });
});

it('a goal is listed and added by type, priority and whose it is; the goal list is re-read after', async () => {
  const loadDecisions = jest.fn().mockResolvedValue(boardOf([
    { id: 'g1', type: 'budget', priority: 'normal', status: 'open', evidence: {}, scope: 'shared', weight: null },
    { id: 'g2', type: 'rest', priority: 'high', status: 'met', evidence: {}, scope: 'personal', weight: 0.7 },
  ]));
  const addGoalEntry = jest.fn().mockResolvedValue(recorded);
  const onAdded = jest.fn();
  await render(<TripStructureComposer tripId="t1" loadStructure={jest.fn().mockResolvedValue(structureOf([]))} loadDecisions={loadDecisions} addGoalEntry={addGoalEntry} onAdded={onAdded} />);
  await fireEvent.press(screen.getByTestId('structure-compose-goal'));
  await waitFor(() => screen.getByTestId('goal-list'));
  expect(screen.getByTestId('goal-g1').props.children).toEqual(['Budget', ' · ', 'Normal', '', '']);
  expect(screen.getByTestId('goal-g2').props.children).toEqual(['Rest', ' · ', 'High', ' · just you', ' · met']);
  expect(screen.getByTestId('goal-priority-normal').props.accessibilityState).toEqual({ selected: true });
  await fireEvent.press(screen.getByTestId('goal-type-safety'));
  await fireEvent.press(screen.getByTestId('goal-priority-high'));
  await fireEvent.press(screen.getByTestId('goal-scope-personal'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addGoalEntry).toHaveBeenCalledWith('t1', { type: 'safety', priority: 'high', scope: 'personal' }, expect.stringMatching(/^structure-entry:goal:/));
  expect(onAdded).toHaveBeenCalledWith('goal');
  await waitFor(() => expect(loadDecisions).toHaveBeenCalledTimes(2));
});

it('a refusal is shown with its reason, nothing claims "Added", and the spine is re-read for the next try', async () => {
  const loadStructure = jest.fn().mockResolvedValue(structureOf([]));
  const addStageEntry = jest.fn().mockResolvedValue({ state: 'refused', reason: 'TRIP_STAGE_SEQUENCE_TAKEN', detail: 'another stage was added at that position first' });
  const onAdded = jest.fn();
  await render(<TripStructureComposer tripId="t1" loadStructure={loadStructure} addStageEntry={addStageEntry} onAdded={onAdded} PlacePicker={pickerPicking(placeOf({}))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  await fireEvent.press(screen.getByTestId('stage-type-transit'));
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-refused'));
  expect(screen.getByText(/Not added — another stage was added at that position first/)).toBeTruthy();
  expect(screen.queryByTestId('structure-compose-recorded')).toBeNull();
  expect(onAdded).not.toHaveBeenCalled();
  await waitFor(() => expect(loadStructure).toHaveBeenCalledTimes(2));
});

it('an unreachable kernel says nothing was added, and Try again re-sends THE SAME key and payload', async () => {
  const addGoalEntry = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' })
    .mockResolvedValueOnce(recorded);
  await render(<TripStructureComposer tripId="t1" loadStructure={jest.fn().mockResolvedValue(structureOf([]))} loadDecisions={jest.fn().mockResolvedValue(boardOf([]))} addGoalEntry={addGoalEntry} />);
  await fireEvent.press(screen.getByTestId('structure-compose-goal'));
  await waitFor(() => screen.getByTestId('goal-list-empty'));
  await fireEvent.press(screen.getByTestId('goal-type-social'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-unavailable'));
  expect(screen.getByText(/Nothing was added/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('structure-compose-retry'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addGoalEntry).toHaveBeenCalledTimes(2);
  expect(addGoalEntry.mock.calls[1][2]).toBe(addGoalEntry.mock.calls[0][2]);
  expect(addGoalEntry.mock.calls[1][1]).toEqual(addGoalEntry.mock.calls[0][1]);
});

it('a spine that could not be read is said, not drawn as a trip with no stages; Try again re-reads it', async () => {
  const loadStructure = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 503' })
    .mockResolvedValueOnce(structureOf([stage(S1, 1), stage(S2, 2)]));
  await render(<TripStructureComposer tripId="t1" loadStructure={loadStructure} />);
  await fireEvent.press(screen.getByTestId('structure-compose-leg'));
  await waitFor(() => screen.getByTestId('structure-compose-read-failed'));
  expect(screen.getByText(/Couldn.t read this trip.s stages — HTTP 503/)).toBeTruthy();
  expect(screen.queryByTestId('structure-compose-leg-needs-stages')).toBeNull();
  await fireEvent.press(screen.getByTestId('structure-compose-reread'));
  await waitFor(() => screen.getByTestId('structure-compose-leg-form'));
});

// ── census-trips TR13 / TR78: a stage's boundaries, typed in the stage's zone ──

it('a stage can carry its start and end, typed as the city\'s wall clock and sent as instants with their offset', async () => {
  const addStageEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" loadStructure={jest.fn().mockResolvedValue(structureOf([]))} addStageEntry={addStageEntry} PlacePicker={pickerPicking(placeOf({}))} />);
  await fireEvent.press(screen.getByTestId('structure-compose-stage'));
  await waitFor(() => screen.getByTestId('structure-compose-stage-form'));
  expect(screen.queryByTestId('stage-bounds-fields')).toBeNull(); // no city, no zone: no times yet
  await fireEvent.press(screen.getByTestId('stage-type-city'));
  await fireEvent.press(screen.getByTestId('stage-city-pick'));
  await fireEvent.press(screen.getByTestId('fake-picker-select'));
  expect(screen.getByText("Starts — Europe/Lisbon (the city's)")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId('stage-starts-date'), '2026-10-24');
  await fireEvent.changeText(screen.getByTestId('stage-starts-time'), '15:00');
  await fireEvent.changeText(screen.getByTestId('stage-ends-date'), '2026-10-23');
  await fireEvent.changeText(screen.getByTestId('stage-ends-time'), '11:00');
  expect(screen.getByTestId('stage-bounds-problem').props.children).toBe('The stage would end before it starts.');
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId('stage-ends-date'), '2026-10-27');
  expect(screen.getByTestId('stage-ends-reads').props.children).toEqual(['Tue 27 Oct 2026', ', ', '11:00', ' (', 'GMT', ')']);
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addStageEntry).toHaveBeenCalledWith('t1', { stageType: 'city', cityId: CITY, timezone: 'Europe/Lisbon', sequence: 1, startsAt: '2026-10-24T15:00:00+01:00', endsAt: '2026-10-27T11:00:00+00:00' }, expect.any(String));
});

// ── census-trips TR15 / TR122–TR125 / TR127: a commitment's §7.1 fields ──

it('a commitment carries its start, the time to be there by, both buffers and how sure it is — typed in its stage\'s zone', async () => {
  const addCommitmentEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" tripTimezone="Asia/Manila" loadStructure={jest.fn().mockResolvedValue(structureOf([stage(S1, 1)]))} addCommitmentEntry={addCommitmentEntry} />);
  await fireEvent.press(screen.getByTestId('structure-compose-commitment'));
  await waitFor(() => screen.getByTestId(`commitment-stage-${S1}`));
  await fireEvent.press(screen.getByTestId('commitment-type-event'));
  // no stage chosen: the trip's zone, said as such; choosing the stage moves the times to its zone
  expect(screen.getByText("Starts — Asia/Manila (the trip's)")).toBeTruthy();
  await fireEvent.press(screen.getByTestId(`commitment-stage-${S1}`));
  expect(screen.getByText("Starts — Europe/Lisbon (the stage's)")).toBeTruthy();
  expect(screen.getByTestId('commitment-confidence-none').props.accessibilityState).toEqual({ selected: true });
  await fireEvent.changeText(screen.getByTestId('commitment-starts-date'), '2026-10-24');
  await fireEvent.changeText(screen.getByTestId('commitment-starts-time'), '19:00');
  await fireEvent.changeText(screen.getByTestId('commitment-arrive-by-date'), '2026-10-24');
  await fireEvent.changeText(screen.getByTestId('commitment-arrive-by-time'), '19:15');
  expect(screen.getByTestId('commitment-details-problem').props.children).toMatch(/arrival time is after it starts/);
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId('commitment-arrive-by-time'), '18:45');
  await fireEvent.changeText(screen.getByTestId('commitment-lateness'), '5');
  await fireEvent.changeText(screen.getByTestId('commitment-prep'), '20');
  await fireEvent.press(screen.getByTestId('commitment-confidence-0.75'));
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addCommitmentEntry).toHaveBeenCalledWith('t1', {
    type: 'event', flexibility: 'flexible', stageId: S1,
    startsAt: '2026-10-24T19:00:00+01:00', requiredArrivalAt: '2026-10-24T18:45:00+01:00', latenessMinutes: 5, prepMinutes: 20, confidence: 0.75,
  }, expect.stringMatching(/^structure-entry:commitment:/));
  // the details reset with the rest of the form
  expect(screen.getByTestId('commitment-starts-date').props.value).toBe('');
});

it('a commitment time that happens twice is not sent until one is chosen; minutes must be whole', async () => {
  const addCommitmentEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" loadStructure={jest.fn().mockResolvedValue(structureOf([stage(S1, 1)]))} addCommitmentEntry={addCommitmentEntry} />);
  await fireEvent.press(screen.getByTestId('structure-compose-commitment'));
  await waitFor(() => screen.getByTestId(`commitment-stage-${S1}`));
  await fireEvent.press(screen.getByTestId('commitment-type-meeting'));
  await fireEvent.press(screen.getByTestId(`commitment-stage-${S1}`));
  await fireEvent.changeText(screen.getByTestId('commitment-starts-date'), '2026-10-25');
  await fireEvent.changeText(screen.getByTestId('commitment-starts-time'), '01:30');
  expect(screen.getByTestId('commitment-starts-problem').props.children).toMatch(/happens twice that day in Europe\/Lisbon/);
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId('commitment-starts-pick-earlier'));
  await fireEvent.changeText(screen.getByTestId('commitment-prep'), '7.5');
  expect(screen.getByTestId('commitment-details-problem').props.children).toBe('Enter minutes as a whole number, for example 15.');
  expect(screen.getByTestId('structure-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.changeText(screen.getByTestId('commitment-prep'), '');
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addCommitmentEntry.mock.calls[0][1]).toEqual({ type: 'meeting', flexibility: 'flexible', stageId: S1, startsAt: '2026-10-25T01:30:00+01:00' });
});

it('with no stage and no trip zone, commitment times stay closed until the phone\'s zone is CHOSEN, and it is labelled as the phone\'s', async () => {
  const addCommitmentEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripStructureComposer tripId="t1" tripTimezone={null} deviceTimezone={() => 'Asia/Tokyo'} loadStructure={jest.fn().mockResolvedValue(structureOf([]))} addCommitmentEntry={addCommitmentEntry} />);
  await fireEvent.press(screen.getByTestId('structure-compose-commitment'));
  await waitFor(() => screen.getByTestId('commitment-zone-missing'));
  expect(screen.getByTestId('commitment-starts-date').props.editable).toBe(false);
  await fireEvent.press(screen.getByLabelText("Use this phone's time zone, Asia/Tokyo"));
  expect(screen.getByText("Starts — Asia/Tokyo (this phone's)")).toBeTruthy();
  await fireEvent.press(screen.getByTestId('commitment-type-booking'));
  await fireEvent.changeText(screen.getByTestId('commitment-starts-date'), '2026-10-24');
  await fireEvent.changeText(screen.getByTestId('commitment-starts-time'), '09:00');
  await fireEvent.press(screen.getByTestId('structure-compose-submit'));
  await waitFor(() => screen.getByTestId('structure-compose-recorded'));
  expect(addCommitmentEntry.mock.calls[0][1]).toEqual({ type: 'booking', flexibility: 'flexible', stageId: null, startsAt: '2026-10-24T09:00:00+09:00' });
});
