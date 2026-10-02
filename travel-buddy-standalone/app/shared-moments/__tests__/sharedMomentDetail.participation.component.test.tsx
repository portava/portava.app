/**
 * HM-F17 — Shared Moment participation on /shared-moments/:id.
 *
 * The write functions existed in services/sharedMoments.ts with no caller, and
 * the screen answered EVERY failure with "This Moment is unavailable. You may
 * need an invitation" — including to the person holding the invitation, who
 * had no way to accept it. Pinned here:
 *
 *   - an invitee sees the invitation and can accept or decline it;
 *   - anyone may ask to join an approval-required Moment, and sees that the
 *     request is waiting;
 *   - the owner answers join requests, approves or removes contributions;
 *   - a member contributes one of their OWN posts;
 *   - a detail that could not be read is an error with a retry, and an
 *     unreadable feed is never "approved contributions will appear here".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => {
  const { View: V } = jest.requireActual('react-native');
  return {
    Stack: { Screen: () => <V /> },
    router: { back: jest.fn(), push: jest.fn() },
    useLocalSearchParams: () => ({ id: '55555555-5555-4555-8555-555555555555' }),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View: V } = jest.requireActual('react-native');
  return { ...jest.requireActual('react-native-safe-area-context'), SafeAreaView: V, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
// NOTE: intentionally exhaustive — CachedImage resolves through expo-image.
jest.mock('../../../src/components/CachedImage.tsx', () => ({ CachedImage: () => null }));

const mockSm = {
  loadSharedMoment: jest.fn(), loadSharedMomentFeed: jest.fn(), getSharedMomentPreview: jest.fn(),
  listSharedMomentJoinRequests: jest.fn(), listPendingSharedMomentContributions: jest.fn(), listContributablePosts: jest.fn(),
  respondToSharedMomentInvite: jest.fn(), requestToJoinSharedMoment: jest.fn(), respondToSharedMomentJoinRequest: jest.fn(),
  addSharedMomentContribution: jest.fn(), approveSharedMomentContribution: jest.fn(), removeSharedMomentContribution: jest.fn(),
  leaveSharedMoment: jest.fn(), archiveSharedMoment: jest.fn(),
};
jest.mock('../../../src/services/sharedMoments.ts', () => {
  const actual = jest.requireActual('../../../src/services/sharedMoments.ts');
  const out: Record<string, unknown> = { ...actual };
  const keys = ['loadSharedMoment', 'loadSharedMomentFeed', 'getSharedMomentPreview', 'listSharedMomentJoinRequests',
    'listPendingSharedMomentContributions', 'listContributablePosts', 'respondToSharedMomentInvite', 'requestToJoinSharedMoment',
    'respondToSharedMomentJoinRequest', 'addSharedMomentContribution', 'approveSharedMomentContribution',
    'removeSharedMomentContribution', 'leaveSharedMoment', 'archiveSharedMoment'];
  for (const k of keys) out[k] = (...a: unknown[]) => (mockSm as Record<string, jest.Mock>)[k](...a);
  return out;
});

import SharedMomentDetailScreen from '../[id].tsx';

const SM = '55555555-5555-4555-8555-555555555555';
const moment = (role: string | null, over: Record<string, unknown> = {}) => ({
  id: SM, title: 'Sunset at the pier', description: null, placeDayId: null, placeId: 'p1', tripId: null,
  joinPolicy: 'approval_required', status: 'active', createdAt: 'x', updatedAt: 'x', role, ...over,
});
const detail = (role: string) => ({ ok: true, data: { moment: moment(role), members: [{ userId: 'o', role: 'owner' }], chat: { available: false, reason: 'Chat is not available for Shared Moments yet.' } } });
const ok = <T,>(data: T) => ({ ok: true, data });

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  for (const f of Object.values(mockSm)) f.mockReset();
  mockSm.loadSharedMomentFeed.mockResolvedValue(ok({ items: [], nextCursor: null }));
  mockSm.listSharedMomentJoinRequests.mockResolvedValue(ok([]));
  mockSm.listPendingSharedMomentContributions.mockResolvedValue(ok([]));
  mockSm.listContributablePosts.mockResolvedValue(ok([]));
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

describe('a person who is not a member', () => {
  it('an invitee accepts the invitation and lands in the Moment', async () => {
    mockSm.loadSharedMoment
      .mockResolvedValueOnce({ ok: false, code: 'not_member', message: 'Join this Moment to view it' })
      .mockResolvedValueOnce(detail('member'));
    mockSm.getSharedMomentPreview.mockResolvedValue(ok({ moment: moment(null), myStatus: 'invited', myRole: null }));
    mockSm.respondToSharedMomentInvite.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    expect(await screen.findByText('You were invited to this Moment')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('moment-invite-accept')); });
    expect(mockSm.respondToSharedMomentInvite).toHaveBeenCalledWith(SM, 'accept');
    expect(await screen.findByTestId('moment-member-view')).toBeTruthy();
  });

  it('an invitee can decline', async () => {
    mockSm.loadSharedMoment.mockResolvedValue({ ok: false, code: 'not_member', message: 'x' });
    mockSm.getSharedMomentPreview.mockResolvedValue(ok({ moment: moment(null), myStatus: 'invited', myRole: null }));
    mockSm.respondToSharedMomentInvite.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-invite-decline')); });
    expect(mockSm.respondToSharedMomentInvite).toHaveBeenCalledWith(SM, 'decline');
    expect(await screen.findByText('You declined this invitation.')).toBeTruthy();
  });

  it('anyone may ask to join an approval-required Moment, and sees the request waiting', async () => {
    mockSm.loadSharedMoment.mockResolvedValue({ ok: false, code: 'not_member', message: 'x' });
    mockSm.getSharedMomentPreview.mockResolvedValue(ok({ moment: moment(null), myStatus: null, myRole: null }));
    mockSm.requestToJoinSharedMoment.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-request-join')); });
    expect(mockSm.requestToJoinSharedMoment).toHaveBeenCalledWith(SM);
    expect(await screen.findByText('Your request is waiting for the organiser.')).toBeTruthy();
  });

  it('an invite-only Moment with no invitation is unavailable', async () => {
    mockSm.loadSharedMoment.mockResolvedValue({ ok: false, code: 'not_member', message: 'x' });
    mockSm.getSharedMomentPreview.mockResolvedValue({ ok: false, code: 'not_found', message: 'This Moment is unavailable.' });
    await render(<SharedMomentDetailScreen />);
    expect(await screen.findByTestId('moment-unavailable')).toBeTruthy();
  });

  it('a detail that could not be read is an error with a retry, not "unavailable"', async () => {
    mockSm.loadSharedMoment.mockResolvedValueOnce({ ok: false, code: 'network', message: 'You appear to be offline.' });
    await render(<SharedMomentDetailScreen />);
    expect(await screen.findByText('You appear to be offline.')).toBeTruthy();
    expect(screen.queryByTestId('moment-unavailable')).toBeNull();
    mockSm.loadSharedMoment.mockResolvedValueOnce(detail('member'));
    await act(async () => { fireEvent.press(screen.getByTestId('moment-retry')); });
    expect(await screen.findByTestId('moment-member-view')).toBeTruthy();
  });
});

describe('the organiser', () => {
  it('accepts a join request', async () => {
    mockSm.loadSharedMoment.mockResolvedValue(detail('owner'));
    mockSm.listSharedMomentJoinRequests.mockResolvedValue(ok([{ userId: 'u9', handle: 'cam', name: 'Cam', avatarUrl: null, requestedAt: 'x' }]));
    mockSm.respondToSharedMomentJoinRequest.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-request-accept-u9')); });
    expect(mockSm.respondToSharedMomentJoinRequest).toHaveBeenCalledWith(SM, 'u9', 'accept');
  });

  it('approves a pending contribution and removes an approved one', async () => {
    mockSm.loadSharedMoment.mockResolvedValue(detail('owner'));
    mockSm.listPendingSharedMomentContributions.mockResolvedValue(ok([{ id: 'c1', contributorId: 'u2', postId: 'p', mediaAssetId: null, caption: 'Golden hour', mediaUrl: null, thumbnailUrl: null, createdAt: 'x', mine: false }]));
    mockSm.loadSharedMomentFeed.mockResolvedValue(ok({ items: [{ id: 'c0', contributorId: 'u3', caption: 'Earlier', postId: 'p0', mediaAssetId: null, mediaUrl: null, thumbnailUrl: null, createdAt: 'x' }], nextCursor: null }));
    mockSm.approveSharedMomentContribution.mockResolvedValue(true);
    mockSm.removeSharedMomentContribution.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-contribution-approve-c1')); });
    expect(mockSm.approveSharedMomentContribution).toHaveBeenCalledWith(SM, 'c1');
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-contribution-remove-c0')); });
    const confirm = alertSpy.mock.calls.find((c) => c[0] === 'Remove this contribution?')?.[2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => { confirm.find((o) => o.text === 'Remove')!.onPress!(); });
    await waitFor(() => expect(mockSm.removeSharedMomentContribution).toHaveBeenCalledWith(SM, 'c0'));
  });
});

describe('a member', () => {
  it('contributes one of their own posts', async () => {
    mockSm.loadSharedMoment.mockResolvedValue(detail('member'));
    mockSm.listContributablePosts.mockResolvedValue(ok([{ id: 'post1', caption: 'My sunset', mediaUrl: null, thumbnailUrl: null, createdAt: 'x', contributed: false }]));
    mockSm.addSharedMomentContribution.mockResolvedValue(true);
    await render(<SharedMomentDetailScreen />);
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-contribute-open')); });
    await act(async () => { fireEvent.press(await screen.findByTestId('moment-contribute-post1')); });
    expect(mockSm.addSharedMomentContribution).toHaveBeenCalledWith(SM, { postId: 'post1' });
    expect(await screen.findByText('Sent for approval.')).toBeTruthy();
  });

  it('an unreadable feed is an error, never "approved contributions will appear here"', async () => {
    mockSm.loadSharedMoment.mockResolvedValue(detail('member'));
    mockSm.loadSharedMomentFeed.mockResolvedValue({ ok: false, code: 'server', message: 'Something went wrong. Please try again.' });
    await render(<SharedMomentDetailScreen />);
    expect(await screen.findByTestId('moment-feed-error')).toBeTruthy();
    expect(screen.queryByTestId('moment-feed-empty')).toBeNull();
  });
});
