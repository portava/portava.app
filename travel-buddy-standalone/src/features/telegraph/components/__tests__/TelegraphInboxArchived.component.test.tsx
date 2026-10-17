/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 * The inbox used to list an archived conversation in the main list, exactly
 * like any other: GET /me/threads returned `archivedAt` and no screen read it,
 * and there was no way to unarchive at all. Now an archived conversation is in
 * an "Archived" section at the foot of the list, each with an Unarchive action
 * that calls POST /threads/:id/unarchive; on the server's ok the conversation
 * returns to the main list.
 *
 * WHAT TURNS THIS RED: an archived conversation in the main list; no Unarchive
 * action, or one that does not call the route for THAT conversation; a
 * conversation moved before the server said ok, or moved on a failure; a
 * failure that says nothing, or that leaves no way to retry; a pending press
 * that can be pressed again.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */

import React from 'react';
import { render, act, fireEvent, within } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../context/SessionContext', () => ({
  useSession: jest.fn(() => ({ configured: true, isAuthed: true, userId: 'u1' })),
}));

const mockThreads: { current: any[] } = { current: [] };
// NOTE: intentional exhaustive stub — these hooks are the screen's data
// contract and each reaches supabase + apiToken at load time.
jest.mock('../../../../hooks/useMessaging', () => ({
  useMyThreads: () => ({ data: mockThreads.current, loading: false, refreshing: false, error: null, reload: jest.fn(), refresh: jest.fn() }),
  useIncomingMessageRequests: () => ({ data: [], loading: false, reload: jest.fn(), accept: jest.fn(), decline: jest.fn() }),
  useUnreadCounts: () => ({ meetups: 0 }),
}));

const mockUnarchive = jest.fn();
// NOTE: intentional exhaustive stub — the unarchive call is the subject; the module has one export.
jest.mock('../../inbox/archiveApi', () => ({
  unarchiveThread: (...a: unknown[]) => mockUnarchive(...a),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set() }),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/blocks', () => ({
  getBlockList: jest.fn().mockResolvedValue({ ok: true, data: [] }),
  blockUser: jest.fn(),
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/reports', () => ({ reportContent: jest.fn() }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../components/HighlightRing', () => ({ HighlightRing: ({ children }: any) => children }));
jest.mock('../../../../components/HighlightViewer', () => ({ HighlightViewer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../hooks/useHighlightRingState', () => ({ useHighlightRingState: () => null }));
jest.mock('../../../../components/telegraph/TelegraphPrimitives', () => {
  const React = require('react');
  const { View, Pressable } = require('react-native');
  return {
    TelegraphAvatar: () => React.createElement(View, null),
    TelegraphRow: ({ children, onPress }: any) => React.createElement(Pressable, { onPress, testID: 'telegraph-row' }, children),
  };
});
jest.mock('../../../../components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { KeyboardSafeScrollView: ({ children, style }: any) => React.createElement(View, { style }, children) };
});
// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/compass', () => ({ postCompassFrontloadEvent: jest.fn().mockResolvedValue(undefined) }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../lib/displayIdentity', () => ({
  primaryIdentityText: ({ handle }: any) => handle ?? 'Unknown',
  secondaryIdentityText: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../components/CircleStatusCardMessage.logic', () => ({ circleCardInboxPreview: () => '' }));

import { TelegraphInboxScreen } from '../../../../components/TelegraphInboxScreen.tsx';

const thread = (id: string, handle: string, archivedAt: string | null) => ({
  id, threadType: 'direct', tripId: null, circleOwnerId: null, title: null, status: 'active',
  lastMessageAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', mutedAt: null, archivedAt,
  otherMembers: [{ id: `user-${handle}`, handle, name: null, avatarUrl: null }], lastMessagePreview: null, unreadCount: 0,
});
const ARCHIVED_AT = '2026-10-16T09:00:00.000Z';

/** The names on the rows, in the order the list draws them, with the Archived divider where it falls. */
function order(r: Awaited<ReturnType<typeof render>>): string[] {
  return r.getAllByText(/^(mira|kai|noor|Archived)$/).map((n) => String(n.props.children));
}

async function mount() {
  const r = await render(<TelegraphInboxScreen />);
  await act(async () => {});
  return r;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Archived section — archived conversations leave the main list', () => {
  beforeEach(() => { mockUnarchive.mockReset(); });
  afterEach(() => { mockThreads.current = []; });

  it('THE POINT: an archived conversation is under Archived, after the main list, with an Unarchive action; a live one has none', async () => {
    mockThreads.current = [thread('t-kai', 'kai', ARCHIVED_AT), thread('t-mira', 'mira', null), thread('t-noor', 'noor', null)];
    const r = await mount();
    expect(order(r)).toEqual(['mira', 'noor', 'Archived', 'kai']);
    const button = r.getByTestId('telegraph-unarchive-t-kai');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Unarchive kai');
    expect(r.queryByTestId('telegraph-unarchive-t-mira')).toBeNull();
    expect(r.queryByTestId('telegraph-unarchive-t-noor')).toBeNull();
  });

  it('CONTROL: with nothing archived there is no Archived section', async () => {
    mockThreads.current = [thread('t-mira', 'mira', null)];
    const r = await mount();
    expect(r.queryByText('Archived')).toBeNull();
    expect(r.queryAllByText('Unarchive')).toHaveLength(0);
  });

  it('only archived conversations: the Archived section shows rather than the empty inbox', async () => {
    mockThreads.current = [thread('t-kai', 'kai', ARCHIVED_AT)];
    const r = await mount();
    expect(order(r)).toEqual(['Archived', 'kai']);
    expect(r.queryByText('Your Telegraph is quiet.')).toBeNull();
  });

  it('an archived conversation still opens from its row', async () => {
    mockThreads.current = [thread('t-kai', 'kai', ARCHIVED_AT)];
    mockPush.mockReset();
    const r = await mount();
    await act(async () => { fireEvent.press(r.getAllByTestId('telegraph-row')[0]!); });
    expect(String(mockPush.mock.calls[0]?.[0])).toMatch(/^\/messages\/t-kai\?/);
  });
});

describe('Unarchive — calls the route, says it is working, moves the conversation only on ok', () => {
  beforeEach(() => { mockUnarchive.mockReset(); });
  afterEach(() => { mockThreads.current = []; });

  it('THE POINT: it calls the route for THAT conversation, is pending until the server answers, then the conversation is back in the main list', async () => {
    mockThreads.current = [thread('t-mira', 'mira', null), thread('t-kai', 'kai', ARCHIVED_AT), thread('t-noor', 'noor', ARCHIVED_AT)];
    const gate = deferred<{ ok: true }>();
    mockUnarchive.mockReturnValue(gate.promise);
    const r = await mount();
    await act(async () => { fireEvent.press(r.getByTestId('telegraph-unarchive-t-kai')); });
    expect(mockUnarchive).toHaveBeenCalledTimes(1);
    expect(mockUnarchive).toHaveBeenCalledWith('t-kai');

    // Pending: says so, cannot be pressed twice, and nothing has moved yet.
    const pending = r.getByTestId('telegraph-unarchive-t-kai');
    expect(pending.props.accessibilityState).toEqual(expect.objectContaining({ busy: true, disabled: true }));
    expect(within(pending).getByText('Unarchiving…')).toBeTruthy();
    await act(async () => { fireEvent.press(pending); });
    expect(mockUnarchive).toHaveBeenCalledTimes(1);
    expect(order(r)).toEqual(['mira', 'Archived', 'kai', 'noor']);

    await act(async () => { gate.resolve({ ok: true }); });
    expect(order(r)).toEqual(['mira', 'kai', 'Archived', 'noor']);
    expect(r.queryByTestId('telegraph-unarchive-t-kai')).toBeNull();
    expect(r.getByTestId('telegraph-unarchive-t-noor')).toBeTruthy();
  });

  it('the last archived conversation unarchived: the Archived section goes', async () => {
    mockThreads.current = [thread('t-mira', 'mira', null), thread('t-kai', 'kai', ARCHIVED_AT)];
    mockUnarchive.mockResolvedValue({ ok: true });
    const r = await mount();
    await act(async () => { fireEvent.press(r.getByTestId('telegraph-unarchive-t-kai')); });
    expect(order(r)).toEqual(['mira', 'kai']);
  });

  it('THE POINT: a failure is said, nothing moves, and the action stays for a retry', async () => {
    mockThreads.current = [thread('t-mira', 'mira', null), thread('t-kai', 'kai', ARCHIVED_AT)];
    mockUnarchive.mockResolvedValueOnce({ ok: false, message: 'We could not check your access to this conversation right now. Please try again shortly.' });
    const r = await mount();
    await act(async () => { fireEvent.press(r.getByTestId('telegraph-unarchive-t-kai')); });
    const failure = r.getByTestId('telegraph-unarchive-failed-t-kai');
    expect(failure.props.accessibilityRole).toBe('alert');
    expect(failure.props.children).toBe('We could not check your access to this conversation right now. Please try again shortly.');
    expect(order(r)).toEqual(['mira', 'Archived', 'kai']);
    const again = r.getByTestId('telegraph-unarchive-t-kai');
    expect(again.props.accessibilityState).toEqual(expect.objectContaining({ busy: false, disabled: false }));

    mockUnarchive.mockResolvedValueOnce({ ok: true });
    await act(async () => { fireEvent.press(again); });
    expect(mockUnarchive).toHaveBeenCalledTimes(2);
    expect(order(r)).toEqual(['mira', 'kai']);
    expect(r.queryByTestId('telegraph-unarchive-failed-t-kai')).toBeNull();
  });

  it('a failure with no usable message from the server still says what did not happen', async () => {
    mockThreads.current = [thread('t-kai', 'kai', ARCHIVED_AT)];
    mockUnarchive.mockResolvedValue({ ok: false, message: null });
    const r = await mount();
    await act(async () => { fireEvent.press(r.getByTestId('telegraph-unarchive-t-kai')); });
    expect(r.getByTestId('telegraph-unarchive-failed-t-kai').props.children).toBe('Could not unarchive this conversation. Please try again.');
  });
});
