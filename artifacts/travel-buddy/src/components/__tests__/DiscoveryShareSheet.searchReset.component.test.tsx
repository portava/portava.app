/**
 * DiscoveryShareSheet — search-state reset on reopen.
 *
 * Confirms that re-opening the sheet after a previous search clears the
 * search input and hides any user results, so the user never sees stale
 * state from a prior session.
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
 * getMyThreads and searchUsers are exhaustively mocked; they pull in
 * Supabase and native auth internals that are unsafe under jest.
 * KeyboardSafeScrollView is exhaustively mocked because it wraps
 * KeyboardAvoidingView, a native-module-backed component.
 * expo-router is exhaustively mocked — the real module needs a navigation
 * context that doesn't exist in a unit-test environment.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet.tsx';

// NOTE: intentionally exhaustive — messaging service imports Supabase/apiToken
// native deps; only getMyThreads is exercised by this sheet.
jest.mock('../../services/messaging.ts', () => ({
  getMyThreads: jest.fn(async () => ({ ok: true, data: { threads: [] } })),
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
        id: 'u-alice',
        displayName: 'Alice Travel',
        username: 'alicetravel',
        avatarUrl: null,
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

// ── helpers ───────────────────────────────────────────────────────────────────

async function renderSheet(visible: boolean, onClose = jest.fn()) {
  return render(
    <DiscoveryShareSheet visible={visible} item={item} onClose={onClose} />,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

jest.setTimeout(20000);

describe('DiscoveryShareSheet — search resets on reopen', () => {
  it('search input is empty when sheet re-opens after a previous search', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    // Find the search input while the sheet is open.
    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
    expect(searchInput.props.value).toBe('');

    // User types a search query.
    fireEvent.changeText(searchInput, 'alice');
    await waitFor(() =>
      expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe('alice'),
    );

    // Parent closes the sheet (visible → false).
    await rerender(
      <DiscoveryShareSheet visible={false} item={item} onClose={onClose} />,
    );

    // Parent re-opens the sheet (visible → true).
    await rerender(
      <DiscoveryShareSheet visible={true} item={item} onClose={onClose} />,
    );

    // Search input must be cleared — no stale query carried over.
    const inputAfterReopen = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
    expect(inputAfterReopen.props.value).toBe('');
  });

  it('no user result rows are shown when sheet re-opens after a search with results', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);

    // Type a query and advance the debounce so searchUsers resolves.
    fireEvent.changeText(searchInput, 'alice');

    // Wait for the debounced user search to settle (350ms timeout in component).
    await waitFor(
      () => expect(screen.queryByText('Alice Travel')).not.toBeNull(),
      { timeout: 2000 },
    );

    // Close then reopen.
    await rerender(
      <DiscoveryShareSheet visible={false} item={item} onClose={onClose} />,
    );
    await rerender(
      <DiscoveryShareSheet visible={true} item={item} onClose={onClose} />,
    );

    // Neither the previous query text nor the user result should appear.
    await waitFor(() => {
      expect(screen.queryByText('Alice Travel')).toBeNull();
      // The "PEOPLE" divider only renders in search-active mode.
      expect(screen.queryByText('PEOPLE')).toBeNull();
    });
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe('');
  });

  it('multiple open/close cycles never accumulate stale search state', async () => {
    const onClose = jest.fn();
    const { rerender } = await renderSheet(true, onClose);

    const queries = ['alice', 'bob', 'carol'];

    for (const q of queries) {
      const searchInput = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);

      fireEvent.changeText(searchInput, q);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe(q),
      );

      // Close.
      await rerender(
        <DiscoveryShareSheet visible={false} item={item} onClose={onClose} />,
      );

      // Reopen.
      await rerender(
        <DiscoveryShareSheet visible={true} item={item} onClose={onClose} />,
      );

      // Must be clean.
      expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER).props.value).toBe('');
      // Search-active state cleared — no stale "No results for" text.
      expect(screen.queryByText(`No results for "${q}".`)).toBeNull();
    }
  });
});
