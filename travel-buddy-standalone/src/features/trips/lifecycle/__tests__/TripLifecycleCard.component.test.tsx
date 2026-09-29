/**
 * TRIP-F23: TripLifecycleCard — confirmed lifecycle actions, sent once per
 * confirmation with its own key, reported as the server answered.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { TripLifecycleCard } from '../TripLifecycleCard.tsx';

const lifecycle = { state: 'ok' as const, data: { tripId: 't1', lifecycle: 'PLANNING', reason: null, unread: [], storedStatus: 'planning' } };

it('the owner sees the arrows from the stored status, minus what the screen already offers', async () => {
  const load = jest.fn().mockResolvedValue(lifecycle);
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="upcoming" exclude={['complete']} load={load} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-state'));
  expect(screen.getByTestId('trip-lifecycle-cancel')).toBeTruthy();
  expect(screen.getByTestId('trip-lifecycle-archive')).toBeTruthy();
  expect(screen.getByTestId('trip-lifecycle-delete')).toBeTruthy();
  expect(screen.queryByTestId('trip-lifecycle-complete')).toBeNull();
});

it('nothing is sent until the owner confirms; a confirmed action is sent with a key and reported done', async () => {
  const load = jest.fn().mockResolvedValue(lifecycle);
  const act = jest.fn().mockResolvedValue({ state: 'done', data: { status: 'cancelled' }, status: 200 });
  const confirm = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const onChanged = jest.fn();
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="upcoming" load={load} act={act} confirm={confirm} onChanged={onChanged} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-cancel'));
  await fireEvent.press(screen.getByTestId('trip-lifecycle-cancel'));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(act).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('trip-lifecycle-cancel'));
  await waitFor(() => screen.getByTestId('trip-lifecycle-done-cancel'));
  expect(act).toHaveBeenCalledWith('t1', 'cancel', expect.stringMatching(/^trip-cancel:t1:/));
  expect(onChanged).toHaveBeenCalledWith('cancel');
});

it('an action the server did not answer is retried with THE SAME key, without asking again', async () => {
  const load = jest.fn().mockResolvedValue(lifecycle);
  const act = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'network error' }).mockResolvedValue({ state: 'done', data: null, status: 204 });
  const confirm = jest.fn().mockResolvedValue(true);
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="planning" load={load} act={act} confirm={confirm} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-delete'));
  await fireEvent.press(screen.getByTestId('trip-lifecycle-delete'));
  await waitFor(() => screen.getByTestId('trip-lifecycle-unreached-delete'));
  await fireEvent.press(screen.getByTestId('trip-lifecycle-action-retry'));
  await waitFor(() => screen.getByTestId('trip-lifecycle-done-delete'));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(act.mock.calls[0][2]).toBe(act.mock.calls[1][2]);
});

it('the kernel\'s refusal is shown by name', async () => {
  const load = jest.fn().mockResolvedValue(lifecycle);
  const act = jest.fn().mockResolvedValue({ state: 'refused', status: 409, reason: 'TRIP_LIFECYCLE_INVALID_TRANSITION', detail: 'A completed trip cannot become cancelled' });
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="active" load={load} act={act} confirm={jest.fn().mockResolvedValue(true)} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-cancel'));
  await fireEvent.press(screen.getByTestId('trip-lifecycle-cancel'));
  await waitFor(() => screen.getByTestId('trip-lifecycle-refused-cancel'));
});

it('an archived trip offers nothing; a crew member whose read failed sees nothing', async () => {
  const load = jest.fn().mockResolvedValue(lifecycle);
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="archived" load={load} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-state'));
  expect(screen.queryByTestId('trip-lifecycle-archive')).toBeNull();
  const failed = jest.fn().mockResolvedValue({ state: 'unavailable', detail: 'HTTP 500' });
  const r = await render(<TripLifecycleCard tripId="t2" isOwner={false} storedStatus="planning" load={failed} />);
  await waitFor(() => expect(failed).toHaveBeenCalled());
  expect(r.queryByTestId('trip-lifecycle-card')).toBeNull();
});

it('the owner is told when the lifecycle could not be read, with a retry', async () => {
  const load = jest.fn().mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 500' }).mockResolvedValue(lifecycle);
  await render(<TripLifecycleCard tripId="t1" isOwner storedStatus="planning" load={load} />);
  await waitFor(() => screen.getByTestId('trip-lifecycle-unavailable'));
  await fireEvent.press(screen.getByTestId('trip-lifecycle-retry'));
  await waitFor(() => screen.getByTestId('trip-lifecycle-state'));
});
