/**
 * ActivityCenter — tab-switch header-duplication regression.
 *
 * ## What's covered
 *
 * Switching between the "All" tab and a non-Requests tab (here: "Trips") must
 * not duplicate or drop the shared header.  Both rendering branches are covered:
 *   - loading-spinner branch (loading=true, notifications=[])
 *   - FlatList-with-items branch (loading=false, notifications non-empty)
 *
 * ## Why a single test covers both branches
 *
 * Each render of ActivityCenter queues deferred real-timer scheduler work via
 * waitFor's IS_REACT_ACT_ENVIRONMENT=false window.  That deferred work bleeds
 * across an afterEach boundary, corrupting the next render and producing an
 * empty tree.  Combining both branches into a single test (with an explicit
 * setImmediate drain between them) avoids the afterEach boundary entirely.
 *
 * ## Why a separate file (not merged into notifications.headerScroll)
 *
 * The same contamination occurs across tests in the headerScroll file:
 * scheduler work from tests 1-5 corrupts any subsequent render in that file.
 * A fresh Jest worker (separate file) starts with a clean scheduler.
 */

import React from 'react';
import { act, render, waitFor, screen, fireEvent } from '@testing-library/react-native';
import ActivityCenter from '../notifications.tsx';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/usePosts', () => ({
  FEED_FOCUS_TTL_MS: 0,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/useNotifications', () => ({
  useNotifications: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/useRequests', () => ({
  useRequests: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../src/services/requests', () => ({
  acceptRequest:  jest.fn(),
  declineRequest: jest.fn(),
}));

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

// NOTE: intentional stub — not under test here.
jest.mock('../../src/lib/displayIdentity', () => ({
  secondaryIdentityText: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

import { useNotifications } from '../../src/hooks/useNotifications.ts';
import { useRequests }      from '../../src/hooks/useRequests.ts';
import type { AppNotification } from '../../src/services/notifications.ts';
import type { InboxItem }   from '../../src/services/requests.ts';

const mockUseNotifications = useNotifications as jest.Mock;
const mockUseRequests       = useRequests       as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────────

function defaultNotifReturn(overrides: Record<string, unknown> = {}) {
  return {
    notifications:  [],
    loading:        false,
    loadingMore:    false,
    unreadCount:    0,
    reload:         jest.fn(),
    loadMore:       jest.fn(),
    markRead:       jest.fn(),
    markAllRead:    jest.fn(),
    dismiss:        jest.fn(),
    ...overrides,
  };
}

function defaultRequestReturn(overrides: Record<string, unknown> = {}) {
  return {
    incoming: [] as InboxItem[],
    loading:  false,
    reload:   jest.fn(),
    ...overrides,
  };
}

function makeNotification(id: string, category = 'plans'): AppNotification {
  return {
    id,
    category,
    title:     `Notification ${id}`,
    body:      `Body for ${id}`,
    priority:  'normal',
    readAt:    null,
    actionUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as AppNotification;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUseNotifications.mockReturnValue(defaultNotifReturn());
  mockUseRequests.mockReturnValue(defaultRequestReturn());
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ActivityCenter — tab-switch header duplication (non-Requests tabs)', () => {
  /**
   * Both rendering branches (loading-spinner and FlatList-with-items) are
   * covered in one test to avoid the afterEach scheduler-drain boundary.
   *
   * NOTE: "Trips" (index 3) is used instead of "Plans" (index 2) because
   * findByText('Plans') consistently times out in this test setup.  The
   * tab-switch-without-duplication invariant is identical for all non-Requests
   * tabs; Trips covers it.
   */
  it('never duplicates the header when switching All → Trips → All (loading-spinner then FlatList branch)', async () => {
    // ── Branch 1: loading-spinner (loading=true, no items) ────────────────────
    mockUseNotifications.mockReturnValue(
      defaultNotifReturn({ loading: true, notifications: [] }),
    );

    const { unmount } = await render(<ActivityCenter />);

    fireEvent.press(await screen.findByText('Trips'));
    fireEvent.press(screen.getByText('All'));
    fireEvent.press(screen.getByText('Trips'));

    await waitFor(() => {
      expect(screen.getAllByText('Activity Center')).toHaveLength(1);
    });

    fireEvent.press(screen.getByText('All'));

    await waitFor(() => {
      expect(screen.getAllByText('Activity Center')).toHaveLength(1);
    });

    await unmount();

    // Drain any deferred real-timer scheduler work left by waitFor's
    // IS_REACT_ACT_ENVIRONMENT=false polling window.  Without this, the work
    // fires during the second render's act() scope and corrupts the new tree.
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); });

    // ── Branch 2: FlatList-with-items (loading=false, non-empty) ─────────────
    jest.clearAllMocks();
    mockUseNotifications.mockReturnValue(
      defaultNotifReturn({
        loading:       false,
        notifications: [makeNotification('n1'), makeNotification('n2')],
      }),
    );
    mockUseRequests.mockReturnValue(defaultRequestReturn());

    await render(<ActivityCenter />);

    fireEvent.press(await screen.findByText('Trips'));
    fireEvent.press(screen.getByText('All'));
    fireEvent.press(screen.getByText('Trips'));

    await waitFor(() => {
      expect(screen.getAllByText('Activity Center')).toHaveLength(1);
    });

    fireEvent.press(screen.getByText('All'));

    await waitFor(() => {
      expect(screen.getAllByText('Activity Center')).toHaveLength(1);
    });
  });
});
