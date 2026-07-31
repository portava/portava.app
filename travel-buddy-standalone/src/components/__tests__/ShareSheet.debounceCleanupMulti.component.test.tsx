/**
 * ShareSheet — debounce-timer cleanup on close (multi-keystroke)
 *
 * Confirms that when `visible` flips from true→false while a 350ms debounce
 * timer is pending after rapid typing, the `useEffect` cleanup fires
 * clearTimeout before the timer expires so `searchUsers` is never called.
 *
 * Covers: multiple search changes (each restarts debounce) → immediate close.
 *
 * ## Two-file rule (TESTING.md Rule 6)
 * Separate file from ShareSheet.debounceCleanup.component.test.tsx to avoid
 * shared actScopeDepth / screen state between tests.
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

describe('ShareSheet — debounce cleanup on close (multi-keystroke)', () => {
  it('cancels the last pending debounce timer when visible flips to false after rapid typing', async () => {
    mockSearchUsers.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();

    const { rerender, getByText, getByPlaceholderText, queryByPlaceholderText } = await render(
      <ShareSheet visible postId="post-1" onClose={onClose} />,
    );

    // Navigate to picker mode.
    await waitFor(() => getByText('Send in a chat'));
    fireEvent.press(getByText('Send in a chat'));

    await waitFor(() => getByPlaceholderText('Search chats or find someone…'));

    const input = getByPlaceholderText('Search chats or find someone…');

    // Rapid typing — each keystroke cancels the previous debounce and starts
    // a new 350ms timer.  Only the last timer is pending at close time.
    fireEvent.changeText(input, 'b');
    fireEvent.changeText(input, 'bo');
    fireEvent.changeText(input, 'bob');

    // Close the sheet while the last timer is pending.
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
