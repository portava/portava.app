/**
 * Notifications (ActivityCenter) — header scroll-with-content tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * Task #1521 restructured the Notifications screen so the shared header
 * (title bar + horizontal tab bar) scrolls with content in BOTH tabs by
 * passing it as `ListHeaderComponent`.  The four scenarios below verify that
 * the header is rendered exactly once on the "All" tab and exactly once on
 * the "Requests" tab, including the two degenerate cases (empty list and
 * loading state) where the content path differs.
 *
 * ## Why these tests exist
 *
 * The "Requests" tab delegates rendering to `SocialRequestsPane`, which
 * receives the header as a prop and renders it in three different code paths:
 *   1. The loading spinner branch — headerComponent rendered inside a View.
 *   2. The empty-state branch — headerComponent rendered inside a View.
 *   3. The FlatList branch — headerComponent passed as ListHeaderComponent.
 *
 * A regression where any of these paths duplicates or drops the header is
 * silent (no crash), so these tests pin the expected count to exactly 1.
 *
 * ## Mock strategy
 *
 * Hooks and components that depend on native modules, Reanimated, or
 * Supabase are replaced with lightweight stubs.  The default mock returns
 * notifications=[] / loading=false so the "All" tab renders the empty-state
 * path; the specific tests that need non-empty data override the hook mock.
 */

import React from 'react';
import { render, waitFor, screen, fireEvent, act } from '@testing-library/react-native';
import ActivityCenter from '../notifications.tsx';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentional stub — not under test here.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — useNavBarCollapse calls makeMutable() at
// module scope (outside React), which is not supported under Jest.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => undefined,
  NavBarFiller: () => null,
}));

// NOTE: usePosts exports the TTL constant used by the focus-effect gate.
jest.mock('../../src/hooks/usePosts', () => ({
  FEED_FOCUS_TTL_MS: 0,
}));

// NOTE: intentionally exhaustive — useNotifications polls Supabase and SSE.
jest.mock('../../src/hooks/useNotifications', () => ({
  useNotifications: jest.fn(),
}));

// NOTE: intentionally exhaustive — useRequests fetches from the API server.
jest.mock('../../src/hooks/useRequests', () => ({
  useRequests: jest.fn(),
}));

// NOTE: acceptRequest / declineRequest hit the live API; not called by these
// tests but must be stubbed so the module resolves cleanly.
jest.mock('../../src/services/requests', () => ({
  acceptRequest:  jest.fn(),
  declineRequest: jest.fn(),
}));

// NOTE: intentionally exhaustive — UserAvatarButton uses an Image that
// requires native modules not available under Jest.
jest.mock('../../src/components/interaction/UserAvatarButton', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    UserAvatarButton: () => React.createElement(View, { testID: 'user-avatar-btn' }),
  };
});

// NOTE: intentionally exhaustive — UserNameButton uses Pressable + router.
jest.mock('../../src/components/interaction/UserNameButton', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    UserNameButton: ({ handle }: { handle?: string }) =>
      React.createElement(Text, null, handle ?? ''),
  };
});

// NOTE: displayIdentity may import native modules via the locale utils.
jest.mock('../../src/lib/displayIdentity', () => ({
  secondaryIdentityText: () => null,
}));

// ── Typed mock refs ────────────────────────────────────────────────────────────

import { useNotifications } from '../../src/hooks/useNotifications.ts';
import { useRequests }      from '../../src/hooks/useRequests.ts';
import type { InboxItem }   from '../../src/services/requests.ts';

const mockUseNotifications = useNotifications as jest.Mock;
const mockUseRequests       = useRequests       as jest.Mock;

// ── Default return values ──────────────────────────────────────────────────────

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

// ── Fixtures ───────────────────────────────────────────────────────────────────

import type { AppNotification } from '../../src/services/notifications.ts';

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

function makeRequest(id: string): InboxItem {
  return {
    id,
    type:       'friend_request',
    direction:  'incoming',
    status:     'pending',
    createdAt:  '2026-01-01T00:00:00Z',
    actor:      { id: `actor-${id}`, handle: `user_${id}`, name: `User ${id}`, avatarUrl: null },
    targetName: null,
  } as unknown as InboxItem;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockUseNotifications.mockReturnValue(defaultNotifReturn());
  mockUseRequests.mockReturnValue(defaultRequestReturn());
});

afterEach(async () => {
  jest.clearAllMocks();
  // Flush any pending React scheduler work so it cannot bleed into the next
  // test's render.  Without this, concurrent-mode work queued by tests 1-5
  // can cause test 6+'s render to produce an empty tree.
  await act(async () => {});
});

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('ActivityCenter — sharedHeader scroll-with-content', () => {
  it('renders the header exactly once on the All tab', async () => {
    await render(<ActivityCenter />);

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });
  });

  it('renders the header exactly once on the Requests tab when the list has items', async () => {
    mockUseRequests.mockReturnValue(
      defaultRequestReturn({ incoming: [makeRequest('r1'), makeRequest('r2')] }),
    );

    await render(<ActivityCenter />);

    // Switch to the Requests tab
    fireEvent.press(screen.getByText('Requests'));

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });
  });

  it('still shows the header exactly once on the Requests tab when the list is empty', async () => {
    mockUseRequests.mockReturnValue(
      defaultRequestReturn({ incoming: [] }),
    );

    await render(<ActivityCenter />);

    fireEvent.press(screen.getByText('Requests'));

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });

    // Empty-state copy confirms the right branch is rendered
    expect(screen.getByText('No pending requests')).toBeTruthy();
  });

  it('still shows the header exactly once on the Requests tab when loading', async () => {
    mockUseRequests.mockReturnValue(
      defaultRequestReturn({ incoming: [], loading: true }),
    );

    await render(<ActivityCenter />);

    fireEvent.press(screen.getByText('Requests'));

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });
  });

  it('never duplicates the header when switching All → Requests → All rapidly', async () => {
    mockUseRequests.mockReturnValue(
      defaultRequestReturn({ incoming: [makeRequest('r1')] }),
    );

    await render(<ActivityCenter />);

    // Rapid-tap: no interleaved awaits — all three presses fire synchronously.
    fireEvent.press(screen.getByText('Requests'));
    fireEvent.press(screen.getByText('All'));
    fireEvent.press(screen.getByText('Requests'));

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });

    // Switch back to All and confirm still exactly one header.
    fireEvent.press(screen.getByText('All'));

    await waitFor(() => {
      const titles = screen.getAllByText('Activity Center');
      expect(titles).toHaveLength(1);
    });
  });

  // NOTE: tab-switch tests for non-Requests tabs (loading-spinner branch and
  // FlatList-with-items branch) live in notifications.tabSwitch.component.test.tsx.
  // They need a fresh Jest worker to avoid concurrent-mode scheduler contamination
  // from the tests above, so they are deliberately isolated in their own file.
});
