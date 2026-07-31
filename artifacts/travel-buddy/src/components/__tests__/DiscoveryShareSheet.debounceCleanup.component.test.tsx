/**
 * DiscoveryShareSheet — debounce-timer cleanup on close (single keystroke)
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
 * Multi-keystroke scenario: DiscoveryShareSheet.debounceCleanupMulti.component.test.tsx
 *
 * ## Approach
 * Real timers.  After closing the sheet we wait for the Modal proxy to
 * unmount the search input (effects flushed, clearTimeout called), then wait
 * 400ms to confirm the cancelled timer never fires.
 *
 * ## Modal mock (Rule 6, TESTING.md)
 * The Proxy replaces only 'Modal' with a synchronous View; all other
 * react-native exports fall through untouched via Reflect.get.
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

describe('DiscoveryShareSheet — debounce cleanup on close', () => {
  it('cancels the pending debounce timer when visible flips to false — searchUsers is never called', async () => {
    mockSearchUsers.mockReturnValue(new Promise(() => {}));
    const onClose = jest.fn();

    const { rerender, getByPlaceholderText, queryByPlaceholderText } = await render(
      <DiscoveryShareSheet visible item={ITEM} onClose={onClose} />,
    );

    // Wait for the search input to appear.
    await waitFor(() => getByPlaceholderText('Search chats or find someone…'));

    // Trigger a debounced search — starts the 350ms timer.
    fireEvent.changeText(
      getByPlaceholderText('Search chats or find someone…'),
      'alice',
    );

    // Close the sheet before the timer fires.
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
