/**
 * MeetupInviteMoreCard — the organiser invites more people after creation
 * (PLAT-F31). Candidates come from the scope the server accepts; each outcome
 * of POST /api/meetups/:id/invites is reported; a failed candidate read is an
 * error with Retry, never "no friends".
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockInvite = jest.fn();
jest.mock('../../../services/meetups.ts', () => ({
  ...jest.requireActual('../../../services/meetups.ts'),
  inviteToMeetup: (...a: any[]) => mockInvite(...a),
}));

const mockFriends = { getMyFriends: jest.fn(), getTripInvitableUsers: jest.fn(), getCircleInvitableUsers: jest.fn() };
jest.mock('../../../services/friends.ts', () => ({
  ...jest.requireActual('../../../services/friends.ts'),
  getMyFriends: (...a: any[]) => mockFriends.getMyFriends(...a),
  getTripInvitableUsers: (...a: any[]) => mockFriends.getTripInvitableUsers(...a),
  getCircleInvitableUsers: (...a: any[]) => mockFriends.getCircleInvitableUsers(...a),
}));

import { MeetupInviteMoreCard } from '../MeetupInviteMoreCard.tsx';

beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await act(async () => {}); });

const meetup = { id: 'mt-1', isCreator: true, status: 'active' as const, tripId: null, circleOwnerId: null, creatorId: 'me' };
const friend = (id: string, handle: string) => ({ id, handle, name: '', avatarUrl: null, since: '2026-01-01' });

test('plain meetup: friends; sends the chosen ids and reports every outcome', async () => {
  mockFriends.getMyFriends.mockResolvedValue({ ok: true, data: { friends: [friend('a', 'ana'), friend('b', 'bo')] } });
  mockInvite.mockResolvedValue({ ok: true, data: { invited: ['a'], skipped: ['b'], ineligible: [], ageIneligible: [] } });
  const onInvited = jest.fn();
  const view = await render(<MeetupInviteMoreCard meetup={meetup} onInvited={onInvited} />);
  await act(async () => { fireEvent.press(view.getByLabelText('Invite more people')); });
  await waitFor(() => expect(view.getByLabelText('@ana')).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByLabelText('@ana')); });
  await act(async () => { fireEvent.press(view.getByLabelText('@bo')); });
  await act(async () => { fireEvent.press(view.getByTestId('meetup-invite-send')); });
  await waitFor(() => expect(view.getByTestId('meetup-invite-result')).toBeTruthy());
  expect(mockInvite).toHaveBeenCalledWith('mt-1', ['a', 'b']);
  expect(view.getByText('1 invited · 1 already invited')).toBeTruthy();
  expect(onInvited).toHaveBeenCalled();
  expect(mockFriends.getTripInvitableUsers).not.toHaveBeenCalled();
});

test('trip meetup: candidates are the trip members, not friends', async () => {
  mockFriends.getTripInvitableUsers.mockResolvedValue({ ok: true, data: { groupMembers: [friend('t', 'tripmate')], otherFollowers: [friend('f', 'follower')] } });
  const view = await render(<MeetupInviteMoreCard meetup={{ ...meetup, tripId: 'trip-1' }} />);
  await act(async () => { fireEvent.press(view.getByLabelText('Invite more people')); });
  await waitFor(() => expect(view.getByLabelText('@tripmate')).toBeTruthy());
  expect(view.queryByLabelText('@follower')).toBeNull();
  expect(mockFriends.getTripInvitableUsers).toHaveBeenCalledWith('trip-1');
  expect(mockFriends.getMyFriends).not.toHaveBeenCalled();
});

test('a failed candidate read is an error with Retry, not "No friends yet"', async () => {
  mockFriends.getMyFriends.mockResolvedValueOnce({ ok: false, data: null, message: 'Network request failed' });
  const view = await render(<MeetupInviteMoreCard meetup={meetup} />);
  await act(async () => { fireEvent.press(view.getByLabelText('Invite more people')); });
  await waitFor(() => expect(view.getByTestId('meetup-invite-error')).toBeTruthy());
  expect(view.queryByTestId('meetup-invite-empty')).toBeNull();
  mockFriends.getMyFriends.mockResolvedValueOnce({ ok: true, data: { friends: [] } });
  await act(async () => { fireEvent.press(view.getByLabelText('Retry')); });
  await waitFor(() => expect(view.getByTestId('meetup-invite-empty')).toBeTruthy());
});

test('a refused send is the server message, not a result', async () => {
  mockFriends.getMyFriends.mockResolvedValue({ ok: true, data: { friends: [friend('a', 'ana')] } });
  mockInvite.mockResolvedValue({ ok: false, data: null, message: 'None of the provided users are eligible to be invited (scope restriction)' });
  const view = await render(<MeetupInviteMoreCard meetup={meetup} />);
  await act(async () => { fireEvent.press(view.getByLabelText('Invite more people')); });
  await waitFor(() => expect(view.getByLabelText('@ana')).toBeTruthy());
  await act(async () => { fireEvent.press(view.getByLabelText('@ana')); });
  await act(async () => { fireEvent.press(view.getByTestId('meetup-invite-send')); });
  await waitFor(() => expect(view.getByTestId('meetup-invite-send-error')).toBeTruthy());
  expect(view.queryByTestId('meetup-invite-result')).toBeNull();
});

test('not the creator, or a cancelled meetup: nothing', async () => {
  const a = await render(<MeetupInviteMoreCard meetup={{ ...meetup, isCreator: false }} />);
  expect(a.toJSON()).toBeNull();
});

test('a cancelled meetup: nothing', async () => {
  const b = await render(<MeetupInviteMoreCard meetup={{ ...meetup, status: 'cancelled' as const }} />);
  expect(b.toJSON()).toBeNull();
});
