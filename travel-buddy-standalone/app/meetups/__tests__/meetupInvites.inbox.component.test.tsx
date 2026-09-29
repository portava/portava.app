/**
 * Meetup invites inbox — /meetups/invites (PLAT-F31).
 *
 * Loading, an error with Retry (never an empty inbox for a failed read), a true
 * empty state, pending invites answered through POST /api/meetups/:id/rsvp, and
 * confirmed-time notices listed apart.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...a: any[]) => mockPush(...a), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => { const c = cb(); return typeof c === 'function' ? c : undefined; }, []);
  },
}));

const mockApi = { getMyMeetupInvites: jest.fn(), rsvpMeetup: jest.fn() };
jest.mock('../../../src/services/meetups.ts', () => ({
  ...jest.requireActual('../../../src/services/meetups.ts'),
  getMyMeetupInvites: (...a: any[]) => mockApi.getMyMeetupInvites(...a),
  rsvpMeetup: (...a: any[]) => mockApi.rsvpMeetup(...a),
}));

import MeetupInvitesScreen from '../invites';

beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await act(async () => {}); });

const invite = (id: string, kind: 'invite' | 'confirmation', status = 'pending') => ({
  inviteId: id, meetupId: `m-${id}`, status, invitedAt: '2026-09-01T00:00:00Z', kind,
  meetup: { id: `m-${id}`, title: `Tapas ${id}`, locationName: 'Bairro Alto', approximateDate: '2026-10-03', timeBlock: 'evening', startsAt: null, status: kind === 'confirmation' ? 'confirmed' : 'active' },
  creator: { id: 'c', handle: 'host', name: null, avatarUrl: null },
});

test('a failed read is an error with Retry — never "No meetup invites"', async () => {
  mockApi.getMyMeetupInvites.mockResolvedValueOnce({ ok: false, data: null, message: 'Could not load your meetup invites' });
  const view = await render(<MeetupInvitesScreen />);
  await waitFor(() => expect(view.getByTestId('meetup-invites-error')).toBeTruthy());
  expect(view.queryByTestId('meetup-invites-empty')).toBeNull();
  mockApi.getMyMeetupInvites.mockResolvedValueOnce({ ok: true, data: { invites: [] } });
  await act(async () => { fireEvent.press(view.getByLabelText('Retry')); });
  await waitFor(() => expect(view.getByTestId('meetup-invites-empty')).toBeTruthy());
});

test('an unconfigured / empty-bodied answer is an error, not an empty inbox', async () => {
  mockApi.getMyMeetupInvites.mockResolvedValueOnce({ ok: true, data: null });
  const view = await render(<MeetupInvitesScreen />);
  await waitFor(() => expect(view.getByTestId('meetup-invites-error')).toBeTruthy());
});

test('pending invites and confirmed-time notices; Going answers the RSVP and opens the meetup', async () => {
  mockApi.getMyMeetupInvites.mockResolvedValue({ ok: true, data: { invites: [invite('1', 'invite'), invite('2', 'confirmation', 'going')] } });
  mockApi.rsvpMeetup.mockResolvedValue({ ok: true, data: { status: 'going' } });
  const view = await render(<MeetupInvitesScreen />);
  await waitFor(() => expect(view.getByText('Tapas 1')).toBeTruthy());
  expect(view.getByText('Time confirmed')).toBeTruthy();
  expect(view.getByText('Tapas 2')).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByLabelText('Going')); });
  await waitFor(() => expect(mockApi.rsvpMeetup).toHaveBeenCalledWith('m-1', 'going'));
  expect(mockPush).toHaveBeenCalledWith('/meetup/m-1');
  await waitFor(() => expect(view.queryByText('Tapas 1')).toBeNull());
});

test("a refused answer keeps the invite and shows the server's message", async () => {
  mockApi.getMyMeetupInvites.mockResolvedValue({ ok: true, data: { invites: [invite('1', 'invite')] } });
  mockApi.rsvpMeetup.mockResolvedValue({ ok: false, data: null, message: 'You must meet the age requirement' });
  const view = await render(<MeetupInvitesScreen />);
  await waitFor(() => expect(view.getByText('Tapas 1')).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByLabelText("Can't go")); });
  await waitFor(() => expect(view.getByText('You must meet the age requirement')).toBeTruthy());
  expect(view.getByText('Tapas 1')).toBeTruthy();
  expect(mockPush).not.toHaveBeenCalled();
});
