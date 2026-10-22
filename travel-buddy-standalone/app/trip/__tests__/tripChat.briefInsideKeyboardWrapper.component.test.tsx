/**
 * Trip chat (app/trip/chat.tsx) — the daily brief rides INSIDE the chat's keyboard wrapper, under its header.
 *
 * The layover's "Ask locals" lands here. The route drew DailyBriefCard ABOVE GroupChatScreen, so:
 *   - the chat's KeyboardAvoidingView (offset 0) started a card's height down its parent. It sizes its bottom padding
 *     from its OWN frame (onLayout, parent-relative), so the padding came up short by exactly the card's height and,
 *     on the owner's iPhone 17 Pro Max, the composer and the send button stayed under the keyboard;
 *   - the card's top sat behind the status bar / Dynamic Island, while the chat's header below it added
 *     insets.top + 8 of its own.
 * GroupChatScreen is now the route's root (its keyboard wrapper starts at y=0) and draws the brief through its
 * `banner` prop, after its header, inside the wrapper.
 *
 * Jest computes no layout, so this pins the tree that decides it: the wrapper is the root, nothing precedes it, and
 * the brief is inside it, after the header and before the composer.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// The shared expo-router stub (moduleNameMapper), with the trip id param.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'trip-1' }),
}));

// NOTE: intentional stub — the owner's iPhone 17 Pro Max insets.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// NOTE: intentionally exhaustive — the keyboard wrapper as a marked pass-through View. Jest has no keyboard or layout;
// what decides the iPhone bug is WHERE the wrapper sits in the tree, which this keeps.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const { View: V } = require('react-native');
  const Wrapper = ({ children, style }: { children: React.ReactNode; style?: unknown }) =>
    R.createElement(V, { testID: 'keyboard-wrapper', style }, children);
  return { KeyboardSafeScrollView: Wrapper, KeyboardSafeView: Wrapper };
});

// NOTE: intentionally exhaustive — the brief's own content has its own suite (DailyBriefCard.tmLive).
jest.mock('../../../src/components/DailyBriefCard', () => {
  const { View: V } = require('react-native');
  return { DailyBriefCard: (p: { tripId: string; compact?: boolean }) => <V testID={`daily-brief:${p.tripId}:${p.compact ? 'compact' : 'full'}`} /> };
});

// NOTE: intentionally exhaustive — a trip thread with no messages, in the state each test sets; the hook's transport
// has its own suite.
let mockChatState: 'active' | 'loading' = 'active';
jest.mock('../../../src/hooks/useGroupChat', () => ({
  useGroupChat: () => ({
    state: mockChatState,
    thread: mockChatState === 'active' ? { id: 'thread-1', title: null, memberAccess: 'member' } : null,
    messages: [], sending: false, errorMessage: null, typingUserIds: [],
    reload: jest.fn(), send: jest.fn(), retrySend: jest.fn(), notifyTyping: jest.fn(), edit: jest.fn(),
    remove: jest.fn(), loadMore: jest.fn(),
  }),
}));

// NOTE: intentionally exhaustive — the viewer's id is all the screen reads.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'viewer-1' }),
}));

// NOTE: spreading requireActual so the mock never drifts behind new exports; the member preview is not under test.
jest.mock('../../../src/services/friends', () => ({
  ...jest.requireActual('../../../src/services/friends'),
  getTripMembers: jest.fn().mockResolvedValue({ ok: false }),
  getCircleMembers: jest.fn().mockResolvedValue({ ok: false }),
}));

import TripChatScreen from '../chat';

type Node = { type?: string; props?: Record<string, any>; children?: Array<Node | string> | null };

/** Depth-first (document) order of every host node under `root`. */
function walk(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (n: Node | string | null | undefined) => {
    if (!n || typeof n !== 'object') return;
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

it('the chat is the root: its keyboard wrapper starts the tree and holds the brief after the header', async () => {
  await render(<TripChatScreen />);
  const root = (screen as any).root as Node;
  const wrapper = screen.getByTestId('keyboard-wrapper') as unknown as Node;

  // Nothing above the wrapper offsets it: it IS the route's root host node. (Compared by id: a failing toBe would
  // print two whole host trees.)
  expect(root.props?.testID).toBe('keyboard-wrapper');
  expect(root === wrapper).toBe(true);

  const order = walk(wrapper);
  const at = (n: unknown) => order.indexOf(n as Node);
  const brief = screen.getByTestId('daily-brief:trip-1:compact');
  const title = screen.getByText('Trip Chat');
  const composer = screen.getByPlaceholderText('Write a Telegraph…');

  // Inside the wrapper, after the header (its title), before the composer.
  expect(at(brief)).toBeGreaterThan(-1);
  expect(at(title)).toBeGreaterThan(-1);
  expect(at(composer)).toBeGreaterThan(-1);
  expect(at(brief)).toBeGreaterThan(at(title));
  expect(at(brief)).toBeLessThan(at(composer));
});

it('while the chat loads, the brief is still drawn once, under the header', async () => {
  mockChatState = 'loading';
  try {
    await render(<TripChatScreen />);
    const order = walk((screen as any).root as Node);
    const briefs = screen.getAllByTestId('daily-brief:trip-1:compact');
    expect(briefs).toHaveLength(1);
    expect(order.indexOf(briefs[0] as unknown as Node)).toBeGreaterThan(order.indexOf(screen.getByText('Trip Chat') as unknown as Node));
  } finally {
    mockChatState = 'active';
  }
});
