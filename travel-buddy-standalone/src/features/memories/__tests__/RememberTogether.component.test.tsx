/**
 * "Remember this together" — the client half of §5's shared-experience anchor
 * and participant consent (census-highlights-memories H53).
 *
 * WHAT THIS SUITE PINS
 *   - Not deployed (feature_disabled), or not part of any shared experience,
 *     shows NOTHING; a read that failed says so with Try again.
 *   - The host invites only the people the server offers, sees who has not
 *     answered and can withdraw, and can end it for everyone after confirming.
 *   - A participant sees who they remember it with and can leave after
 *     confirming. A refusal is said in the server's words.
 *   - The invitee sees who asked (the Memory's title only when the server sent
 *     it), and accepts, accepts linking ONE of their own Memories, or declines.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockGet = jest.fn();
const mockInvite = jest.fn();
const mockWithdraw = jest.fn();
const mockEnd = jest.fn();
const mockLeave = jest.fn();
const mockList = jest.fn();
const mockAccept = jest.fn();
const mockDecline = jest.fn();
jest.mock('../../../services/memorySharedExperiences.ts', () => ({
  ...jest.requireActual('../../../services/memorySharedExperiences.ts'),
  getSharedExperience: (...a: unknown[]) => mockGet(...a),
  inviteToRememberTogether: (...a: unknown[]) => mockInvite(...a),
  withdrawInvitation: (...a: unknown[]) => mockWithdraw(...a),
  endSharedExperience: (...a: unknown[]) => mockEnd(...a),
  leaveSharedExperience: (...a: unknown[]) => mockLeave(...a),
  listSharedInvitations: (...a: unknown[]) => mockList(...a),
  acceptSharedInvitation: (...a: unknown[]) => mockAccept(...a),
  declineSharedInvitation: (...a: unknown[]) => mockDecline(...a),
}));
const mockUserMemories = jest.fn();
jest.mock('../../../services/memories.ts', () => ({
  ...jest.requireActual('../../../services/memories.ts'),
  getUserMemories: (...a: unknown[]) => mockUserMemories(...a),
}));
const mockSession = { userId: 'me' as string | null };
// NOTE: intentionally exhaustive — the real SessionContext reaches the Supabase auth session.
jest.mock('../../../context/SessionContext.tsx', () => ({ useSession: () => mockSession }));

import { RememberTogetherPanel } from '../RememberTogetherPanel.tsx';
import { SharedExperienceInvitations } from '../SharedExperienceInvitations.tsx';

const MEM = '10000000-0000-4000-8000-000000000001';
const ANA = { userId: 'ana', name: 'Ana', handle: 'ana', avatarUrl: null };
const BAO = { userId: 'bao', name: null, handle: 'bao', avatarUrl: null };
const HOST = { userId: 'host', name: 'Hà', handle: 'ha', avatarUrl: null };

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  for (const m of [mockGet, mockInvite, mockWithdraw, mockEnd, mockLeave, mockList, mockAccept, mockDecline, mockUserMemories]) m.mockReset();
  mockSession.userId = 'me';
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

const press = async (id: string) => { await act(async () => { fireEvent.press(screen.getByTestId(id)); }); };
const confirmLastAlert = async () => {
  const buttons = alertSpy.mock.calls.at(-1)?.[2] as Array<{ text: string; style?: string; onPress?: () => void }>;
  await act(async () => { buttons.find((b) => b.style !== 'cancel' && b.text !== 'Cancel')?.onPress?.(); });
};

describe('RememberTogetherPanel (Memory detail)', () => {
  it('shows nothing when the feature is not deployed, or when I am in no shared experience', async () => {
    mockGet.mockResolvedValueOnce({ ok: false, kind: 'feature_disabled', message: 'x' });
    const first = await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    await act(async () => {});
    expect(screen.queryByTestId('remember-together')).toBeNull();
    expect(screen.queryByTestId('remember-together-error')).toBeNull();
    await first.unmount();
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: null });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    await act(async () => {});
    expect(screen.queryByTestId('remember-together')).toBeNull();
  });

  it('a failed read says so with Try again — never an empty panel', async () => {
    mockGet.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Shared memories could not be loaded right now.' });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    expect(await screen.findByTestId('remember-together-error')).toBeTruthy();
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [], pending: [], invitable: [ANA] } });
    await press('remember-together-retry');
    expect(await screen.findByTestId('remember-together')).toBeTruthy();
  });

  it('the host invites only who the server offers; nothing is shared until they accept', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [{ ...HOST, userId: 'me', role: 'host', memoryId: MEM }], pending: [], invitable: [ANA, BAO] } });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    expect(await screen.findByTestId('remember-together-invitable-ana')).toBeTruthy();
    expect(screen.getByText(/nothing is shared until someone accepts/)).toBeTruthy();
    mockInvite.mockResolvedValueOnce({ ok: true, outcome: 'invited' });
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [], pending: [ANA], invitable: [BAO] } });
    await press('remember-together-invite-ana');
    expect(mockInvite).toHaveBeenCalledWith(MEM, 'ana');
    expect(await screen.findByTestId('remember-together-pending-ana')).toBeTruthy();
    expect(screen.getByTestId('remember-together-notice').props.children).toMatch(/Nothing is shared unless they accept/);
    mockWithdraw.mockResolvedValueOnce({ ok: true, withdrawn: true });
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [], pending: [], invitable: [ANA, BAO] } });
    await press('remember-together-withdraw-ana');
    expect(mockWithdraw).toHaveBeenCalledWith(MEM, 'ana');
  });

  it("a refused invitation is said in the server's words", async () => {
    mockGet.mockResolvedValue({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [], pending: [], invitable: [BAO] } });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    await screen.findByTestId('remember-together-invitable-bao');
    mockInvite.mockResolvedValueOnce({ ok: false, kind: 'forbidden', message: 'That person cannot be invited to remember this together.' });
    await press('remember-together-invite-bao');
    expect(screen.getByTestId('remember-together-notice').props.children).toBe('That person cannot be invited to remember this together.');
  });

  it('the host ends it for everyone only after confirming', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: 'exp-1', viewerRole: 'host', hostMemoryId: MEM, members: [{ ...HOST, userId: 'me', role: 'host', memoryId: MEM }, { ...ANA, role: 'participant', memoryId: null }], pending: [], invitable: [] } });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    expect((await screen.findByTestId('remember-together-members')).props.children).toBe('Remembered together with Ana');
    await press('remember-together-end');
    expect(mockEnd).not.toHaveBeenCalled();
    mockEnd.mockResolvedValueOnce({ ok: true, ended: true });
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: null, viewerRole: 'host', hostMemoryId: MEM, members: [], pending: [], invitable: [ANA] } });
    await confirmLastAlert();
    expect(mockEnd).toHaveBeenCalledWith(MEM);
  });

  it('a participant sees who they remember it with, and leaves only after confirming', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: { experienceId: 'exp-1', viewerRole: 'participant', hostMemoryId: 'host-mem', members: [{ ...HOST, role: 'host', memoryId: null }, { ...ANA, userId: 'me', role: 'participant', memoryId: MEM }, { ...BAO, role: 'participant', memoryId: null }], pending: [], invitable: [] } });
    await render(<RememberTogetherPanel memoryId={MEM} viewerId="me" />);
    expect((await screen.findByTestId('remember-together-members')).props.children).toBe('Remembered together with Hà, @bao');
    expect(screen.queryByTestId('remember-together-end')).toBeNull();
    await press('remember-together-leave');
    mockLeave.mockResolvedValueOnce({ ok: true, left: true });
    mockGet.mockResolvedValueOnce({ ok: true, sharedExperience: null });
    await confirmLastAlert();
    expect(mockLeave).toHaveBeenCalledWith('exp-1');
    expect(screen.queryByTestId('remember-together')).toBeNull();
  });
});

describe('SharedExperienceInvitations (my timeline)', () => {
  it('shows nothing when not deployed, when there are none, or when signed out', async () => {
    mockList.mockResolvedValueOnce({ ok: false, kind: 'feature_disabled', message: 'x' });
    const a = await render(<SharedExperienceInvitations />);
    await act(async () => {});
    expect(screen.queryByTestId('shared-invitations')).toBeNull();
    await a.unmount();
    mockList.mockResolvedValueOnce({ ok: true, invitations: [] });
    const b = await render(<SharedExperienceInvitations />);
    await act(async () => {});
    expect(screen.queryByTestId('shared-invitations')).toBeNull();
    await b.unmount();
    mockSession.userId = null;
    await render(<SharedExperienceInvitations />);
    await act(async () => {});
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('names who asked, and the Memory only when the server sent its title', async () => {
    mockList.mockResolvedValueOnce({ ok: true, invitations: [
      { invitationId: 'i1', host: HOST, memoryTitle: 'Night market', memoryId: 'hm', invitedAt: null },
      { invitationId: 'i2', host: ANA, memoryTitle: null, memoryId: null, invitedAt: null },
    ] });
    await render(<SharedExperienceInvitations />);
    expect(await screen.findByText('Hà invited you to remember “Night market” together.')).toBeTruthy();
    expect(screen.getByText('Ana invited you to remember a Memory together.')).toBeTruthy();
  });

  it('accept, decline, and accept linking one of MY Memories', async () => {
    const one = { ok: true, invitations: [{ invitationId: 'i1', host: HOST, memoryTitle: null, memoryId: null, invitedAt: null }] };
    mockList.mockResolvedValue(one);
    await render(<SharedExperienceInvitations />);
    await screen.findByTestId('shared-invitation-i1');
    mockAccept.mockResolvedValueOnce({ ok: true, experienceId: 'exp-1' });
    await press('shared-invitation-accept-i1');
    expect(mockAccept).toHaveBeenLastCalledWith('i1', null);
    mockDecline.mockResolvedValueOnce({ ok: true, declined: true });
    await press('shared-invitation-decline-i1');
    expect(mockDecline).toHaveBeenCalledWith('i1');
    mockUserMemories.mockResolvedValueOnce({ ok: true, nextCursor: null, memories: [
      { id: 'mine-1', ownerId: 'me', title: 'My lanterns' }, { id: 'theirs', ownerId: 'someone', title: 'Not mine' },
    ] });
    await press('shared-invitation-link-i1');
    expect(mockUserMemories).toHaveBeenCalledWith('me');
    expect(await screen.findByTestId('shared-invitation-pick-mine-1')).toBeTruthy();
    expect(screen.queryByTestId('shared-invitation-pick-theirs')).toBeNull();
    mockAccept.mockResolvedValueOnce({ ok: true, experienceId: 'exp-1' });
    await press('shared-invitation-pick-mine-1');
    expect(mockAccept).toHaveBeenLastCalledWith('i1', 'mine-1');
  });

  it('a failed read says so with Try again', async () => {
    mockList.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'Shared memories could not be loaded right now.' });
    await render(<SharedExperienceInvitations />);
    expect(await screen.findByTestId('shared-invitations-error')).toBeTruthy();
  });
});
