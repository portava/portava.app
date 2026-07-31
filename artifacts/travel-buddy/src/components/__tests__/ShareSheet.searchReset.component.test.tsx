/**
 * ShareSheet — search-state reset on reopen (picker mode).
 *
 * Confirms that re-opening the sheet after a previous search in picker mode
 * clears the search input and hides any user results, so the user never sees
 * stale state from a prior session.
 *
 * Flow under test:
 *   open (menu) → "Send in a chat" (picker) → type query → close
 *   → reopen (menu) → "Send in a chat" (picker) → assert search is empty
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
 * getMyThreads, searchUsers, and getPostById are exhaustively mocked; they
 * pull in Supabase and native auth internals that are unsafe under jest.
 * react-native-safe-area-context has native internals that must be stubbed.
 * expo-clipboard and expo-router are exhaustively mocked — they require
 * native context not present in a unit-test environment.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';

// NOTE: intentionally exhaustive — messaging service imports Supabase/apiToken
// native deps; only getMyThreads/sendMessage/openDirectThread are exercised here.
jest.mock('../../services/messaging.ts', () => ({
  getMyThreads: jest.fn(async () => ({ ok: true, data: { threads: [] } })),
  sendMessage: jest.fn(async () => ({ ok: true })),
  openDirectThread: jest.fn(async () => ({ ok: true, data: { threadId: 't-1' } })),
}));

// NOTE: intentionally exhaustive — follows service imports Supabase/apiToken
// native deps; only searchUsers is exercised by this sheet.
jest.mock('../../services/follows.ts', () => ({
  searchUsers: jest.fn(async () => ({
    ok: true,
    data: [
      {
        id: 'u-bob',
        displayName: 'Bob Explorer',
        username: 'bobexplorer',
        avatarUrl: null,
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

async function renderSheet(visible: boolean, onClose = jest.fn()) {
  return render(
    <ShareSheet visible={visible} postId="post-test-1" onClose={onClose} />,
  );
}

/** Opens the picker mode by pressing "Send in a chat" and waits for the
 *  search input to become visible. */
async function openPicker() {
  const btn = await screen.findByText(SEND_IN_CHAT_LABEL);
  fireEvent.press(btn);
  return screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
}

// ── tests ─────────────────────────────────────────────────────────────────────

jest.setTimeout(20000);

describe('ShareSheet — search resets on reopen (picker mode)', () => {
  it('search input is empty when picker is re-entered after a previous search', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    // Enter picker mode.
    const searchInput = await openPicker();
    expect(searchInput.props.value).toBe('');

    // User types a search query.
    fireEvent.changeText(searchInput, 'bob');
    await waitFor(() =>
      expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe('bob'),
    );

    // Parent closes the sheet (visible → false).
    await rerender(
      <ShareSheet visible={false} postId="post-test-1" onClose={onClose} />,
    );

    // Parent re-opens the sheet (visible → true) — starts in menu mode.
    await rerender(
      <ShareSheet visible={true} postId="post-test-1" onClose={onClose} />,
    );

    // Re-enter picker mode.
    const searchInputAfterReopen = await openPicker();

    // Search input must be cleared — no stale query carried over.
    expect(searchInputAfterReopen.props.value).toBe('');
  });

  it('no user result rows are shown when picker re-opens after a search with results', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    // Enter picker mode.
    const searchInput = await openPicker();

    // Type a query and wait for the debounced user search to settle.
    fireEvent.changeText(searchInput, 'bob');
    await waitFor(
      () => expect(screen.queryByText('Bob Explorer')).not.toBeNull(),
      { timeout: 2000 },
    );

    // Close then reopen.
    await rerender(
      <ShareSheet visible={false} postId="post-test-1" onClose={onClose} />,
    );
    await rerender(
      <ShareSheet visible={true} postId="post-test-1" onClose={onClose} />,
    );

    // Re-enter picker mode.
    await openPicker();

    // Neither the previous query text nor the user result should appear.
    await waitFor(() => {
      expect(screen.queryByText('Bob Explorer')).toBeNull();
      // The "PEOPLE" divider only renders in search-active mode.
      expect(screen.queryByText('PEOPLE')).toBeNull();
    });
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe('');
  });

  it('multiple open/close cycles never accumulate stale search state', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    // Enter picker mode once before the loop.  Each iteration ends in picker
    // mode (after the openPicker() assertion), so the next iteration finds the
    // search input directly without pressing "Send in a chat" again.
    await openPicker();

    const queries = ['bob', 'carol', 'dave'];

    for (const q of queries) {
      // Sheet is already in picker mode at the top of each iteration.
      const searchInput = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);

      fireEvent.changeText(searchInput, q);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe(q),
      );

      // Close.
      await rerender(
        <ShareSheet visible={false} postId="post-test-1" onClose={onClose} />,
      );

      // Reopen — sheet returns to menu mode.
      await rerender(
        <ShareSheet visible={true} postId="post-test-1" onClose={onClose} />,
      );

      // Re-enter picker — search must be clean.
      const freshInput = await openPicker();
      expect(freshInput.props.value).toBe('');
      // No stale "No results for" banner.
      expect(screen.queryByText(`No results for "${q}".`)).toBeNull();
      // Sheet is now in picker mode — loop continues directly.
    }
  });
});
