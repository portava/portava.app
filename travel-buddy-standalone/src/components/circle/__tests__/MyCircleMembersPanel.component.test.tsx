/**
 * MyCircleMembersPanel — trusted-circle members: list, invite, remove.
 * TM-social, PLAT-F11.
 *
 * DELETE /circles/:owner/members/:member had no caller, so an owner could
 * never take circle access away. This pins the panel: a failed member read is
 * "couldn't load" with a retry (never "no members"); anyone in a block
 * relation is not listed; a removal is shown only once the server confirmed
 * it, a refusal keeps the row, and a 404 (already gone) re-reads instead of
 * claiming a removal.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { MyCircleMembersPanel } from '../MyCircleMembersPanel.tsx';

jest.mock('expo-router', () => ({ ...jest.requireActual('expo-router'), router: { push: jest.fn() } }));
jest.mock('../../../services/friends.ts', () => ({
  ...jest.requireActual('../../../services/friends.ts'),
  getCircleMembers: jest.fn(),
  removeCircleMember: jest.fn(),
  getMyFriends: jest.fn(),
  sendCircleInvite: jest.fn(),
}));
jest.mock('../../../context/BlockedIdsContext.tsx', () => ({
  ...jest.requireActual('../../../context/BlockedIdsContext.tsx'),
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set(['blocker']) }),
}));
const friends = require('../../../services/friends.ts');
const U = (id: string, handle: string) => ({ id, handle, name: null, avatarUrl: null });

type Btn = { text: string; onPress?: () => void };

jest.setTimeout(20000);

describe('MyCircleMembersPanel', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
  afterEach(() => alertSpy.mockRestore());

  async function confirmRemove(getByTestId: (id: string) => any, id: string) {
    await fireEvent.press(getByTestId(`circle-remove-${id}`));
    const btns = alertSpy.mock.calls[alertSpy.mock.calls.length - 1][2] as Btn[];
    await btns.find((b) => b.text === 'Remove')!.onPress!();
  }

  it('lists members, minus anyone in a block relation', async () => {
    friends.getCircleMembers.mockResolvedValue({ ok: true, data: { members: [U('m1', 'mia'), U('blocker', 'nope')] } });
    const { findByText, queryByText } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText('@mia');
    expect(queryByText('@nope')).toBeNull();
    expect(friends.getCircleMembers).toHaveBeenCalledWith('me');
  });

  it('a failed read is "couldn\'t load" with a retry, never "No one is in your trusted circle"', async () => {
    friends.getCircleMembers
      .mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error' })
      .mockResolvedValueOnce({ ok: true, data: { members: [U('m1', 'mia')] } });
    const { findByText, queryByText, getByTestId } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText("Couldn't load your circle members.");
    expect(queryByText(/No one is in your trusted circle/)).toBeNull();
    await fireEvent.press(getByTestId('circle-members-retry'));
    await findByText('@mia');
  });

  it('remove: the row goes only when the server says removed', async () => {
    friends.getCircleMembers.mockResolvedValue({ ok: true, data: { members: [U('m1', 'mia'), U('m2', 'max')] } });
    friends.removeCircleMember.mockResolvedValue({ ok: true, data: { status: 'removed', memberId: 'm1' } });
    const { findByText, getByTestId, queryByText } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText('@mia');
    await confirmRemove(getByTestId, 'm1');
    await waitFor(() => expect(queryByText('@mia')).toBeNull());
    expect(friends.removeCircleMember).toHaveBeenCalledWith('me', 'm1');
    expect(queryByText('@max')).toBeTruthy();
  });

  it('a refused removal keeps the row and says so', async () => {
    friends.getCircleMembers.mockResolvedValue({ ok: true, data: { members: [U('m1', 'mia')] } });
    friends.removeCircleMember.mockResolvedValue({ ok: false, data: null, errorKind: 'db_error', message: 'We could not check that membership right now.' });
    const { findByText, getByTestId, queryByText } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText('@mia');
    await confirmRemove(getByTestId, 'm1');
    await waitFor(() => expect(alertSpy).toHaveBeenLastCalledWith('Could not remove', 'We could not check that membership right now.'));
    expect(queryByText('@mia')).toBeTruthy();
  });

  it('a 404 (already gone) re-reads the members instead of claiming a removal', async () => {
    friends.getCircleMembers
      .mockResolvedValueOnce({ ok: true, data: { members: [U('m1', 'mia')] } })
      .mockResolvedValueOnce({ ok: true, data: { members: [] } });
    friends.removeCircleMember.mockResolvedValue({ ok: false, data: null, errorKind: 'not_found' });
    const { findByText, getByTestId } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText('@mia');
    await confirmRemove(getByTestId, 'm1');
    await findByText(/No one is in your trusted circle yet/);
    expect(friends.getCircleMembers).toHaveBeenCalledTimes(2);
  });

  it('invite: friends not already members can be invited', async () => {
    friends.getCircleMembers.mockResolvedValue({ ok: true, data: { members: [U('m1', 'mia')] } });
    friends.getMyFriends.mockResolvedValue({ ok: true, data: { friends: [U('m1', 'mia'), U('f2', 'fred')] } });
    friends.sendCircleInvite.mockResolvedValue({ ok: true, data: { inviteId: 'i', status: 'pending' } });
    const { findByText, getByTestId, queryByTestId } = await render(<MyCircleMembersPanel ownerId="me" />);
    await findByText('@mia');
    await fireEvent.press(getByTestId('circle-invite-toggle'));
    await findByText('@fred');
    expect(queryByTestId('circle-invite-m1')).toBeNull();
    await fireEvent.press(getByTestId('circle-invite-f2'));
    await findByText('Invited');
    expect(friends.sendCircleInvite).toHaveBeenCalledWith('f2');
  });
});
