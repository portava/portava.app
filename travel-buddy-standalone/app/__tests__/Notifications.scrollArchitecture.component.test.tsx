/**
 * Notifications / ActivityCenter (app/notifications.tsx)
 * — scroll-architecture regression test.
 *
 * Confirms that after Task #1561, the shared header ("Activity Center" title
 * + horizontal tab bar) is rendered as FlatList's ListHeaderComponent —
 * NOT as a sibling View pinned above the scroll container.
 *
 * Strategy: render ActivityCenter in its default state (All tab, no loading),
 * walk the toJSON tree to find all ScrollView / FlatList nodes (jest-expo
 * renders FlatList as ScrollView), then verify that the "Activity Center"
 * title text lives within at least one of them. A third test walks the root
 * children to confirm there is no non-overlay View sibling above the scroll
 * container.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: src/ modules are two directories up from app/__tests__/.
// Path: __tests__ → app → package-root → src/

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// makeMutable() is called at module scope in useNavBarCollapse — not supported
// under Jest, so the entire module is replaced with lightweight stubs.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// ── usePosts — exports the focus-gate TTL constant ────────────────────────────
jest.mock('../../src/hooks/usePosts', () => ({
  FEED_FOCUS_TTL_MS: 0,
}));

// ── useNotifications ──────────────────────────────────────────────────────────
jest.mock('../../src/hooks/useNotifications', () => ({
  useNotifications: jest.fn(),
}));

// ── useRequests ───────────────────────────────────────────────────────────────
jest.mock('../../src/hooks/useRequests', () => ({
  useRequests: jest.fn(),
}));

// ── Request services ──────────────────────────────────────────────────────────
jest.mock('../../src/services/requests', () => ({
  acceptRequest:  jest.fn(),
  declineRequest: jest.fn(),
}));

// ── Interaction components ────────────────────────────────────────────────────
jest.mock('../../src/components/interaction/UserAvatarButton', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    UserAvatarButton: () => React.createElement(View, { testID: 'user-avatar-btn' }),
  };
});

jest.mock('../../src/components/interaction/UserNameButton', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    UserNameButton: ({ handle }: { handle?: string }) =>
      React.createElement(Text, null, handle ?? ''),
  };
});

// ── Display identity ──────────────────────────────────────────────────────────
jest.mock('../../src/lib/displayIdentity', () => ({
  secondaryIdentityText: () => null,
}));

// ── Typed mock setup ──────────────────────────────────────────────────────────

import { useNotifications } from '../../src/hooks/useNotifications.ts';
import { useRequests }      from '../../src/hooks/useRequests.ts';

const mockUseNotifications = useNotifications as jest.Mock;
const mockUseRequests       = useRequests       as jest.Mock;

beforeEach(() => {
  mockUseNotifications.mockReturnValue({
    notifications:  [],
    loading:        false,
    loadingMore:    false,
    unreadCount:    0,
    reload:         jest.fn(),
    loadMore:       jest.fn(),
    markRead:       jest.fn(),
    markAllRead:    jest.fn(),
    dismiss:        jest.fn(),
  });
  mockUseRequests.mockReturnValue({
    incoming: [],
    loading:  false,
    reload:   jest.fn(),
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

import ActivityCenter from '../notifications.tsx';

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

function subtreeHasType(node: any, type: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === type) return true;
  return (node.children ?? []).some((c: any) => subtreeHasType(c, type));
}

function isScrollNode(node: any): boolean {
  return node?.type === 'ScrollView' || node?.type === 'RCTScrollView';
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivityCenter (Notifications) — scroll architecture', () => {
  it('"Activity Center" header title is inside the primary ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<ActivityCenter />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // The "Activity Center" title must appear within a ScrollView subtree.
    const titleInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Activity Center'));
    expect(titleInScroll).toBe(true);
  });

  it('tab bar ("Plans" chip) is inside the ScrollView — not pinned above it', async () => {
    const { toJSON } = await render(<ActivityCenter />);
    await act(async () => {});

    const tree = toJSON() as any;
    const scrollViews = findScrollViews(tree);
    expect(scrollViews.length).toBeGreaterThan(0);

    // The "Plans" tab chip must appear within a ScrollView subtree.
    const plansInScroll = scrollViews.some((sv) => subtreeHasText(sv, 'Plans'));
    expect(plansInScroll).toBe(true);
  });

  it('root View has no non-overlay header sibling above the ScrollView', async () => {
    const { toJSON } = await render(<ActivityCenter />);
    await act(async () => {});

    const tree = toJSON() as any;
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];

    let foundScrollView = false;
    let nonOverlayBeforeScroll = false;

    for (const child of rootChildren) {
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

    expect(foundScrollView).toBe(true);
    expect(nonOverlayBeforeScroll).toBe(false);
  });

  it('loading branch — "Activity Center" header and spinner share the same non-scroll container', async () => {
    // Override the default mock: loading=true, notifications=[] triggers the
    // plain-View branch (lines ~278-284 of notifications.tsx), which wraps
    // sharedHeader + ActivityIndicator in a single <View style={{ flex: 1 }}>.
    mockUseNotifications.mockReturnValue({
      notifications:  [],
      loading:        true,
      loadingMore:    false,
      unreadCount:    0,
      reload:         jest.fn(),
      loadMore:       jest.fn(),
      markRead:       jest.fn(),
      markAllRead:    jest.fn(),
      dismiss:        jest.fn(),
    });

    const { toJSON } = await render(<ActivityCenter />);
    await act(async () => {});

    const tree = toJSON() as any;

    // The outer root View wraps everything; its first child in the loading
    // branch should be a plain View — not a FlatList / ScrollView.
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];
    const firstChild = rootChildren[0];

    expect(firstChild).toBeTruthy();
    // The container must not itself be a scroll node.
    expect(isScrollNode(firstChild)).toBe(false);

    // The "Activity Center" title must live somewhere inside this container.
    expect(subtreeHasText(firstChild, 'Activity Center')).toBe(true);

    // The ActivityIndicator (the loading spinner) must also live inside
    // this same container — confirming header + spinner are co-located.
    expect(subtreeHasType(firstChild, 'ActivityIndicator')).toBe(true);

    // Guard: there must be NO scroll node that sits between the root container
    // and the header title — i.e. the title is not tucked inside a nested
    // FlatList / ScrollView within the loading branch container.
    function titleCrossesScrollBoundary(node: any): boolean {
      // Returns true if "Activity Center" can only be reached by passing
      // through a scroll node descendant of `node`.
      if (typeof node === 'string') return false;
      if (!node || typeof node !== 'object') return false;
      for (const child of (node.children ?? [])) {
        if (isScrollNode(child)) {
          // If the title is only under this scroll child, it crossed a boundary.
          if (subtreeHasText(child, 'Activity Center') &&
              !(node.children ?? []).some(
                (c: any) => !isScrollNode(c) && subtreeHasText(c, 'Activity Center'),
              )) {
            return true;
          }
        }
        if (titleCrossesScrollBoundary(child)) return true;
      }
      return false;
    }

    expect(titleCrossesScrollBoundary(firstChild)).toBe(false);
  });

  it('Requests tab loading branch — "Activity Center" header and spinner share the same non-scroll container', async () => {
    // Set reqLoading=true so SocialRequestsPane renders its plain-View loading
    // branch (lines ~390-399 of notifications.tsx):
    //   <View style={{ flex: 1 }}>
    //     {headerComponent}
    //     <View style={styles.center}><ActivityIndicator /></View>
    //   </View>
    mockUseRequests.mockReturnValue({
      incoming: [],
      loading:  true,
      reload:   jest.fn(),
    });

    const { toJSON, getByText } = await render(<ActivityCenter />);
    await act(async () => {});

    // Switch to the Requests tab.
    await act(async () => {
      fireEvent.press(getByText('Requests'));
    });

    const tree = toJSON() as any;

    // The outer root View wraps everything; its first child in the Requests
    // loading branch should be a plain View — not a FlatList / ScrollView.
    const rootChildren: any[] = Array.isArray(tree?.children) ? tree.children : [];
    const firstChild = rootChildren[0];

    expect(firstChild).toBeTruthy();
    // The container must not itself be a scroll node.
    expect(isScrollNode(firstChild)).toBe(false);

    // The "Activity Center" title must live somewhere inside this container.
    expect(subtreeHasText(firstChild, 'Activity Center')).toBe(true);

    // The ActivityIndicator (the loading spinner) must also live inside
    // this same container — confirming header + spinner are co-located.
    expect(subtreeHasType(firstChild, 'ActivityIndicator')).toBe(true);

    // Guard: the title must not be hidden behind a scroll boundary inside
    // the loading container — i.e. not tucked inside a nested FlatList/ScrollView.
    function titleCrossesScrollBoundary(node: any): boolean {
      if (typeof node === 'string') return false;
      if (!node || typeof node !== 'object') return false;
      for (const child of (node.children ?? [])) {
        if (isScrollNode(child)) {
          if (
            subtreeHasText(child, 'Activity Center') &&
            !(node.children ?? []).some(
              (c: any) => !isScrollNode(c) && subtreeHasText(c, 'Activity Center'),
            )
          ) {
            return true;
          }
        }
        if (titleCrossesScrollBoundary(child)) return true;
      }
      return false;
    }

    expect(titleCrossesScrollBoundary(firstChild)).toBe(false);
  });
});
