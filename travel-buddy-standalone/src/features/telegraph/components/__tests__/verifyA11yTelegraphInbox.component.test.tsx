/**
 * VERIFICATION LANE V4 — ACCESSIBILITY on the Telegraph inbox.
 *
 * The inbox is a list of rows whose whole job is to say, at a glance, WHICH
 * conversation needs you and HOW MUCH. Every one of those signals is a badge: a
 * number in a coloured bubble, a bell with a line through it, a chip that is a
 * different colour when it is the one you are on. None of them is a sentence,
 * and until this sweep none of them carried one either — so the entire "at a
 * glance" layer of the screen was available at a glance and nowhere else.
 *
 * The four questions:
 *   1. LABEL AND ROLE — the filter chips are Pressables with neither.
 *   2. STATE ANNOUNCED — "3 unread", "muted", and which filter is ACTIVE.
 *   3. COLOUR ALONE — the active chip is `chipActive` (a fill) and nothing else;
 *      the unread name is bold; the mute state is an unlabelled glyph.
 *   4. GESTURE-ONLY — nothing; the list is a FlatList of Pressables.
 *
 * NOT COVERED HERE, SAID PLAINLY. `TelegraphRow` is stubbed to a plain View by
 * the mock set below, inherited from `TelegraphInboxNeedsAction.component.test`.
 * That means the ROW's own press target is not under test in this file — only
 * what the inbox screen renders INSIDE it. `TelegraphRow` lives in
 * `components/telegraph/TelegraphPrimitives.tsx`, is shared by several surfaces,
 * and its missing `accessibilityRole="button"` is reported in
 * `docs/verification/accessibility.md` as an unfixed finding rather than
 * silently changed from a file this lane does not own the test surface for.
 *
 * ── RED-FIRST RECORD (measured 2026-09-16, `pnpm test:component`) ───────────
 * Against the unmodified code: all 5 RED.
 *
 *   ✕ I1  the filter chips announce as buttons and say which one is ACTIVE
 *   ✕ I2  the requests chip's badge is in its NAME, not a naked number
 *   ✕ I3  an unread count says what it counts
 *   ✕ I4  a muted thread says "muted" — the glyph is not the only signal
 *   ✕ I5  every chip in the row carries a role and a name
 *
 * DEFECT C1 — THE FILTER CHIPS WERE ROLE-LESS, AND "ACTIVE" WAS A FILL COLOUR.
 *   RED: ✕ I1  expect(received).toBe("button")  Received: undefined
 *   Six chips ("All", "Direct", "Trips", "Circles", "Unread", "Requests") in a
 *   horizontal scroller. Each is a `<Pressable>` whose only selected-state
 *   signal is `s.chipActive` — a background fill — and whose text is the only
 *   thing a reader has. So the screen could tell you the six filters exist and
 *   could not tell you which one you were looking at, which is the one fact you
 *   need to interpret every row below it.
 *   FIXED: `accessibilityRole="button"` and `accessibilityState={{ selected }}`.
 *
 * DEFECT C2 — THE REQUESTS BADGE WAS A NAKED NUMBER BESIDE A WORD.
 *   RED: ✕ I2  expect(received).toContain("3")  Received: undefined
 *   The chip renders "Requests" and, in a separate bubble, "3". A reader reaches
 *   them as two nodes and says "Requests" then "3" — or, grouped, "Requests 3",
 *   which is as likely to be heard as an ordinal.
 *   FIXED: the count is folded into the chip's own accessibilityLabel.
 *
 * DEFECT C3 — AN UNREAD COUNT WAS A NAKED NUMBER IN A BUBBLE.
 *   RED: ✕ I3  Unable to find an element with testID: telegraph-row-unread
 *   The row read "mira, 3, 2h ago". The 3 is the single most important thing on
 *   the row and it is the one thing that does not say what it is.
 *   FIXED: the bubble is labelled "N unread messages" and the digits inside it
 *   are hidden, so the count is spoken once, as a sentence.
 *
 * DEFECT C4 — "MUTED" WAS A GLYPH AND NOTHING ELSE.
 *   RED: ✕ I4  Unable to find an element with testID: telegraph-row-muted
 *   A `<BellOff size={12} />` between the name and the type badge. Muting
 *   changes whether a conversation can reach you at all; a reader could not tell
 *   a muted thread from an unmuted one.
 *   FIXED: an `accessibilityLabel` on a wrapper the reader can reach.
 *
 * PROVEN BY MUTATION (already correct — mutate, red, revert):
 *   M1  §19 needs-action wording
 *       MUTATION: `${needsAction} need action` → `${needsAction}`
 *       RED: ✕ I6. "needs action" is a SENTENCE, not a count
 *       Reverted. The build lane got this one right and it is the reason the
 *       others stand out: the same row has one badge that says what it counts
 *       and two that do not.
 *
 * RNTL v14: render() is async — always await the mount helper.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

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

const threadsRef: { current: any[] } = { current: [] };
const requestsRef: { current: any[] } = { current: [] };
// NOTE: intentional exhaustive stub. These three hooks are the screen's entire
// data contract and each reaches supabase + apiToken at load time, which has no
// native module under jest — `jest.requireActual` would pull that chain in. The
// fixture IS this factory, so it stays exhaustive rather than partial.
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
    data: requestsRef.current,
    loading: false,
    reload: jest.fn(),
    accept: jest.fn(),
    decline: jest.fn(),
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

// NOTE: intentional stub — the row primitive is shared and is NOT the subject
// here; see this file's header for what that excludes.
jest.mock('../../../../components/telegraph/TelegraphPrimitives', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TelegraphAvatar: () => React.createElement(View, null),
    TelegraphRow: ({ children }: any) => React.createElement(View, null, children),
  };
});

// NOTE: intentional stub — not under test here.
jest.mock('../../../../components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children, style }: any) =>
      React.createElement(View, { style }, children),
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

async function renderInbox(threads: any[], requests: any[] = []) {
  threadsRef.current = threads;
  requestsRef.current = requests;
  const r = await render(<TelegraphInboxScreen />);
  await act(async () => {});
  return r;
}

beforeEach(() => {
  requestsRef.current = [];
});

describe('Telegraph inbox — the filter chips', () => {
  it('I1. the chips announce as BUTTONS and say which one is ACTIVE', async () => {
    await renderInbox([thread()]);
    const all = screen.getByTestId('telegraph-filter-all');
    const unread = screen.getByTestId('telegraph-filter-unread');

    expect(all.props.accessibilityRole).toBe('button');
    expect(unread.props.accessibilityRole).toBe('button');
    // The active chip's only visual signal is a background fill. Without this,
    // the screen can name the six filters and cannot say which one you are on —
    // the single fact you need to read every row below.
    expect(all.props.accessibilityState.selected).toBe(true);
    expect(unread.props.accessibilityState.selected).toBe(false);
  });

  it('I2. the requests chip folds its BADGE into its name', async () => {
    await renderInbox(
      [thread()],
      [
        { id: 'r1', senderId: 'u9', status: 'pending' },
        { id: 'r2', senderId: 'u8', status: 'pending' },
        { id: 'r3', senderId: 'u7', status: 'pending' },
      ],
    );
    const chip = screen.getByTestId('telegraph-filter-requests');
    const label = String(chip.props.accessibilityLabel);
    expect(label).toContain('Requests');
    // "Requests" then "3" as two nodes is as likely to be heard as an ordinal
    // as a count.
    expect(label).toMatch(/3\b/);
    expect(label).toMatch(/request/i);
  });

  it('I5. every chip in the row carries a role and a name', async () => {
    // The sweep, rather than the two chips that happened to be checked above.
    await renderInbox([thread()]);
    for (const key of ['all', 'direct', 'trips', 'circles', 'unread', 'requests']) {
      const chip = screen.getByTestId(`telegraph-filter-${key}`);
      expect({ key, role: chip.props.accessibilityRole }).toEqual({ key, role: 'button' });
      const label = String(chip.props.accessibilityLabel ?? '');
      expect({ key, named: label.trim().length > 0 }).toEqual({ key, named: true });
      expect({ key, hasState: typeof chip.props.accessibilityState?.selected }).toEqual({
        key,
        hasState: 'boolean',
      });
    }
  });
});

describe('Telegraph inbox — the row badges', () => {
  it('I3. an unread count says WHAT it counts', async () => {
    await renderInbox([thread({ unreadCount: 3 })]);
    const bubble = screen.getByTestId('telegraph-row-unread');
    expect(String(bubble.props.accessibilityLabel)).toMatch(/3 unread/i);
    // Spoken ONCE: the digits inside the bubble are hidden, or a reader says
    // "3 unread messages" and then "3".
    expect(screen.queryByText('3')).toBeNull();
  });

  it('I3b. the 99+ cap is still a sentence, and still the TRUE number', async () => {
    await renderInbox([thread({ unreadCount: 250 })]);
    const bubble = screen.getByTestId('telegraph-row-unread');
    // The bubble shows "99+" because 250 does not fit. The LABEL has no such
    // constraint, so capping it too would throw away a number we hold.
    expect(String(bubble.props.accessibilityLabel)).toMatch(/250 unread/i);
  });

  it('I3c. a read thread renders NO unread badge — the fix must not invent one', async () => {
    await renderInbox([thread({ unreadCount: 0 })]);
    expect(screen.queryByTestId('telegraph-row-unread')).toBeNull();
  });

  it('I4. a MUTED thread says so — the glyph is not the only signal', async () => {
    await renderInbox([thread({ mutedAt: '2026-05-01T00:00:00.000Z' })]);
    const muted = screen.getByTestId('telegraph-row-muted');
    expect(String(muted.props.accessibilityLabel)).toMatch(/muted/i);
  });

  it('I4b. an UNMUTED thread renders no mute marker', async () => {
    await renderInbox([thread({ mutedAt: null })]);
    expect(screen.queryByTestId('telegraph-row-muted')).toBeNull();
  });

  it('I6. "needs action" is a SENTENCE, not a count — the one badge already right', async () => {
    // §19's wording, which the build lane got right. It is here because it is
    // the control for every other badge on the row: the same row had one badge
    // that said what it counted and two that did not.
    await renderInbox([thread({ needsActionCount: 2, needsActionReasons: ['rsvp_pending'] })]);
    expect(screen.getByText('2 need action')).toBeTruthy();
  });
});
