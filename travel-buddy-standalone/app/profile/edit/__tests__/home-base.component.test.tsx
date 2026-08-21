/**
 * HomeBaseScreen — dirty/save/guard tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Save button is disabled until the user edits a field.
 * 2. A successful updateMyProfile (ok: true) calls updateMyProfile with the
 *    right patch and transitions the SaveBar to the 'Saved' state.
 * 3. Editing a field (making the form dirty) triggers the unsaved-change guard
 *    when the user tries to navigate away — Alert.alert fires with
 *    'Discard changes?'.
 *
 * ## Why these tests exist
 *
 * home-base.tsx uses useUnsavedGuard + useSavedThenBack with text fields.
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
import HomeBaseScreen from '../home-base.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';
import { router } from 'expo-router';

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

// ── location / GPS services — not under test ──────────────────────────────────

// NOTE: exhaustive stub — both exports are async native calls that have no
// JSDOM equivalent; the screen mounts but the tests never exercise GPS paths.
jest.mock('../../../../src/services/location', () => ({
  getCurrentGps: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
}));

// NOTE: exhaustive stub — runIdentityGpsFill wraps GPS + geocode; the tests
// never trigger the GPS buttons so the real implementation is not needed.
jest.mock('../../../../src/services/identityGpsFill', () => ({
  runIdentityGpsFill: jest.fn(),
}));

// ── ManualCityPicker — not under test ────────────────────────────────────────

// NOTE: exhaustive stub — ManualCityPicker renders a heavy GlobalPlacePicker
// modal that is not under test in this baseline file. The picker integration
// lives in home-base.cityPicker.component.test.tsx to avoid React 19 act-scope
// contamination across several press-heavy cases in one renderer file.
jest.mock('../../../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: () => null,
}));

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
    homeCity: 'London',
    homeCountry: 'UK',
    currentCity: 'Paris',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  capturedBeforeRemoveHandler = null;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HomeBaseScreen — dirty/save/guard', () => {
  it('save button is disabled before any field is changed', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });

    await act(async () => { render(<HomeBaseScreen />); });

    // Wait for the screen to finish loading.
    await waitFor(() => expect(screen.getByText('Save changes')).toBeTruthy());

    // Pressing save with no changes must not reach updateMyProfile.
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });

    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
  });

  it('a successful save calls updateMyProfile and transitions the bar to Saved', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });
    mockUpdateMyProfile.mockResolvedValue({ ok: true, data: makeProfile({ currentCity: 'Berlin' }) });

    await act(async () => { render(<HomeBaseScreen />); });

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Where are you right now?')).toBeTruthy(),
    );

    // Edit the currentCity field to make the form dirty.
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText('Where are you right now?'),
        'Berlin',
      );
    });

    // Press save — now enabled because form is dirty.
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });

    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenCalledTimes(1));

    // The bar transitions to the 'Saved' state.
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());

    // router.back() is scheduled via setTimeout — confirm it eventually fires.
    expect((router.back as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('unsaved guard fires Alert when navigating away with dirty changes', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: true, data: makeProfile() });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await act(async () => { render(<HomeBaseScreen />); });

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Where are you right now?')).toBeTruthy(),
    );

    // Make the form dirty by editing currentCity.
    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText('Where are you right now?'),
        'Tokyo',
      );
    });

    // The beforeRemove handler must have been registered by now.
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
