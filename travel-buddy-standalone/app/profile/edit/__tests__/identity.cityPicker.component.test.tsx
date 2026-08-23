/**
 * IdentityScreen — Home/Current City picker propagation.
 *
 * Regression test for two Blocker-2 bugs found in profile/edit/identity.tsx:
 *
 * 1. Home City selection used `place.country ?? f.homeCountry` — a picker
 *    result with no country (manual entry, GPS fallback) silently kept
 *    whatever country was already in the form, pairing the newly selected
 *    city with a stale, unrelated country instead of clearing it. Fixed by
 *    routing through the same `normalizeProfileCitySelection` helper
 *    home-base.tsx already uses, which clears to '' instead.
 * 2. The save patch built `form.homeCity.trim() || undefined` — since
 *    JSON.stringify drops `undefined`-valued keys, clearing a city/country
 *    back to empty and saving silently sent no change at all. Fixed by
 *    routing through `buildProfileLocationPatch`, which sends explicit
 *    `null` for a cleared field.
 *
 * Kept as one composite test (see .agents/memory/modal-proxy-mock.md
 * render-count limit) covering: select with country, select with NO country
 * (must not keep the stale one), save payload shape, cancel not persisting,
 * a failed save not showing false success, and reload reflecting the saved
 * city.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import IdentityScreen from '../identity.tsx';
import { getMyProfile, updateMyProfile, checkUsername } from '../../../../src/services/profile.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  // canGoBack: false — after a successful save, useSavedThenBack resets to
  // 'idle' (re-enabling Save) instead of calling router.back(), so this test
  // can make a second edit on the SAME mount. Keeps total render() calls in
  // this file at 2 (see .agents/memory/modal-proxy-mock.md render-count limit).
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) },
  useNavigation: () => ({ addListener: () => jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
  checkUsername: jest.fn(),
}));

// NOTE: intentionally exhaustive: GPS paths are outside this picker/save flow.
jest.mock('../../../../src/services/location', () => ({
  getCurrentGps: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
}));

// NOTE: intentionally exhaustive: location fill is outside this picker/save flow.
jest.mock('../../../../src/services/identityGpsFill', () => ({
  runIdentityGpsFill: jest.fn(),
}));

// NOTE: intentionally exhaustive: the real picker is replaced by raw (unnormalized)
// Place test doubles — including one missing `country`, matching what a
// manual-entry or GPS-fallback selection returns in production — so this test
// exercises IdentityScreen's own normalization, not the picker's.
jest.mock('../../../../src/components/ManualCityPicker', () => ({
  ManualCityPicker: ({
    visible,
    onClose,
    onSelect,
  }: {
    visible?: boolean;
    onClose?: () => void;
    onSelect?: (place: Record<string, unknown>) => void;
  }) => {
    if (!visible) return null;
    const R = require('react');
    const { View, Text, Pressable } = require('react-native');
    const makePlace = (city: string, country: string | null) => ({
      id: `place-${city.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'city',
      name: city,
      displayName: country ? `${city}, ${country}` : city,
      city,
      country,
      countryCode: null,
      region: null,
      district: null,
      lat: null,
      lng: null,
      timezone: null,
      source: country ? 'canonical' : 'manual',
    });
    const choice = (label: string, city: string, country: string | null) => R.createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: label,
        onPress: () => onSelect?.(makePlace(city, country)),
      },
      R.createElement(Text, null, label),
    );
    return R.createElement(
      View,
      null,
      choice('Choose Cebu City', 'Cebu City', 'Philippines'),
      choice('Choose Tokyo', 'Tokyo', 'Japan'),
      // No country returned — the manual/GPS-fallback shape that exposed the bug.
      choice('Choose Unresolved City', 'Unresolved City', null),
      R.createElement(
        Pressable,
        { accessibilityRole: 'button', accessibilityLabel: 'Cancel city picker', onPress: onClose },
        R.createElement(Text, null, 'Cancel city picker'),
      ),
    );
  },
}));

const mockGetMyProfile = getMyProfile as jest.Mock;
const mockUpdateMyProfile = updateMyProfile as jest.Mock;
const mockCheckUsername = checkUsername as jest.Mock;

function profile(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe('IdentityScreen — city picker propagation', () => {
  it('normalizes selection, blocks stale country carryover, saves the correct payload, and reflects a reload', async () => {
    mockCheckUsername.mockResolvedValue({ available: true });
    mockGetMyProfile.mockResolvedValueOnce({ ok: true, data: profile() });

    // ── Mount 1: empty profile — cancel, then select+save a city WITH a country ──
    await render(<IdentityScreen />);
    await waitFor(() => expect(screen.getByText('Tap to select — or use GPS below')).toBeTruthy());

    // Cancel does not persist anything.
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel city picker' }));
    });
    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
    expect(screen.getByText('Tap to select — or use GPS below')).toBeTruthy();

    // Select a city that HAS a country, and save it — this becomes the
    // persisted baseline that the next selection must overwrite rather than
    // blend with.
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose Cebu City' }));
    });
    expect(screen.getByText('Cebu City')).toBeTruthy();
    expect(screen.getByText('Philippines')).toBeTruthy();

    mockUpdateMyProfile.mockResolvedValueOnce({
      ok: true,
      data: profile({ homeCity: 'Cebu City', homeCountry: 'Philippines' }),
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenNthCalledWith(1, { homeCity: 'Cebu City', homeCountry: 'Philippines' }));
    // useSavedThenBack holds Save disabled in the 'saved' state for 900ms,
    // then — since canGoBack() is false here — resets to 'idle' instead of
    // calling router.back(), re-enabling Save for the next edit without
    // needing to unmount/remount this screen.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 950));
    });

    // Re-selecting with a place that has NO country must clear the country,
    // not silently keep Cebu's "Philippines" paired with the new city.
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose Unresolved City' }));
    });
    expect(screen.getByText('Unresolved City')).toBeTruthy();
    expect(screen.queryByText('Philippines')).toBeNull();
    expect(screen.getByText('Auto-filled from city selection above')).toBeTruthy();

    // Pick current city too, then save. Failed save must not show false success.
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose current city from list' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose Tokyo' }));
    });

    mockUpdateMyProfile.mockResolvedValueOnce({ ok: false, data: null, message: 'Could not save profile' });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    });
    // The cleared country must be sent as an explicit `null`, not omitted —
    // omitting it (the old `|| undefined` behavior) would leave "Philippines"
    // on the server paired with the new "Unresolved City".
    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenNthCalledWith(2, {
      homeCity: 'Unresolved City',
      homeCountry: null,
      currentCity: 'Tokyo',
    }));
    await waitFor(() => expect(screen.getByText('Could not save profile')).toBeTruthy());
    // Still showing the unsaved (not falsely "saved") local selection.
    expect(screen.getByText('Unresolved City')).toBeTruthy();

    // Retry succeeds.
    const saved = profile({ homeCity: 'Unresolved City', homeCountry: null, currentCity: 'Tokyo' });
    mockUpdateMyProfile.mockResolvedValueOnce({ ok: true, data: saved });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenCalledTimes(3));

    // ── Mount 2: a fresh reload reflects server truth — proving the ──
    // selection reached persistence and round-tripped back, not just local
    // component state.
    mockGetMyProfile.mockResolvedValueOnce({ ok: true, data: saved });
    await render(<IdentityScreen />);
    await waitFor(() => expect(screen.getAllByText('Unresolved City').length).toBeGreaterThan(0));
    // Current City is a live-editable TextField, not static text.
    expect(screen.getByDisplayValue('Tokyo')).toBeTruthy();
  });
});
