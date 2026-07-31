/**
 * DiscoveryShareSheet — debounce-timer cleanup on close (multi-keystroke)
 *
 * Confirms that when `visible` flips from true→false while a 350ms debounce
 * timer is pending after rapid typing, the `useEffect` cleanup fires
 * clearTimeout before the timer expires so `searchUsers` is never called.
 *
 * Covers: multiple search changes (each restarts debounce) → immediate close.
 *
 * ## Two-file rule (TESTING.md Rule 6)
 * Separate file from DiscoveryShareSheet.debounceCleanup.component.test.tsx
 * to avoid shared actScopeDepth / screen state between tests.
 *
 * ## Approach
 * Real timers.  After closing the sheet we wait for the Modal proxy to
 * unmount the search input (effects flushed, clearTimeout called), then wait
 * 400ms to confirm the cancelled timer never fires.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet.tsx';

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

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps
// KeyboardAvoidingView which calls native layout APIs not available in jest.
jest.mock('../ui/KeyboardSafeView', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
  };
});

// NOTE: intentionally exhaustive — getMyThreads reaches the network.
jest.mock('../../services/messaging', () => ({
  getMyThreads: jest.fn().mockResolvedValue({ ok: true, data: { threads: [] } }),
  sendMessage: jest.fn(),
  openDirectThread: jest.fn(),
}));

// NOTE: searchUsers is the function under test.
const mockSearchUsers = jest.fn();
jest.mock('../../services/follows', () => ({
  searchUsers: (...args: unknown[]) => mockSearchUsers(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const ITEM: DiscoverySharePayload = {
  sourceId: 'src-1',
  sourceType: 'hidden_gem',
  title: 'Secret Cove',
  category: 'Nature',
  city: 'Split',
};

jest.setTimeout(20000);

// ── Test ──────────────────────────────────────────────────────────────────────

describe('DiscoveryShareSheet — debounce cleanup on close (multi-keystroke)', () => {
  it('cancels the last pending debounce timer when visible flips to false after rapid typing', async () => {
    mockSearchUsers.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();

    const { rerender, getByPlaceholderText, queryByPlaceholderText } = await render(
      <DiscoveryShareSheet visible item={ITEM} onClose={onClose} />,
    );

    await waitFor(() => getByPlaceholderText('Search chats or find someone…'));

    const input = getByPlaceholderText('Search chats or find someone…');

    // Rapid typing — each keystroke cancels the previous debounce and starts
    // a new 350ms timer.  Only the last timer is pending at close time.
    fireEvent.changeText(input, 'a');
    fireEvent.changeText(input, 'al');
    fireEvent.changeText(input, 'ali');

    // Close the sheet while the last timer is pending.
    rerender(<DiscoveryShareSheet visible={false} item={ITEM} onClose={onClose} />);

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
