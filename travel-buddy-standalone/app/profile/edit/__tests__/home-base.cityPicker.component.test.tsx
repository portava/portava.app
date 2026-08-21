/**
 * HomeBaseScreen — real picker callback through save, retry, reload, and replace.
 *
 * Kept as one composite test because React 19 + RNTL can lose later effect
 * commits when several press-heavy tests share one renderer file.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import HomeBaseScreen from '../home-base.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
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

// NOTE: intentionally exhaustive: the real picker is replaced by a canonical Place test double.
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
    const makePlace = (city: string, country: string) => ({
      id: `canonical-${city.toLowerCase().replace(/\s+/g, '-')}`,
      canonicalId: `canonical-${city.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'city',
      name: city,
      displayName: `${city}, ${country}`,
      city,
      country,
      countryCode: null,
      region: null,
      district: null,
      lat: null,
      lng: null,
      timezone: null,
      source: 'canonical',
    });
    const choice = (city: string, country: string) => R.createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: `Choose ${city}`,
        onPress: () => onSelect?.(makePlace(city, country)),
      },
      R.createElement(Text, null, `Choose ${city}`),
    );
    return R.createElement(
      View,
      null,
      choice('Cebu City', 'Philippines'),
      choice('Tokyo', 'Japan'),
      R.createElement(
        Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Cancel city picker',
          onPress: onClose,
        },
        R.createElement(Text, null, 'Cancel city picker'),
      ),
    );
  },
}));

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

// NOTE: intentionally exhaustive: layout inset behavior is outside this profile persistence flow.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

const mockGetMyProfile = getMyProfile as jest.Mock;
const mockUpdateMyProfile = updateMyProfile as jest.Mock;

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    handle: 'traveler',
    username: 'traveler',
    homeCity: null,
    homeCountry: null,
    currentCity: null,
    ...overrides,
  };
}

describe('HomeBaseScreen — canonical city picker flow', () => {
  it('cancels safely, retries a failed save, reloads the saved city, and replaces it', async () => {
    const cebu = profile({ homeCity: 'Cebu City', homeCountry: 'Philippines' });
    const tokyo = profile({ homeCity: 'Tokyo', homeCountry: 'Japan' });
    let resolveFirstSave: ((value: {
      ok: false;
      data: null;
      message: string;
    }) => void) | null = null;
    const firstSave = new Promise<{
      ok: false;
      data: null;
      message: string;
    }>((resolve) => {
      resolveFirstSave = resolve;
    });
    mockGetMyProfile
      .mockResolvedValueOnce({ ok: true, data: profile() })
      .mockResolvedValueOnce({ ok: true, data: cebu });
    mockUpdateMyProfile
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce({ ok: true, data: cebu })
      .mockResolvedValueOnce({ ok: true, data: tokyo });

    const first = await render(<HomeBaseScreen />);
    await waitFor(() => expect(screen.getByText('Tap to select — or use GPS below')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel city picker' }));
    });
    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
    expect(screen.getByText('Tap to select — or use GPS below')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose Cebu City' }));
    });
    expect(screen.getByText('Cebu City')).toBeTruthy();
    expect(screen.getByText('Philippines')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Save changes'));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Select home city' }).props.accessibilityState)
        .toEqual(expect.objectContaining({ disabled: true }));
    });
    expect(screen.getByPlaceholderText('Where are you right now?').props.editable).toBe(false);

    // A delayed response must not be able to overwrite a newer picker edit:
    // all field mutation entry points stay locked until the request settles.
    fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    expect(screen.queryByRole('button', { name: 'Choose Tokyo' })).toBeNull();

    await act(async () => {
      resolveFirstSave?.({ ok: false, data: null, message: 'Could not save city' });
      await firstSave;
    });
    await waitFor(() => expect(screen.getByText('Could not save city')).toBeTruthy());
    expect(screen.getByText('Cebu City')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Retry'));
    });
    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenNthCalledWith(2, {
      homeCity: 'Cebu City',
      homeCountry: 'Philippines',
    }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());

    await first.unmount();
    await render(<HomeBaseScreen />);
    await waitFor(() => expect(screen.getByText('Cebu City')).toBeTruthy());
    expect(screen.getByText('Philippines')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Select home city' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Choose Tokyo' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save changes'));
    });

    await waitFor(() => expect(mockUpdateMyProfile).toHaveBeenNthCalledWith(3, {
      homeCity: 'Tokyo',
      homeCountry: 'Japan',
    }));
  });
});