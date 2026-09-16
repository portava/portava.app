/**
 * Telegraph §19 — "12 unread · 1 needs action", the badge, against the real
 * inbox screen.
 *
 * census-telegraph T260 said "needs action" had no representation. The server
 * now computes it (artifacts/api-server/src/domain/telegraph/policies/needsAction.ts,
 * returned by GET /me/threads), and this suite is about the half a traveller
 * can actually see.
 *
 * THE ONE DISTINCTION THAT MATTERS HERE
 * =====================================
 * The server OMITS `needsActionCount` when it could not read the inputs, rather
 * than sending `0`, because `0` is a claim that there is nothing to do. That
 * care is thrown away by one `?? 0` in the client, so this suite renders all
 * three states through the real screen:
 *
 *   count > 0    -> the badge, with §19's own wording
 *   count === 0  -> no badge (a real, measured "nothing outstanding")
 *   absent       -> no badge either, and — the point — no "0 needs action"
 *
 * WHAT TURNS THIS RED — measured, not guessed. Both mutations were run:
 *   • the badge rendered on `needsAction >= 0` instead of `> 0` → the measured
 *     zero case fails, because the inbox then prints "0 needs action" on a row
 *     whose emptiness may only mean the server could not look.
 *   • the badge driven by `unread` instead of `needsAction` → four cases fail,
 *     including the two whose fixtures separate unread traffic from an
 *     outstanding answer.
 *   Together: 5 of 6 red. Reverted; 6 of 6 green.
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
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

// The one mock that carries the fixture: every case below differs only in the
// threads this hook returns.
const threadsRef: { current: any[] } = { current: [] };
// NOTE: intentional exhaustive stub. These three hooks are the screen's entire
// data contract and each one reaches supabase + apiToken at load time, which has
// no native module under jest; requireActual would pull that chain in. The
// fixture IS this factory, so it must stay exhaustive rather than partial.
jest.mock('../../../../hooks/useMessaging', () => ({
  useMyThreads: () => ({
    data: threadsRef.current,
    loading: false,
    refreshing: false,
    error: null,
    reload: jest.fn(),
    refresh: jest.fn(),
  }),
  useIncomingMessageRequests: () => ({
    data: [], loading: false, reload: jest.fn(), accept: jest.fn(), decline: jest.fn(),
  }),
  useUnreadCounts: () => ({ meetups: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockerIds: new Set() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/blocks', () => ({
  getBlockList: jest.fn().mockResolvedValue({ ok: true, data: [] }),
  blockUser: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/reports', () => ({ reportContent: jest.fn() }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../components/HighlightRing', () => ({
  HighlightRing: ({ children }: any) => children,
}));
jest.mock('../../../../components/HighlightViewer', () => ({ HighlightViewer: () => null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../../hooks/useHighlightRingState', () => ({ useHighlightRingState: () => null }));

jest.mock('../../../../components/telegraph/TelegraphPrimitives', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TelegraphAvatar: () => React.createElement(View, null),
    TelegraphRow: ({ children }: any) => React.createElement(View, null, children),
  };
});

jest.mock('../../../../components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children, style }: any) => React.createElement(View, { style }, children),
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../../services/compass', () => ({
  postCompassFrontloadEvent: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../lib/displayIdentity', () => ({
  primaryIdentityText: ({ handle }: any) => handle ?? 'Unknown',
  secondaryIdentityText: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../../components/CircleStatusCardMessage.logic', () => ({
  circleCardInboxPreview: () => '',
}));

import { TelegraphInboxScreen } from '../../../../components/TelegraphInboxScreen.tsx';

function thread(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    threadType: 'direct',
    tripId: null,
    circleOwnerId: null,
    title: null,
    status: 'active',
    lastMessageAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
    mutedAt: null,
    archivedAt: null,
    otherMembers: [{ userId: 'u2', handle: 'mira', name: null }],
    lastMessagePreview: {
      body: 'see you there',
      displayBody: 'see you there',
      senderId: 'u2',
      createdAt: '2026-05-01T00:00:00.000Z',
      msgType: 'text',
      subtype: null,
    },
    unreadCount: 0,
    ...over,
  };
}

async function renderInbox(threads: any[]) {
  threadsRef.current = threads;
  const r = await render(<TelegraphInboxScreen />);
  await act(async () => {});
  return r;
}

describe('Telegraph inbox — the needs-action badge', () => {
  it('renders §19 wording when the server reports one outstanding action', async () => {
    const { queryByText } = await renderInbox([
      thread({ needsActionCount: 1, needsActionReasons: ['rsvp_pending'] }),
    ]);
    expect(queryByText('1 needs action')).toBeTruthy();
  });

  it('pluralises rather than printing "2 needs action"', async () => {
    const { queryByText } = await renderInbox([
      thread({ needsActionCount: 2, needsActionReasons: ['rsvp_pending', 'time_vote_pending'] }),
    ]);
    expect(queryByText('2 need action')).toBeTruthy();
    expect(queryByText('2 needs action')).toBeNull();
  });

  it('a measured zero renders NO badge — not "0 needs action"', async () => {
    const { queryByText } = await renderInbox([
      thread({ needsActionCount: 0, needsActionReasons: [] }),
    ]);
    expect(queryByText('0 needs action')).toBeNull();
    expect(queryByText('0 need action')).toBeNull();
  });

  it('an ABSENT count renders no badge — "we do not know" is not "nothing to do"', async () => {
    // The server omits the field when its inputs were unreadable. A client that
    // defaulted it to a number would print a reassurance nobody verified.
    const { queryByText } = await renderInbox([thread()]);
    expect(queryByText('0 needs action')).toBeNull();
    expect(queryByText('1 needs action')).toBeNull();
  });

  it('unread and needs-action are independent claims', async () => {
    // Unread traffic, nothing to answer: no badge. A badge driven by unreadCount
    // would appear here.
    const { queryByText } = await renderInbox([
      thread({ unreadCount: 12, needsActionCount: 0, needsActionReasons: [] }),
    ]);
    expect(queryByText('1 needs action')).toBeNull();
    expect(queryByText('12 need action')).toBeNull();
  });

  it('a thread with unread traffic AND an action shows both', async () => {
    const { queryByText, queryByLabelText } = await renderInbox([
      thread({ unreadCount: 12, needsActionCount: 1, needsActionReasons: ['time_vote_pending'] }),
    ]);
    // The unread bubble. Since V4's accessibility sweep the DIGITS inside it are
    // hidden from the accessibility tree and the count is carried by the
    // bubble's label instead, so a reader says "12 unread messages" once rather
    // than that and then "12". The claim here is unchanged — the bubble is
    // rendered and carries 12 — and it is now made through the name a person
    // actually receives.
    expect(queryByLabelText('12 unread messages')).toBeTruthy();
    expect(queryByText('12', { includeHiddenElements: true })).toBeTruthy();
    expect(queryByText('1 needs action')).toBeTruthy();
  });
});
