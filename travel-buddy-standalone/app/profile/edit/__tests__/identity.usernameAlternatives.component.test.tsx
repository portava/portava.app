/**
 * IdentityScreen — §23 username alternatives (census row G147).
 *
 * Run with: pnpm test:component
 *
 * ## Why this test exists
 *
 * §23's row is "Username unavailable → immediate non-blocking state PLUS
 * alternatives". The census recorded the second half as absent: the field said
 * "Username is already taken" and stopped, so the user guessed the next handle
 * one round trip at a time.
 *
 * This is the LIVE surface — app/profile/edit/identity.tsx is one of the two
 * username entry points the app ships — so it is where the requirement is
 * either met or not. It asserts the whole path the user walks:
 *
 *   1. a taken handle still produces the non-blocking "taken" state, AND
 *   2. the free handles the server checked are rendered as tappable offers, AND
 *   3. tapping one puts it in the field and re-runs the availability check,
 *      landing on "available" — the offer is a route out, not decoration.
 *
 * Before the change there was no `alternatives` anywhere on this path, so
 * assertions 2 and 3 could not be written: `getByLabelText('Use the username …')`
 * had nothing to find.
 *
 * MUTATION-PROOF: delete `setUsernameAlternatives(interpreted.alternatives)` in
 * identity.tsx's debounced handler and case 2 goes RED — the state the chips
 * render from is never populated, so the screen falls back to the bare message.
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
import IdentityScreen from '../identity.tsx';
import { getMyProfile, checkUsername } from '../../../../src/services/profile.ts';

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useNavigation: () => ({ addListener: () => jest.fn() }),
}));

// ── react-native-safe-area-context ────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── profile service — only the three calls this screen makes ──────────────────

jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
  checkUsername: jest.fn(),
}));

// ── location / GPS services — not under test ──────────────────────────────────

// NOTE: exhaustive stub — both exports are async native calls with no JSDOM
// equivalent; the screen mounts but this test never touches the GPS buttons.
jest.mock('../../../../src/services/location', () => ({
  getCurrentGps: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
}));

// NOTE: exhaustive stub — runIdentityGpsFill wraps GPS + geocode and is never
// triggered here.
jest.mock('../../../../src/services/identityGpsFill', () => ({
  runIdentityGpsFill: jest.fn(),
}));

// ── ManualCityPicker — not under test ────────────────────────────────────────

// NOTE: exhaustive stub — it renders a heavy GlobalPlacePicker modal; null keeps
// the render tree to the username field this test reads.
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

// NOTE: exhaustive stub — it imports native inset hooks unavailable in
// jest-expo JSDOM; only PlainBottomFiller is used by SettingsUI.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

const mockGetMyProfile = getMyProfile as jest.Mock;
const mockCheckUsername = checkUsername as jest.Mock;

/** Walk the debounced availability check (500 ms) forward. */
async function settleDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(600);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGetMyProfile.mockResolvedValue({
    ok: true,
    data: {
      id: 'user-1',
      handle: 'traveler',
      username: 'traveler',
      displayName: 'Traveler',
      bio: '',
      dateOfBirth: null,
      homeCity: null,
      homeCountry: null,
      currentCity: null,
      spokenLanguages: [],
    },
  });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('IdentityScreen — §23: a taken username is answered with alternatives', () => {
  it('renders the taken state AND the free handles the server checked', async () => {
    mockCheckUsername.mockResolvedValue({
      available: false,
      reason: 'Username is already taken',
      alternatives: ['maya_torres1', 'maya_torres2'],
    });

    await act(async () => { render(<IdentityScreen />); });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeTruthy());
    const input = screen.getByPlaceholderText('username');

    await act(async () => { fireEvent.changeText(input, 'maya_torres'); });
    await settleDebounce();

    // 1. The non-blocking state is unchanged.
    expect(screen.getByText('Username is already taken')).toBeTruthy();
    // 2. …and it now comes with somewhere to go.
    expect(screen.getByLabelText('Use the username maya_torres1')).toBeTruthy();
    expect(screen.getByLabelText('Use the username maya_torres2')).toBeTruthy();
  });

  it('tapping an alternative fills the field and re-checks it', async () => {
    mockCheckUsername
      .mockResolvedValueOnce({
        available: false,
        reason: 'Username is already taken',
        alternatives: ['maya_torres1'],
      })
      .mockResolvedValue({ available: true });

    await act(async () => { render(<IdentityScreen />); });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeTruthy());
    const input = screen.getByPlaceholderText('username');

    await act(async () => { fireEvent.changeText(input, 'maya_torres'); });
    await settleDebounce();

    await act(async () => { fireEvent.press(screen.getByLabelText('Use the username maya_torres1')); });
    await settleDebounce();

    expect(input.props.value).toBe('maya_torres1');
    expect(mockCheckUsername).toHaveBeenLastCalledWith('maya_torres1');
    // The offer resolved the problem rather than restating it.
    expect(screen.queryByText('Username is already taken')).toBeNull();
    expect(screen.queryByLabelText('Use the username maya_torres1')).toBeNull();
  });

  it('an available handle is offered no alternatives', async () => {
    mockCheckUsername.mockResolvedValue({ available: true });

    await act(async () => { render(<IdentityScreen />); });
    await waitFor(() => expect(screen.getByPlaceholderText('username')).toBeTruthy());
    const input = screen.getByPlaceholderText('username');

    await act(async () => { fireEvent.changeText(input, 'brandnewname'); });
    await settleDebounce();

    expect(screen.queryByLabelText(/^Use the username /)).toBeNull();
  });
});
