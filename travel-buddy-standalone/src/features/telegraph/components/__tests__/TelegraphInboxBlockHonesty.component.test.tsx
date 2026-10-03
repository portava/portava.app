/**
 * Telegraph — a BLOCK that did not go through must not look like one that did.
 *
 * The inbox's request card used to run `await blockUser(id); await onDecline();`
 * and ignore what `blockUser` returned. On a failed block the request was still
 * declined — so it vanished from the list — and nothing was said: the person
 * believed they had blocked someone who could still message them. The same
 * shape was on the thread screen's Block and its long-press "Block this
 * person", which navigated back to the inbox whatever happened
 * (app/messages/[id].tsx; that screen cannot be mounted under jest-expo — see
 * unsupportedPayload.component.test.tsx — so its two sites are held by the
 * source assertion at the foot of this file and by the shared copy helper).
 *
 * WHAT TURNS THIS RED: declining before (or regardless of) a successful block,
 * or saying nothing when the block fails.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Alert } from 'react-native';
import { render, act, fireEvent } from '@testing-library/react-native';

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

const mockDecline = jest.fn();
const mockThreads: { current: any[] } = { current: [] };
// NOTE: intentional exhaustive stub — these hooks are the screen's data
// contract and each reaches supabase + apiToken at load time.
jest.mock('../../../../hooks/useMessaging', () => ({
  useMyThreads: () => ({ data: mockThreads.current, loading: false, refreshing: false, error: null, reload: jest.fn(), refresh: jest.fn() }),
  useIncomingMessageRequests: () => ({
    data: [{
      requestId: 'r1',
      previewText: 'hi, are you going to the market?',
      createdAt: '2026-10-01T10:00:00.000Z',
      origin: null,
      sender: { id: 'stranger-1', handle: 'stranger', name: null, avatarUrl: null, city: null, language: null },
    }],
    loading: false,
    reload: jest.fn(),
    accept: jest.fn(),
    decline: (...a: unknown[]) => mockDecline(...a),
  }),
  useUnreadCounts: () => ({ meetups: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockedIds: new Set(), blockerIds: new Set() }),
}));

const mockBlockUser = jest.fn();
// NOTE: intentional stub — the block call is the subject; nothing else is used.
jest.mock('../../../../services/blocks', () => ({
  getBlockList: jest.fn().mockResolvedValue({ ok: true, data: [] }),
  blockUser: (...a: unknown[]) => mockBlockUser(...a),
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

/** Press the destructive "Block" button of whichever confirm dialog the screen raises. */
function autoConfirmBlock() {
  return jest.spyOn(Alert, 'alert').mockImplementation(((title: string, _msg?: string, buttons?: any[]) => {
    const b = (buttons ?? []).find((x) => x?.text === 'Block');
    if (title === 'Block this person?' && b?.onPress) void b.onPress();
  }) as never);
}

async function openRequestsAndBlock() {
  const r = await render(<TelegraphInboxScreen />);
  await act(async () => {});
  await act(async () => { fireEvent.press(r.getByLabelText('Requests, 1 pending request')); });
  await act(async () => { fireEvent.press(r.getByText('Block')); });
  await act(async () => {});
  return r;
}

describe('inbox request card — a failed block is said, and the request stays', () => {
  beforeEach(() => {
    mockDecline.mockReset().mockResolvedValue({ ok: true, data: { status: 'declined' } });
    mockBlockUser.mockReset();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('THE POINT: a block that FAILED does not decline the request, and says so', async () => {
    mockBlockUser.mockResolvedValue({ ok: false, error: 'Failed to block user' });
    const alerts = autoConfirmBlock();
    await openRequestsAndBlock();
    expect(mockBlockUser).toHaveBeenCalledWith('stranger-1');
    expect(mockDecline).not.toHaveBeenCalled();
    const said = alerts.mock.calls.find((c) => c[0] === 'Could not block');
    expect(said).toBeTruthy();
    expect(String(said![1])).toMatch(/can still message you/);
  });

  it('CONTROL: a block that worked removes the request as before', async () => {
    mockBlockUser.mockResolvedValue({ ok: true });
    const alerts = autoConfirmBlock();
    await openRequestsAndBlock();
    expect(mockDecline).toHaveBeenCalledWith('r1');
    expect(alerts.mock.calls.find((c) => c[0] === 'Could not block')).toBeUndefined();
  });
});

describe('thread screen — every Block path checks the result (source-level: the screen is not mountable here)', () => {
  const src = readFileSync(join(__dirname, '../../../../../app/messages/[id].tsx'), 'utf8');

  it('no call to blockUser is left unchecked', () => {
    const calls = src.match(/blockUser\(otherUserId\)/g) ?? [];
    const checked = src.match(/const blocked = await blockUser\(otherUserId\);/g) ?? [];
    // The header Block, the long-press "Block this person" and the safety sheet's Block.
    expect(calls.length).toBe(3);
    expect(checked.length).toBe(calls.length);
  });

  it('each leaves the conversation only on success, and says so on failure', () => {
    const outcomes = src.match(/if \(blocked\.ok\) router\.replace\('\/messages'\); else Alert\.alert\('Could not block', blockFailedCopy\(blocked\.error\)\)/g) ?? [];
    expect(outcomes.length).toBe(3);
  });
});

describe('inbox → thread: the thread opens showing the mute the server holds', () => {
  const thread = (over: Record<string, unknown>) => ({
    id: 't1', threadType: 'direct', tripId: null, circleOwnerId: null, title: null, status: 'active',
    lastMessageAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', mutedAt: null, archivedAt: null,
    otherMembers: [{ id: 'u2', handle: 'mira', name: null, avatarUrl: null }], lastMessagePreview: null, unreadCount: 0, ...over,
  });
  afterEach(() => { mockThreads.current = []; mockPush.mockReset(); });

  it('THE POINT: a muted thread opens with `muted=1` — the screen used to start "unmuted" whatever the server held', async () => {
    mockThreads.current = [thread({ mutedAt: '2026-09-20T00:00:00.000Z' })];
    const r = await render(<TelegraphInboxScreen />);
    await act(async () => {});
    await act(async () => { fireEvent.press(r.getAllByTestId('telegraph-row')[0]!); });
    expect(String(mockPush.mock.calls[0]?.[0])).toMatch(/[?&]muted=1(&|$)/);
  });

  it('CONTROL: an unmuted thread carries no mute flag', async () => {
    mockThreads.current = [thread({ mutedAt: null })];
    const r = await render(<TelegraphInboxScreen />);
    await act(async () => {});
    await act(async () => { fireEvent.press(r.getAllByTestId('telegraph-row')[0]!); });
    expect(String(mockPush.mock.calls[0]?.[0])).not.toMatch(/muted=/);
  });
});
