/**
 * ShareSheet — dual-section search results (picker mode).
 *
 * Confirms that when a search query matches both existing threads and user
 * accounts, both sections are rendered together inside the picker — thread
 * rows appear first, then a "PEOPLE" divider, then user result rows.
 * Neither section is hidden when the other has results.  The "no results"
 * empty state only fires when both sections are simultaneously empty.
 *
 * Flow under test:
 *   open (menu) → "Send in a chat" (picker) → type shared query
 *   → assert threads + PEOPLE divider + user rows all visible
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
 * getMyThreads returns a thread whose otherMembers.name matches the query so
 * the local thread filter produces a hit.  searchUsers returns a user whose
 * displayName also matches, giving the People section content too.
 * getPostById is mocked to avoid Supabase/apiToken native deps.
 * react-native-safe-area-context, expo-clipboard, and expo-router are all
 * mocked because they require native context not present in a unit-test env.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';

// NOTE: intentionally exhaustive — messaging service imports Supabase/apiToken
// native deps; only getMyThreads/sendMessage/openDirectThread are used here.
jest.mock('../../services/messaging.ts', () => ({
  getMyThreads: jest.fn(async () => ({
    ok: true,
    data: {
      threads: [
        {
          id: 'thread-bob',
          threadType: 'direct',
          tripId: null,
          circleOwnerId: null,
          title: null,
          status: 'active',
          lastMessageAt: null,
          createdAt: '2024-01-01T00:00:00Z',
          mutedAt: null,
          archivedAt: null,
          otherMembers: [{ id: 'u-bob', handle: 'bobexplorer', name: 'Bob Explorer', avatarUrl: null }],
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
        id: 'u-bob-user',
        displayName: 'Bob Traveler',
        username: 'bobtraveler',
        avatarUrl: null,
        followerCount: 3,
        isFollowing: false,
        isPrivate: false,
      },
    ],
  })),
}));

// NOTE: intentionally exhaustive — posts service imports Supabase/apiToken
// native deps; getPostById is only used for the lightweight preview card.
jest.mock('../../services/posts.ts', () => ({
  getPostById: jest.fn(async () => ({
    ok: true,
    data: {
      author: { name: 'Test Author', handle: 'testauthor', avatarUrl: null },
      content: 'A great travel post',
      mediaUrls: [],
      mediaThumbnailUrl: null,
      locationCity: 'Paris',
      locationCountry: 'France',
      likeCount: 10,
      commentCount: 3,
    },
  })),
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context has native
// module internals that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
}));

// NOTE: intentionally exhaustive — expo-clipboard requires a native module
// not present in a unit-test environment.
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => {}),
}));

// NOTE: intentionally exhaustive — expo-router requires a navigation
// provider that does not exist in a unit-test environment.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// ── constants ─────────────────────────────────────────────────────────────────

const SEARCH_PLACEHOLDER = 'Search chats or find someone…';
const SEND_IN_CHAT_LABEL = 'Send in a chat';

// ── helpers ───────────────────────────────────────────────────────────────────

async function renderSheet(onClose = jest.fn()) {
  return render(
    <ShareSheet visible={true} postId="post-test-1" onClose={onClose} />,
  );
}

/** Opens picker mode and returns the search input element. */
async function openPicker() {
  const btn = await screen.findByText(SEND_IN_CHAT_LABEL);
  fireEvent.press(btn);
  return screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
}

// ── tests ─────────────────────────────────────────────────────────────────────

jest.setTimeout(20000);

describe('ShareSheet — dual-section search results (picker mode)', () => {
  it('shows thread rows AND user rows when the query matches both', async () => {
    await renderSheet();

    const searchInput = await openPicker();

    // Type a query that matches both the thread member name ("Bob Explorer")
    // and the user result ("Bob Traveler").
    fireEvent.changeText(searchInput, 'bob');

    // Thread row — otherMembers[0].name contains "bob" (local filter hit).
    await waitFor(
      () => expect(screen.queryByText('Bob Explorer')).not.toBeNull(),
      { timeout: 3000 },
    );

    // User row — displayName returned by searchUsers mock.
    await waitFor(
      () => expect(screen.queryByText('Bob Traveler')).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  it('renders the PEOPLE divider when the query matches both sections', async () => {
    await renderSheet();

    const searchInput = await openPicker();
    fireEvent.changeText(searchInput, 'bob');

    await waitFor(
      () => expect(screen.queryByText('PEOPLE')).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  it('does not show the no-results empty state when both sections have content', async () => {
    await renderSheet();

    const searchInput = await openPicker();
    fireEvent.changeText(searchInput, 'bob');

    // Wait for results to settle so the search is not still in-flight.
    await waitFor(
      () => expect(screen.queryByText('Bob Traveler')).not.toBeNull(),
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

    await renderSheet();

    const searchInput = await openPicker();
    fireEvent.changeText(searchInput, 'zzznomatch');

    await waitFor(
      () => expect(screen.queryByText(/No results for/)).not.toBeNull(),
      { timeout: 3000 },
    );
  });
});
