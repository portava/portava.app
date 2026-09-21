/**
 * Telegraph §3 / §11 — the rail, rendered.
 *
 * What a component test can settle here: that the rail EXISTS in the tree at
 * the top of a conversation, that §11.2's four visible states each produce a
 * different tree, that §11.3's "do not encode status solely by colour" holds
 * (every band renders its word), and that a failed read renders NOTHING rather
 * than an empty rail. Screen-reader BEHAVIOUR still needs a device and is not
 * claimed; §11.3's reduced-motion requirement is proved against the message
 * stream in `MessageEntrance.reducedMotion.component.test.tsx`.
 *
 * SHOWN RED before commit, each reverted:
 *   • `if (failed || !response) return null;` → `return <View/>` with an
 *     "Nothing shared yet" Text — "a failed read renders nothing" RED.
 *   • drop `<Text style={styles.bandWord}>` from RailCard — the §11.3 word
 *     test RED (three assertions).
 *   • drop the `See all` Pressable — the See-all test RED.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — the real api module imports lib/supabase, which
// builds a client at import time and fails outside an Expo runtime. Only the
// two functions the component calls are stubbed; every rail DECISION under
// test still runs in the real railBehavior module.
jest.mock('../sharedContext/api.ts', () => ({
  fetchSharedContext: jest.fn(),
  fetchConversationHeader: jest.fn(),
}));

// NOTE: intentional stub — AccessibilityInfo is not backed in the jest
// preset's native layer; the hook under test here is the rail's USE of the
// value, not the hook itself (which has its own coverage in the Wall tree).
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  useReducedMotionSetting: jest.fn(() => false),
}));

import { SharedContextRail } from '../sharedContext/SharedContextRail.tsx';
import { fetchSharedContext } from '../sharedContext/api.ts';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';
import type { SharedContextItem, SharedContextResponse } from '../sharedContext/types.ts';

const mockedFetch = fetchSharedContext as jest.MockedFunction<typeof fetchSharedContext>;
const mockedReduceMotion = useReducedMotionSetting as jest.MockedFunction<typeof useReducedMotionSetting>;

function item(id: string, band: SharedContextItem['orderBand'], over: Partial<SharedContextItem> = {}): SharedContextItem {
  return {
    objectType: 'MEETUP',
    objectId: id,
    title: `Plan ${id}`,
    relationship: 'BOTH_PARTICIPANTS',
    status: 'active',
    availableActions: ['JOIN_PLAN'],
    orderBand: band,
    ...over,
  };
}

function response(over: Partial<SharedContextResponse> = {}): SharedContextResponse {
  return {
    sharedContext: {
      conversationId: 'thread-1',
      generatedAt: '2026-05-10T06:00:00.000Z',
      now: [],
      upcoming: [],
      unresolved: [],
      past: [],
    },
    railMode: 'EMPTY',
    collapsedSummary: '',
    incomplete: false,
    refusedCount: 0,
    ...over,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedReduceMotion.mockReturnValue(false);
});

describe('SharedContextRail', () => {
  it('§11.2 row 1: an active plan renders the expanded NOW card at the top', async () => {
    const r = response({
      sharedContext: {
        conversationId: 'thread-1',
        generatedAt: 'x',
        now: [item('n', 'HAPPENING_NOW', { title: 'Dinner with Marcus' })],
        upcoming: [item('u', 'UPCOMING', { title: 'Hoi An tomorrow' })],
        unresolved: [],
        past: [],
      },
      railMode: 'EXPANDED_NOW',
    });
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} />);
    expect(screen.getByTestId('telegraph-shared-context-rail')).toBeTruthy();
    expect(screen.getByTestId('telegraph-rail-card-n')).toBeTruthy();
    expect(screen.getByText('Dinner with Marcus')).toBeTruthy();
  });

  it('§11.3: the band is a WORD, not only a colour', async () => {
    const r = response({
      sharedContext: {
        conversationId: 'thread-1', generatedAt: 'x',
        now: [item('n', 'HAPPENING_NOW')],
        upcoming: [item('t', 'ACTIVE_TRIP', { objectType: 'TRIP', title: 'Da Nang' })],
        unresolved: [item('w', 'UNRESOLVED', { objectType: 'WANT_TO_DO' })],
        past: [],
      },
      railMode: 'EXPANDED_NOW',
    });
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} />);
    expect(screen.getByText('Happening now')).toBeTruthy();
    expect(screen.getByText('Active trip')).toBeTruthy();
    expect(screen.getByText('Want to do')).toBeTruthy();
  });

  it('§11.1: caps the cards and offers See all', async () => {
    const many = Array.from({ length: 7 }, (_, i) => item(`u${i}`, 'UPCOMING'));
    const r = response({
      sharedContext: { conversationId: 'thread-1', generatedAt: 'x', now: [], upcoming: many, unresolved: [], past: [] },
      railMode: 'COMPACT_UPCOMING',
    });
    const onSeeAll = jest.fn();
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} onSeeAll={onSeeAll} />);
    expect(screen.getByTestId('telegraph-rail-card-u0')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-rail-card-u6')).toBeNull();
    const seeAll = screen.getByTestId('telegraph-rail-see-all');
    fireEvent.press(seeAll);
    expect(onSeeAll).toHaveBeenCalledTimes(1);
  });

  it('§11.2 row 3: with neither active nor upcoming, it is a summary line', async () => {
    const r = response({
      sharedContext: {
        conversationId: 'thread-1', generatedAt: 'x', now: [], upcoming: [], unresolved: [],
        past: [item('p', 'PAST', { objectType: 'TRIP' })],
      },
      railMode: 'COLLAPSED_SUMMARY',
      collapsedSummary: '1 past trip',
    });
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} />);
    expect(screen.getByTestId('telegraph-rail-summary')).toBeTruthy();
    expect(screen.getByText('1 past trip')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-rail-cards')).toBeNull();
  });

  it('§11.2 row 4: scrolled, the rail minimises and the cards go away', async () => {
    const r = response({
      sharedContext: {
        conversationId: 'thread-1', generatedAt: 'x', now: [item('n', 'HAPPENING_NOW')],
        upcoming: [], unresolved: [], past: [],
      },
      railMode: 'EXPANDED_NOW',
      collapsedSummary: '1 shared plan',
    });
    await render(<SharedContextRail threadId="thread-1" scrolled initialResponse={r} />);
    expect(screen.getByTestId('telegraph-rail-minimized')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-rail-card-n')).toBeNull();
  });

  it('an EMPTY rail renders nothing at all — no chrome, no placeholder', async () => {
    await render(<SharedContextRail threadId="thread-1" initialResponse={response()} />);
    expect(screen.queryByTestId('telegraph-shared-context-rail')).toBeNull();
  });

  it('a failed read renders nothing — "could not tell" is not "nothing shared"', async () => {
    mockedFetch.mockResolvedValue({ ok: false, error: 'server' });
    await render(<SharedContextRail threadId="thread-1" />);
    expect(mockedFetch).toHaveBeenCalledWith('thread-1');
    // Nothing at all: no rail chrome, no summary, no "nothing shared" copy.
    expect(screen.queryByTestId('telegraph-shared-context-rail')).toBeNull();
    expect(screen.queryByTestId('telegraph-rail-summary')).toBeNull();
    expect(screen.queryByLabelText('Loading shared context')).toBeNull();
  });

  it('a partially-resolved rail says so out loud', async () => {
    const r = response({
      sharedContext: {
        conversationId: 'thread-1', generatedAt: 'x', now: [], upcoming: [item('u', 'UPCOMING')],
        unresolved: [], past: [],
      },
      railMode: 'COMPACT_UPCOMING',
      incomplete: true,
    });
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} />);
    expect(screen.getByTestId('telegraph-rail-incomplete')).toBeTruthy();
  });

  it('tapping a card hands the object out; the rail never mutates anything', async () => {
    const onOpen = jest.fn();
    const r = response({
      sharedContext: {
        conversationId: 'thread-1', generatedAt: 'x', now: [item('n', 'HAPPENING_NOW')],
        upcoming: [], unresolved: [], past: [],
      },
      railMode: 'EXPANDED_NOW',
    });
    await render(<SharedContextRail threadId="thread-1" initialResponse={r} onOpenObject={onOpen} />);
    fireEvent.press(screen.getByTestId('telegraph-rail-card-n'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ objectId: 'n' }));
  });
});
