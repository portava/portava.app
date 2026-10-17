/**
 * census-trips TR85 / TR86: TripDecisionComposer — the product can now add a
 * decision task or a risk, and says "Added" only on the kernel's word.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripDecisionComposer } from '../TripDecisionComposer.tsx';

const recorded = { state: 'recorded' as const, duplicate: false };

it('adds a decision task by its type and consequence, with a fresh key, and tells the screen to re-read', async () => {
  const addTask = jest.fn().mockResolvedValue(recorded);
  const onAdded = jest.fn();
  await render(<TripDecisionComposer tripId="t1" addTask={addTask} onAdded={onAdded} />);
  await fireEvent.press(screen.getByTestId('decision-compose-task'));
  expect(screen.getByTestId('decision-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId('decision-type-booking'));
  await fireEvent.changeText(screen.getByTestId('decision-consequence'), 'the fare doubles');
  await fireEvent.press(screen.getByTestId('decision-compose-submit'));
  await waitFor(() => screen.getByTestId('decision-compose-recorded'));
  expect(addTask).toHaveBeenCalledWith('t1', { type: 'booking', consequence: 'the fare doubles' }, expect.stringMatching(/^decision-entry:task:/));
  expect(onAdded).toHaveBeenCalledTimes(1);
});

it('flags a risk only once likelihood AND impact are chosen', async () => {
  const addRiskEntry = jest.fn().mockResolvedValue(recorded);
  await render(<TripDecisionComposer tripId="t1" addRiskEntry={addRiskEntry} />);
  await fireEvent.press(screen.getByTestId('decision-compose-risk'));
  await fireEvent.press(screen.getByTestId('risk-likelihood-high'));
  expect(screen.getByTestId('decision-compose-submit').props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(screen.getByTestId('risk-impact-medium'));
  await fireEvent.changeText(screen.getByTestId('risk-note'), 'rail strike');
  await fireEvent.press(screen.getByTestId('decision-compose-submit'));
  await waitFor(() => screen.getByTestId('decision-compose-recorded'));
  expect(addRiskEntry).toHaveBeenCalledWith('t1', { likelihood: 'high', impact: 'medium', note: 'rail strike' }, expect.stringMatching(/^decision-entry:risk:/));
});

it('a refusal is shown with its reason, and nothing claims "Added"', async () => {
  const addTask = jest.fn().mockResolvedValue({ state: 'refused', reason: 'TRIP_AUTH_NOT_CREW', detail: 'only the trip crew can add to this trip' });
  const onAdded = jest.fn();
  await render(<TripDecisionComposer tripId="t1" addTask={addTask} onAdded={onAdded} />);
  await fireEvent.press(screen.getByTestId('decision-compose-task'));
  await fireEvent.press(screen.getByTestId('decision-type-document'));
  await fireEvent.press(screen.getByTestId('decision-compose-submit'));
  await waitFor(() => screen.getByTestId('decision-compose-refused'));
  expect(screen.getByText(/Not added — only the trip crew can add to this trip/)).toBeTruthy();
  expect(screen.queryByTestId('decision-compose-recorded')).toBeNull();
  expect(onAdded).not.toHaveBeenCalled();
});

it('an unreachable kernel says nothing was added, and Try again re-sends THE SAME key', async () => {
  const addTask = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' })
    .mockResolvedValueOnce(recorded);
  await render(<TripDecisionComposer tripId="t1" addTask={addTask} />);
  await fireEvent.press(screen.getByTestId('decision-compose-task'));
  await fireEvent.press(screen.getByTestId('decision-type-payment'));
  await fireEvent.press(screen.getByTestId('decision-compose-submit'));
  await waitFor(() => screen.getByTestId('decision-compose-unavailable'));
  await fireEvent.press(screen.getByTestId('decision-compose-retry'));
  await waitFor(() => screen.getByTestId('decision-compose-recorded'));
  expect(addTask).toHaveBeenCalledTimes(2);
  expect(addTask.mock.calls[1][2]).toBe(addTask.mock.calls[0][2]);
});
