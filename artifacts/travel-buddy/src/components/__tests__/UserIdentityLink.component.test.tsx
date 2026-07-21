/**
 * Component tests for UserIdentityLink — universal tappable user identity wrapper.
 *
 * Invariant: every rendered user identity surface must be tappable to open
 * that user's profile. These tests verify:
 *   • Other-user tap → routes to /u/${handle}
 *   • Own-identity tap → routes to /(tabs)/passport (not public-profile route)
 *   • Null/undefined handle → no crash, no navigation
 *   • Blocked user → navigation suppressed
 *   • Nested action buttons stop propagation (Follow, Like, Menu)
 *   • Deleted/unavailable account → renders gracefully, no crash
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { Text, Pressable } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

// ── Router mock ───────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock is hoisted before variable declarations, so the factory
// must use jest.fn() inline (not reference a module-level variable).

// NOTE: intentionally exhaustive — expo-router's `router` object provides only
// the navigation methods this component uses (push). Spreading requireActual
// would pull in native modules that crash the JS-only renderer.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

// Access the mocked push via the module import (which is the mocked version).
import { router } from 'expo-router';

// ── BlockedIdsContext mock ────────────────────────────────────────────────────

let mockBlockedIds = new Set<string>();
let mockBlockerIds = new Set<string>();

// NOTE: intentionally exhaustive — BlockedIdsContext is a React context module
// whose real implementation calls Supabase on mount. Spreading requireActual
// would trigger network calls and require a full auth setup in every test.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({
  useBlockedIds: () => ({
    blockedIds: mockBlockedIds,
    blockerIds: mockBlockerIds,
    isLoading: false,
    addBlock: jest.fn(),
    removeBlock: jest.fn(),
    refresh: jest.fn(),
  }),
}));

// ── Component under test ──────────────────────────────────────────────────────

import { UserIdentityLink } from '../interaction/UserIdentityLink.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedIds = new Set();
  mockBlockerIds = new Set();
});

describe('UserIdentityLink — routing', () => {
  test('tapping another user routes to /u/${handle}', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle="alice" currentUserId="me-999" testID="link">
        <Text>Alice</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).toHaveBeenCalledWith('/u/alice');
  });

  test('tapping own identity routes to passport tab, not public profile', async () => {
    await render(
      <UserIdentityLink userId="me-999" handle="myhandle" currentUserId="me-999" testID="link">
        <Text>Me</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
    expect(router.push).not.toHaveBeenCalledWith('/u/myhandle');
  });

  test('tapping without currentUserId falls through to public profile', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle="bob" testID="link">
        <Text>Bob</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).toHaveBeenCalledWith('/u/bob');
  });
});

describe('UserIdentityLink — no-op cases', () => {
  test('null handle → no navigation, no crash', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle={null} testID="link">
        <Text>No handle</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).not.toHaveBeenCalled();
  });

  test('undefined handle → no navigation, no crash', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle={undefined} testID="link">
        <Text>No handle</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).not.toHaveBeenCalled();
  });

  test('disabled prop → no navigation', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle="charlie" disabled testID="link">
        <Text>Charlie</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('UserIdentityLink — block suppression', () => {
  test('blocked user (viewer blocked them) → no navigation', async () => {
    mockBlockedIds = new Set(['user-blocked']);
    await render(
      <UserIdentityLink userId="user-blocked" handle="blocked" testID="link">
        <Text>Blocked</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).not.toHaveBeenCalled();
  });

  test('blocker (they blocked viewer) → no navigation', async () => {
    mockBlockerIds = new Set(['user-blocker']);
    await render(
      <UserIdentityLink userId="user-blocker" handle="blocker" testID="link">
        <Text>Blocker</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('link'));
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('UserIdentityLink — nested action propagation', () => {
  test('nested Follow button fires follow action, does NOT trigger profile navigation', async () => {
    const onFollow = jest.fn();
    await render(
      <UserIdentityLink userId="user-123" handle="dave" testID="identity">
        <Text>Dave</Text>
        <Pressable
          testID="follow-btn"
          onPress={(e) => { e.stopPropagation(); onFollow(); }}
        >
          <Text>Follow</Text>
        </Pressable>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('follow-btn'));
    expect(onFollow).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  test('nested Like button fires like action, does NOT trigger profile navigation', async () => {
    const onLike = jest.fn();
    await render(
      <UserIdentityLink userId="user-123" handle="eve" testID="identity">
        <Text>Eve</Text>
        <Pressable
          testID="like-btn"
          onPress={(e) => { e.stopPropagation(); onLike(); }}
        >
          <Text>Like</Text>
        </Pressable>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('like-btn'));
    expect(onLike).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  test('nested Menu button opens menu, does NOT trigger profile navigation', async () => {
    const onMenu = jest.fn();
    await render(
      <UserIdentityLink userId="user-123" handle="frank" testID="identity">
        <Text>Frank</Text>
        <Pressable
          testID="menu-btn"
          onPress={(e) => { e.stopPropagation(); onMenu(); }}
        >
          <Text>Menu</Text>
        </Pressable>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('menu-btn'));
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  test('tapping the identity area directly still navigates to profile', async () => {
    await render(
      <UserIdentityLink userId="user-123" handle="grace" testID="identity">
        <Text testID="name-text">Grace</Text>
        <Pressable
          testID="follow-btn"
          onPress={(e) => { e.stopPropagation(); }}
        >
          <Text>Follow</Text>
        </Pressable>
      </UserIdentityLink>,
    );
    // Press on the identity link itself (not a child button)
    fireEvent.press(screen.getByTestId('identity'));
    expect(router.push).toHaveBeenCalledWith('/u/grace');
  });
});

describe('UserIdentityLink — deleted/unavailable account', () => {
  test('renders children without crash when handle is empty string', async () => {
    await render(
      <UserIdentityLink userId="user-deleted" handle="" testID="link">
        <Text>Deleted user</Text>
      </UserIdentityLink>,
    );
    expect(screen.getByText('Deleted user')).toBeTruthy();
    // Empty string handle → no navigation (falsy), no crash
  });

  test('renders children without crash when userId is empty string', async () => {
    await render(
      <UserIdentityLink userId="" handle="ghosthandle" testID="link">
        <Text>Ghost</Text>
      </UserIdentityLink>,
    );
    expect(screen.getByText('Ghost')).toBeTruthy();
  });
});

describe('UserIdentityLink — surface coverage (routing contract)', () => {
  // These tests verify the routing contract for various app surfaces.
  // They use UserIdentityLink directly as the canonical implementation.

  async function renderAndTap(handle: string, userId = 'other-user', currentUserId = 'viewer') {
    await render(
      <UserIdentityLink userId={userId} handle={handle} currentUserId={currentUserId} testID="id-link">
        <Text>{handle}</Text>
      </UserIdentityLink>,
    );
    fireEvent.press(screen.getByTestId('id-link'));
  }

  test('Discovery card identity → /u/${handle}', async () => {
    await renderAndTap('alice_traveler');
    expect(router.push).toHaveBeenCalledWith('/u/alice_traveler');
  });

  test('Pulse card identity → /u/${handle}', async () => {
    await renderAndTap('bob_explorer');
    expect(router.push).toHaveBeenCalledWith('/u/bob_explorer');
  });

  test('post authorship identity → /u/${handle}', async () => {
    await renderAndTap('carol_posts');
    expect(router.push).toHaveBeenCalledWith('/u/carol_posts');
  });

  test('comment authorship identity → /u/${handle}', async () => {
    await renderAndTap('dave_commenter');
    expect(router.push).toHaveBeenCalledWith('/u/dave_commenter');
  });

  test('follower-list row identity → /u/${handle}', async () => {
    await renderAndTap('eve_follower');
    expect(router.push).toHaveBeenCalledWith('/u/eve_follower');
  });

  test('following-list row identity → /u/${handle}', async () => {
    await renderAndTap('frank_following');
    expect(router.push).toHaveBeenCalledWith('/u/frank_following');
  });

  test('Telegraph chat-header identity → /u/${handle}', async () => {
    await renderAndTap('grace_chat');
    expect(router.push).toHaveBeenCalledWith('/u/grace_chat');
  });

  test('Telegraph message-sender avatar → /u/${handle}', async () => {
    await renderAndTap('hank_sender');
    expect(router.push).toHaveBeenCalledWith('/u/hank_sender');
  });

  test('group-member row identity → /u/${handle}', async () => {
    await renderAndTap('ivan_member');
    expect(router.push).toHaveBeenCalledWith('/u/ivan_member');
  });

  test('Trip Crew member card identity → /u/${handle}', async () => {
    await renderAndTap('judy_crew');
    expect(router.push).toHaveBeenCalledWith('/u/judy_crew');
  });

  test('event-attendee row identity → /u/${handle}', async () => {
    await renderAndTap('ken_attendee');
    expect(router.push).toHaveBeenCalledWith('/u/ken_attendee');
  });

  test('Rent a Buddy listing identity → /u/${handle}', async () => {
    await renderAndTap('lisa_buddy');
    expect(router.push).toHaveBeenCalledWith('/u/lisa_buddy');
  });

  test('reviewer identity on a review → /u/${handle}', async () => {
    await renderAndTap('mike_reviewer');
    expect(router.push).toHaveBeenCalledWith('/u/mike_reviewer');
  });

  test('search-result user row → /u/${handle}', async () => {
    await renderAndTap('nancy_search');
    expect(router.push).toHaveBeenCalledWith('/u/nancy_search');
  });

  test('notification referring to a user → /u/${handle}', async () => {
    await renderAndTap('oscar_notif');
    expect(router.push).toHaveBeenCalledWith('/u/oscar_notif');
  });

  test('current user own identity → /(tabs)/passport', async () => {
    await renderAndTap('self_handle', 'viewer', 'viewer');
    expect(router.push).toHaveBeenCalledWith('/(tabs)/passport');
    expect(router.push).not.toHaveBeenCalledWith('/u/self_handle');
  });
});
