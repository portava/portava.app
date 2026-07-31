/**
 * ShareSheet — debounce-timer cleanup on close (single keystroke)
 *
 * Confirms that when `visible` flips from true→false while a 350ms debounce
 * timer is pending, the `useEffect` cleanup fires clearTimeout before the
 * timer expires so `searchUsers` is never called after close.
 *
 * Covers: one search change → immediate close.
 *
 * ## Two-file rule (TESTING.md Rule 6)
 * Modal-component tests that do async operations must live in separate files
 * to avoid shared actScopeDepth / screen state between tests.
 * Multi-keystroke scenario: ShareSheet.debounceCleanupMulti.component.test.tsx
 *
 * ## Approach
 * Real timers.  After closing the sheet we wait for the Modal proxy to
 * unmount the search input (effects flushed, clearTimeout called), then wait
 * 400ms to confirm the cancelled timer never fires.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ShareSheet } from '../ShareSheet.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — Modal's animation lifecycle corrupts
// actScopeDepth; Proxy replaces only 'Modal', everything else falls through.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children: R.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentionally exhaustive — useSafeAreaInsets requires native
// SafeAreaManager unavailable in jest-expo.
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  const React = require('react');
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// NOTE: intentionally exhaustive — getMyThreads reaches the network.
jest.mock('../../services/messaging', () => ({
  getMyThreads: jest.fn().mockResolvedValue({ ok: true, data: { threads: [] } }),
  sendMessage: jest.fn(),
  openDirectThread: jest.fn(),
}));

// NOTE: intentionally exhaustive — getPostById reaches the network.
jest.mock('../../services/posts', () => ({
  getPostById: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      author: { name: 'Alice', handle: 'alice', avatarUrl: null },
      content: 'A test post',
      mediaUrls: [],
      mediaThumbnailUrl: null,
      locationCity: 'Lisbon',
      locationCountry: 'Portugal',
      likeCount: 0,
      commentCount: 0,
    },
  }),
}));

// NOTE: searchUsers is the function under test.
const mockSearchUsers = jest.fn();
jest.mock('../../services/follows', () => ({
  searchUsers: (...args: unknown[]) => mockSearchUsers(...args),
}));

// NOTE: intentionally exhaustive — expo-clipboard requires native modules.
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

jest.setTimeout(20000);

// ── Test ──────────────────────────────────────────────────────────────────────

describe('ShareSheet — debounce cleanup on close', () => {
  it('cancels the pending debounce timer when visible flips to false — searchUsers is never called', async () => {
    mockSearchUsers.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();

    const { rerender, getByText, getByPlaceholderText, queryByPlaceholderText } = await render(
      <ShareSheet visible postId="post-1" onClose={onClose} />,
    );

    // Navigate to picker mode.
    await waitFor(() => getByText('Send in a chat'));
    fireEvent.press(getByText('Send in a chat'));

    // Wait for the picker search input.
    await waitFor(() => getByPlaceholderText('Search chats or find someone…'));

    // Trigger a debounced search — starts the 350ms timer.
    fireEvent.changeText(
      getByPlaceholderText('Search chats or find someone…'),
      'bob',
    );

    // Close the sheet before the timer fires.
    rerender(<ShareSheet visible={false} postId="post-1" onClose={onClose} />);

    // Wait for the sheet to close — confirms React committed the re-render and
    // flushed the useEffect cleanup (clearTimeout).
    await waitFor(() =>
      expect(queryByPlaceholderText('Search chats or find someone…')).toBeNull(),
    );

    // Wait past the 350ms debounce threshold to confirm the timer was cancelled.
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    expect(mockSearchUsers).not.toHaveBeenCalled();
  });
});
