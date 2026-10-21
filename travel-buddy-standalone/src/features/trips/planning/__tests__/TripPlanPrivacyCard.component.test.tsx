/**
 * census-trips TR116: TripPlanPrivacyCard — the app reads a plan's §6.3 scope
 * and sets it, and says "Saved" only on the server's answer.
 *
 * RNTL v14: always await render() and fireEvent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

import { TripPlanPrivacyCard } from '../TripPlanPrivacyCard.tsx';

const own = { state: 'ok' as const, data: [
  { id: 'p1', title: 'Dinner at Ramiro', scope: 'crew' as const },
  { id: 'p2', title: 'Spa', scope: null },
] };

it('reads the viewer\'s own plans with who can see each; an unread scope is "not known", never a default', async () => {
  const load = jest.fn().mockResolvedValue(own);
  await render(<TripPlanPrivacyCard tripId="t1" currentUserId="me" load={load} />);
  await waitFor(() => screen.getByTestId('plan-privacy-p1'));
  expect(load).toHaveBeenCalledWith('t1', 'me');
  expect(screen.getByTestId('plan-privacy-scope-p1').props.children).toEqual(['Seen by: ', 'Trip crew']);
  expect(screen.getByTestId('plan-privacy-scope-p2').props.children).toEqual(['Seen by: ', 'not known']);
  expect(screen.getByTestId('plan-privacy-set-p1-crew').props.accessibilityState).toEqual({ selected: true, disabled: false });
  expect(screen.getByLabelText('Dinner at Ramiro: Only me')).toBeTruthy();
  expect(screen.queryByTestId('plan-privacy-set-p1-selected_participants')).toBeNull();
});

it('setting a scope sends it for that plan and draws the scope the SERVER answered', async () => {
  const setScope = jest.fn().mockResolvedValue({ state: 'saved', scope: 'private' });
  await render(<TripPlanPrivacyCard tripId="t1" currentUserId="me" load={jest.fn().mockResolvedValue(own)} setScope={setScope} />);
  await waitFor(() => screen.getByTestId('plan-privacy-p1'));
  await fireEvent.press(screen.getByTestId('plan-privacy-set-p1-private'));
  await waitFor(() => screen.getByTestId('plan-privacy-saved-p1'));
  expect(setScope).toHaveBeenCalledWith('t1', 'p1', 'private');
  expect(screen.getByTestId('plan-privacy-scope-p1').props.children).toEqual(['Seen by: ', 'Only me']);
  expect(screen.getByTestId('plan-privacy-set-p1-private').props.accessibilityState).toEqual({ selected: true, disabled: false });
});

it('a refusal is shown with the server\'s message, and the scope drawn does not move', async () => {
  const setScope = jest.fn().mockResolvedValue({ state: 'refused', status: 403, reason: 'TRIP_PLAN_SCOPE_WIDENING_REFUSED', detail: 'Only the person who added this plan can make it visible to more people.' });
  await render(<TripPlanPrivacyCard tripId="t1" currentUserId="me" load={jest.fn().mockResolvedValue(own)} setScope={setScope} />);
  await waitFor(() => screen.getByTestId('plan-privacy-p1'));
  await fireEvent.press(screen.getByTestId('plan-privacy-set-p1-public'));
  await waitFor(() => screen.getByTestId('plan-privacy-refused-p1'));
  expect(screen.getByText(/Not changed — Only the person who added this plan can make it visible to more people\./)).toBeTruthy();
  expect(screen.queryByTestId('plan-privacy-saved-p1')).toBeNull();
  expect(screen.getByTestId('plan-privacy-scope-p1').props.children).toEqual(['Seen by: ', 'Trip crew']);
});

it('an unreachable server says nothing changed, and Try again re-sends the same choice', async () => {
  const setScope = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'service unavailable' })
    .mockResolvedValueOnce({ state: 'saved', scope: 'public' });
  await render(<TripPlanPrivacyCard tripId="t1" currentUserId="me" load={jest.fn().mockResolvedValue(own)} setScope={setScope} />);
  await waitFor(() => screen.getByTestId('plan-privacy-p2'));
  await fireEvent.press(screen.getByTestId('plan-privacy-set-p2-public'));
  await waitFor(() => screen.getByTestId('plan-privacy-unavailable-p2'));
  expect(screen.getByText(/Nothing changed/)).toBeTruthy();
  expect(screen.getByTestId('plan-privacy-scope-p2').props.children).toEqual(['Seen by: ', 'not known']);
  await fireEvent.press(screen.getByTestId('plan-privacy-retry-p2'));
  await waitFor(() => screen.getByTestId('plan-privacy-saved-p2'));
  expect(setScope.mock.calls).toEqual([['t1', 'p2', 'public'], ['t1', 'p2', 'public']]);
});

it('a plan read that failed is said, not drawn as no plans; Try again re-reads; an empty read says so', async () => {
  const load = jest.fn()
    .mockResolvedValueOnce({ state: 'unavailable', detail: 'HTTP 500' })
    .mockResolvedValueOnce({ state: 'ok', data: [] });
  await render(<TripPlanPrivacyCard tripId="t1" currentUserId="me" load={load} />);
  await waitFor(() => screen.getByTestId('plan-privacy-read-failed'));
  expect(screen.getByText(/Couldn.t read this trip.s plan — HTTP 500/)).toBeTruthy();
  expect(screen.queryByTestId('plan-privacy-empty')).toBeNull();
  await fireEvent.press(screen.getByTestId('plan-privacy-reread'));
  await waitFor(() => screen.getByTestId('plan-privacy-empty'));
});
