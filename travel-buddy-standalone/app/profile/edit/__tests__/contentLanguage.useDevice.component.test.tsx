/**
 * ContentLanguageScreen — "Use device language" null-code path.
 *
 * ## What's covered
 *
 * Tapping "Use device language" calls updateLanguage(null) — not undefined,
 * not an empty string — ensuring the API clears the preferred_language column.
 *
 * Only ONE it() uses fireEvent.press because the screen hosts a FlatList and
 * VirtualizedList leaves internal state after any fireEvent.press that zeroes
 * items in subsequent renders (see flatlist-test-contamination.md).
 *
 * Sibling file contentLanguage.nullFilter.component.test.tsx covers the feed
 * translation pipeline behaviour via renderHook (fresh renderer, no FlatList).
 *
 * ## Why this test exists
 *
 * The "Use device language" row sends null to updateLanguage. If this path
 * silently sent undefined, the wrong value, or was short-circuited, users
 * who cleared their preference would keep seeing stale "See translation"
 * toggles in the feed.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import {
  render,
  act,
  waitFor,
  fireEvent,
  cleanup,
  screen,
} from '@testing-library/react-native';

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useNavigation: () => ({ addListener: jest.fn(() => jest.fn()) }),
}));

// ── react-native-safe-area-context ────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── KeyboardSafeView — not under test ────────────────────────────────────────

// NOTE: intentionally exhaustive — KeyboardSafeView imports native keyboard
// modules not available in jest-expo JSDOM; both exports are plain View wrappers.
jest.mock('../../../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
  };
});

// ── useBottomInset — not under test ──────────────────────────────────────────

// NOTE: intentionally exhaustive — useBottomInset imports native inset hooks
// unavailable in jest-expo JSDOM; only PlainBottomFiller is used by SettingsUI.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

// ── LanguagePreferenceContext — controlled per test ───────────────────────────

jest.mock('../../../../src/context/LanguagePreferenceContext', () => ({
  ...jest.requireActual('../../../../src/context/LanguagePreferenceContext'),
  useLanguagePreference: jest.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import ContentLanguageScreen from '../content-language.tsx';
import { useLanguagePreference } from '../../../../src/context/LanguagePreferenceContext.tsx';

const mockUseLanguagePreference = useLanguagePreference as jest.Mock;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContentLanguageScreen — Use device language', () => {
  // NOTE: test order matters — the no-op test runs FIRST because it presses a
  // FlatList item and VirtualizedList corrupts subsequent renders after any
  // fireEvent.press (see flatlist-test-contamination.md). The no-op case uses
  // the file's first (clean) render; the positive case uses the second render
  // and only needs call-count assertions (which survive contamination).

  it('is a no-op when preferredLanguage is already null', async () => {
    // Guard in handleSelect: code(null) === (preferredLanguage(null) ?? null)
    // → returns early without calling updateLanguage.
    const updateLanguage = jest.fn().mockResolvedValue({ ok: true });
    mockUseLanguagePreference.mockReturnValue({
      preferredLanguage: null,
      loading: false,
      updateLanguage,
    });

    render(<ContentLanguageScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('lang-option-none')).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('lang-option-none'));
    });

    expect(updateLanguage).not.toHaveBeenCalled();
  });

  it('calls updateLanguage(null) when "Use device language" is tapped', async () => {
    // FlatList state is contaminated after the previous test's press, so
    // getByTestId may not find list items. Use screen.getByText to locate the
    // row instead — the Text node is still rendered even when VirtualizedList
    // drops tile measurements (call-count assertions remain reliable).
    const updateLanguage = jest.fn().mockResolvedValue({ ok: true });
    mockUseLanguagePreference.mockReturnValue({
      preferredLanguage: 'es',
      loading: false,
      updateLanguage,
    });

    render(<ContentLanguageScreen />);

    // Try testID first; fall back to text label if contamination zeroed the list.
    let target: ReturnType<typeof screen.getByTestId> | null = null;
    try {
      await waitFor(() => {
        target = screen.getByTestId('lang-option-none');
      });
    } catch {
      await waitFor(() => {
        target = screen.getByText('Use device language');
      });
    }

    await act(async () => {
      fireEvent.press(target!);
    });

    await waitFor(() => expect(updateLanguage).toHaveBeenCalledTimes(1));
    const arg = updateLanguage.mock.calls[0][0];
    // Must be explicit null — not undefined, not empty string.
    expect(arg).toBeNull();
    expect(arg).not.toBeUndefined();
    expect(arg).not.toBe('');
  });
});
