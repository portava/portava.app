/**
 * Messages / Telegraph inbox (app/(tabs)/messages.tsx → TelegraphInboxScreen)
 * — scroll-architecture regression test.
 *
 * Confirms that after Task #1559, the Telegraph header ("Telegraph" brand
 * title, search bar, filter chips) is rendered as FlatList's
 * ListHeaderComponent — NOT as a sibling View pinned above the scroll
 * container.
 *
 * Strategy: render the Messages tab, walk the toJSON tree to find all
 * ScrollView / FlatList nodes (jest-expo renders FlatList as ScrollView),
 * then verify that the "Telegraph" brand text lives within at least one of
 * them. A third test walks the root children to confirm there is no
 * non-overlay View sibling above the scroll container.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
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

// NOTE: all src/ modules are 3 directories up from app/(tabs)/__tests__/.
// Path: __tests__ → (tabs) → app → package-root → src/

// ── Bottom inset ──────────────────────────────────────────────────────────────
jest.mock('../../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: jest.fn(() => ({ configured: true, isAuthed: true, userId: 'u1' })),
}));

// ── Messaging hooks ───────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useMessaging', () => ({
  useMyThreads: () => ({ data: [], loading: false, error: null, reload: jest.fn() }),
  useIncomingMessageRequests: () => ({
    data: [],
    loading: false,
    reload: jest.fn(),
    accept: jest.fn(),
    decline: jest.fn(),
  }),
  useUnreadCounts: () => ({ meetups: 0 }),
}));

// ── Block context + service ────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/BlockedIdsContext', () => ({
  useBlockedIds: () => ({ blockerIds: new Set() }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/blocks', () => ({
  getBlockList: jest.fn().mockResolvedValue({ ok: true, data: [] }),
  blockUser: jest.fn(),
}));

// ── Reports service ───────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/reports', () => ({
  reportContent: jest.fn(),
}));

// ── Highlight ring ────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightRing', () => ({
  HighlightRing: ({ children }: any) => children,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/HighlightViewer', () => ({
  HighlightViewer: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useHighlightRingState', () => ({
  useHighlightRingState: () => null,
}));

// ── Telegraph primitives ──────────────────────────────────────────────────────
jest.mock('../../../src/components/telegraph/TelegraphPrimitives', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    TelegraphAvatar: () => React.createElement(View, null),
    TelegraphRow: ({ children }: any) => React.createElement(View, null, children),
  };
});

// ── KeyboardSafeScrollView — transparent pass-through ────────────────────────
// TelegraphInboxScreen wraps its FlatList in KeyboardSafeScrollView.
// Rendering it as a plain View lets the tree-walker find the inner ScrollView
// (FlatList) without needing to handle the keyboard-avoidance native module.
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children, style }: any) =>
      React.createElement(View, { style }, children),
  };
});

// ── Compass (focus-event side-effect) ─────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/compass', () => ({
  postCompassFrontloadEvent: jest.fn().mockResolvedValue(undefined),
}));

// ── Display identity ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/lib/displayIdentity', () => ({
  primaryIdentityText: ({ handle }: any) => handle ?? 'Unknown',
  secondaryIdentityText: () => null,
}));

// ── Circle card preview ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/CircleStatusCardMessage.logic', () => ({
  circleCardInboxPreview: () => '',
}));

import Messages from '../messages.tsx';
import { useSession } from '../../../src/context/SessionContext.tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function findScrollViews(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const res: any[] = [];
  if (node.type === 'ScrollView' || node.type === 'RCTScrollView') res.push(node);
  for (const child of (node.children ?? [])) res.push(...findScrollViews(child));
  return res;
}

function subtreeHasText(node: any, text: string): boolean {
  if (typeof node === 'string') return node === text;
  if (!node || typeof node !== 'object') return false;
  return (node.children ?? []).some((c: any) => subtreeHasText(c, text));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockUseSession = useSession as jest.Mock;

describe('Messages / TelegraphInboxScreen — scroll architecture', () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({ configured: true, isAuthed: true, userId: 'u1' });
  });

  it('Telegraph brand title is inside the primary ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<Messages />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // The "Telegraph" brand text must appear within a ScrollView subtree.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Telegraph'));
    expect(titleInScroll).toBe(true);
  });

  it('root View has no non-overlay sibling above the scroll container', async () => {
    const { toJSON } = await render(<Messages />);
    await act(async () => {});

    const tree = toJSON() as any;

    // The outermost rendered node is KeyboardSafeScrollView (stubbed as View).
    // Walk its children looking for a non-absolute sibling before the FlatList.
    function checkNoHeaderSibling(node: any): void {
      if (!node || typeof node !== 'object') return;
      const children: any[] = Array.isArray(node.children) ? node.children : [];

      let foundScrollView = false;
      let nonOverlayBeforeScroll = false;

      for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        if (child.type === 'ScrollView' || child.type === 'RCTScrollView') {
          foundScrollView = true;
          break;
        }
        if (child.type === 'RCTModalHostView' || child.type === 'Modal') continue;
        const style = child?.props?.style ?? {};
        const flat = Array.isArray(style)
          ? Object.assign({}, ...style.map((s: any) => (s && typeof s === 'object' ? s : {})))
          : style;
        if (flat.position !== 'absolute') nonOverlayBeforeScroll = true;
      }

      if (foundScrollView) {
        // Found a scroll container — assert no header leaked above it.
        expect(nonOverlayBeforeScroll).toBe(false);
      } else {
        // Recurse into children to find the scroll container level.
        for (const child of children) checkNoHeaderSibling(child);
      }
    }

    checkNoHeaderSibling(tree);
  });

  it('unauthenticated: Telegraph brand title is inside the scroll subtree — not pinned above it', async () => {
    mockUseSession.mockReturnValue({ configured: true, isAuthed: false, userId: null });

    const { toJSON } = await render(<Messages />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // The "Telegraph" brand text must appear within a ScrollView subtree,
    // confirming the listHeader is still rendered as ListHeaderComponent
    // in the unauthenticated FlatList — not as an absolute-positioned sibling.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Telegraph'));
    expect(titleInScroll).toBe(true);
  });
});
