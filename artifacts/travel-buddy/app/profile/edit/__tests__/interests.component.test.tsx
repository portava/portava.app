/**
 * InterestsScreen — dirty/save/guard tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Save button is disabled until an interest chip is toggled.
 * 2. A successful updateMyProfile (ok: true) calls updateMyProfile with the
 *    updated interests array and transitions the SaveBar to the 'Saved' state.
 * 3. Toggling a chip (making the form dirty) triggers the unsaved-change guard
 *    when the user tries to navigate away — Alert.alert fires with
 *    'Discard changes?'.
 *
 * ## Why these tests exist
 *
 * interests.tsx uses useUnsavedGuard + useSavedThenBack with a ChipGrid.
 * These tests confirm the dirty/clean state drives the SaveBar correctly,
 * that a successful save reaches the 'Saved' state, and that the beforeRemove
 * guard fires when there are unsaved changes.
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
import { Alert } from 'react-native';
import InterestsScreen from '../interests.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';

// ── expo-router ───────────────────────────────────────────────────────────────

// Capture the beforeRemove handler so the guard test can trigger it directly.
let capturedBeforeRemoveHandler: ((e: { preventDefault: () => void; data: { action: object } }) => void) | null = null;

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useNavigation: () => ({
    addListener: (event: string, handler: (e: any) => void) => {
      if (event === 'beforeRemove') capturedBeforeRemoveHandler = handler;
      return jest.fn();
    },
  }),
}));

// ── react-native-safe-area-context ────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── profile service ───────────────────────────────────────────────────────────

jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
}));

const mockGetMyProfile = getMyProfile as jest.Mock;
const mockUpdateMyProfile = updateMyProfile as jest.Mock;

// ── KeyboardSafeView — not under test ────────────────────────────────────────

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

// NOTE: exhaustive stub — useBottomInset imports native inset hooks that are
// unavailable in jest-expo JSDOM; only PlainBottomFiller is used by SettingsUI.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    handle: 'traveler',
    username: 'traveler',
    interests: ['food'],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  capturedBeforeRemoveHandler = null;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InterestsScreen — dirty/save/guard', () => {
  it('save button is disabled before any chip is toggled', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });

    await act(async () => { render(<InterestsScreen />); });

    // Wait for chips to appear.
    await waitFor(() => expect(screen.getByText('Photography')).toBeTruthy());

    // Pressing save with no change must not reach updateMyProfile.
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });

    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
  });

  it('a successful save calls updateMyProfile and transitions the bar to Saved', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });
    mockUpdateMyProfile.mockResolvedValue({
      ok: true,
      data: makeProfile({ interests: ['food', 'photography'] }),
    });

    await act(async () => { render(<InterestsScreen />); });

    await waitFor(() => expect(screen.getByText('Photography')).toBeTruthy());

    // Toggle Photography — form is now dirty.
    await act(async () => { fireEvent.press(screen.getByText('Photography')); });

    // Press save.
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });

    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateMyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ interests: expect.any(Array) }),
    );

    // Bar transitions to 'Saved'.
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  });

  it('toggling a chip marks the form dirty and the guard fires on back-navigation', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await act(async () => { render(<InterestsScreen />); });

    await waitFor(() => expect(screen.getByText('Photography')).toBeTruthy());

    // Toggle Photography — form becomes dirty.
    await act(async () => { fireEvent.press(screen.getByText('Photography')); });

    // The guard handler must have been registered.
    expect(capturedBeforeRemoveHandler).not.toBeNull();

    // Simulate a back-navigation attempt with unsaved changes.
    act(() => {
      capturedBeforeRemoveHandler!({ preventDefault: jest.fn(), data: { action: {} } });
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Discard changes?',
      expect.any(String),
      expect.any(Array),
    );

    alertSpy.mockRestore();
  });
});
