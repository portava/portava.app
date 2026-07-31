/**
 * DiscoveryShareSheet — dual-section search results.
 *
 * Confirms that when a search query matches both existing threads and user
 * accounts, both sections are rendered together — thread rows appear first,
 * then a "PEOPLE" divider, then user result rows.  Neither section is hidden
 * when the other has results.  The "no results" empty state only fires when
 * both sections are simultaneously empty.
 *
 * Run with: pnpm test:component
 *
 * ## Act strategy
 *
 * fireEvent calls are bare (no act() wrapper).  Wrapping in await act() in
 * React 19 causes overlapping-act warnings.  Bare fireEvent + waitFor is
 * the canonical pattern for this test suite.
 *
 * ## Mock strategy
 *
 * getMyThreads returns a thread whose title matches the shared query so the
 * thread filter produces at least one hit.  searchUsers returns a user whose
 * displayName also matches, so the People section also has content.
 * KeyboardSafeScrollView is mocked because it wraps KeyboardAvoidingView
 * (a native-module-backed component).  expo-router is mocked because the
 * real module needs a navigation context that doesn't exist in tests.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet.tsx';

// NOTE: intentionally exhaustive — messaging service imports Supabase/apiToken
// native deps; only getMyThreads/sendMessage/openDirectThread are used here.
jest.mock('../../services/messaging.ts', () => ({
  getMyThreads: jest.fn(async () => ({
    ok: true,
    data: {
      threads: [
        {
          id: 'thread-alice',
          threadType: 'direct',
          tripId: null,
          circleOwnerId: null,
          title: 'Alice Chat',
          status: 'active',
          lastMessageAt: null,
          createdAt: '2024-01-01T00:00:00Z',
          mutedAt: null,
          archivedAt: null,
          otherMembers: [{ id: 'u-alice', handle: 'alicetravel', name: 'Alice Chat', avatarUrl: null }],
          lastMessagePreview: null,
        },
      ],
    },
  })),
  sendMessage: jest.fn(async () => ({ ok: true })),
  openDirectThread: jest.fn(async () => ({ ok: true, data: { threadId: 't-1' } })),
}));

// NOTE: intentionally exhaustive — follows service imports Supabase/apiToken
// native deps; only searchUsers is used by this sheet.
jest.mock('../../services/follows.ts', () => ({
  searchUsers: jest.fn(async () => ({
    ok: true,
    data: [
      {
        id: 'u-alice-user',
        displayName: 'Alice Explorer',
        username: 'aliceexplorer',
        avatarUrl: null,
        followerCount: 5,
        isFollowing: false,
        isPrivate: false,
      },
    ],
  })),
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps
// KeyboardAvoidingView which hits native modules not available under jest.
jest.mock('../ui/KeyboardSafeView.tsx', () => ({
  KeyboardSafeScrollView: ({ children, style }: any) => {
    const { View } = require('react-native');
    return <View style={style}>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — expo-router requires a navigation
// provider that does not exist in a unit-test environment.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// ── fixture ───────────────────────────────────────────────────────────────────

const item: DiscoverySharePayload = {
  sourceId: 'src-1',
  sourceType: 'place',
  title: 'The Rooftop Bar',
  category: 'Bar',
  city: 'Lisbon',
};

const SEARCH_PLACEHOLDER = 'Search chats or find someone…';

// ── tests ─────────────────────────────────────────────────────────────────────

jest.setTimeout(20000);

describe('DiscoveryShareSheet — dual-section search results', () => {
  it('shows thread rows AND user rows when the query matches both', async () => {
    await render(
      <DiscoveryShareSheet visible={true} item={item} onClose={jest.fn()} />,
    );

    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);

    // Type a query that matches both the thread title ("Alice Chat") and
    // the user result ("Alice Explorer").
    fireEvent.changeText(searchInput, 'alice');

    // Thread row — title contains "alice" (matched by the local filter).
    await waitFor(
      () => expect(screen.queryByText('Alice Chat')).not.toBeNull(),
      { timeout: 3000 },
    );

    // User row — displayName returned by searchUsers mock.
    await waitFor(
      () => expect(screen.queryByText('Alice Explorer')).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  it('renders the PEOPLE divider when the query matches both sections', async () => {
    await render(
      <DiscoveryShareSheet visible={true} item={item} onClose={jest.fn()} />,
    );

    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.changeText(searchInput, 'alice');

    await waitFor(
      () => expect(screen.queryByText('PEOPLE')).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  it('does not show the no-results empty state when both sections have content', async () => {
    await render(
      <DiscoveryShareSheet visible={true} item={item} onClose={jest.fn()} />,
    );

    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.changeText(searchInput, 'alice');

    // Wait for results to settle so the search is not still in-flight.
    await waitFor(
      () => expect(screen.queryByText('Alice Explorer')).not.toBeNull(),
      { timeout: 3000 },
    );

    // The combined no-results label must not be visible.
    expect(screen.queryByText(/No results for/)).toBeNull();
  });

  it('shows the no-results empty state only when both sections are empty', async () => {
    const messagingMock = jest.requireMock('../../services/messaging.ts');
    const followsMock = jest.requireMock('../../services/follows.ts');

    // Override so both sections return empty for this render only.
    messagingMock.getMyThreads.mockResolvedValueOnce({ ok: true, data: { threads: [] } });
    followsMock.searchUsers.mockResolvedValueOnce({ ok: true, data: [] });

    await render(
      <DiscoveryShareSheet visible={true} item={item} onClose={jest.fn()} />,
    );

    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    fireEvent.changeText(searchInput, 'zzznomatch');

    await waitFor(
      () => expect(screen.queryByText(/No results for/)).not.toBeNull(),
      { timeout: 3000 },
    );
  });
});
