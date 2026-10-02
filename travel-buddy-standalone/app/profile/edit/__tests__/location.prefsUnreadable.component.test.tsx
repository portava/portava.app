/**
 * Location & Availability — "we could not read your location privacy" tests.
 *
 * ## The defect
 *
 * `getMyLocationPrivacy()` used to resolve to LOCATION_PRIVACY_FALLBACK on
 * every failure path (no token, non-2xx, network throw). The screen cannot
 * distinguish that from a real answer, so a user whose location mode is
 * actually **Off** was shown, in the Location Mode row:
 *
 *     "City only — Only your city is used. Great for discovery without
 *      sharing your neighborhood."
 *
 * plus Safe Return ON, stay-blur ON and trusted-circle OFF — four confident
 * statements about location privacy that the server never made.
 *
 * ## What's covered
 *
 * 1. Unreadable read  -> the Location block renders this screen's own absence
 *    idiom ("Failed to load settings." + Try again) and renders NO switch
 *    positions; in particular the fabricated "City only" mode is absent.
 * 2. Readable read    -> a real answer ("Off") still renders normally and the
 *    absence state is NOT shown. This is the half that catches a fix which
 *    blanks a working feature.
 * 3. Try again        -> retries the read and recovers.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import {
  render, act, waitFor, fireEvent, cleanup, screen,
} from '@testing-library/react-native';
import LocationAvailabilityScreen from '../location.tsx';
import { getMyLocationPrivacy } from '../../../../src/services/map.ts';
import { getCircleSettings } from '../../../../src/services/circle.ts';

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

// ── map service (the unit under test) ─────────────────────────────────────────

jest.mock('../../../../src/services/map', () => ({
  ...jest.requireActual('../../../../src/services/map'),
  getMyLocationPrivacy: jest.fn(),
  updateMyLocationPrivacy: jest.fn(),
}));

// ── circle service — the other half of this screen, held successful so the
//    single "Failed to load settings." string can only come from the Location
//    half we are asserting on. ────────────────────────────────────────────────

jest.mock('../../../../src/services/circle', () => ({
  ...jest.requireActual('../../../../src/services/circle'),
  getCircleSettings: jest.fn(),
  patchCircleSettings: jest.fn(),
  pauseAllCircleSharing: jest.fn(),
}));

// ── session ───────────────────────────────────────────────────────────────────

jest.mock('../../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, configured: true, userId: 'user-1' }),
}));

// ── useBottomInset — not under test ──────────────────────────────────────────

// NOTE: intentionally exhaustive — useBottomInset imports native inset hooks
// unavailable in the jest-expo environment; only these three are referenced by
// SettingsUI and their stubs are safe to hard-code.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
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

const mockGetPrivacy = getMyLocationPrivacy as jest.Mock;
const mockGetCircleSettings = getCircleSettings as jest.Mock;

function circleSettings() {
  return {
    ok: true,
    data: {
      globalEnabled: false,
      visibilityMode: 'status_only',
      tripSharingDefault: 'off',
      eventSharingDefault: 'off',
      isPaused: false,
      pausedUntil: null,
      consentVersion: null,
      consentedAt: null,
      currentConsentVersion: 'v1',
      updatedAt: null,
    },
  };
}

/** A real server answer: this user has location sharing switched OFF. */
function prefsOff() {
  return {
    locationMode: 'off' as const,
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    safeReturnEnabled: false,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
  };
}

beforeEach(() => {
  mockGetCircleSettings.mockResolvedValue(circleSettings());
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('Location & Availability — unreadable location privacy', () => {
  it('renders an absence, not a fabricated "City only", when the read fails', async () => {
    mockGetPrivacy.mockResolvedValue(null);

    await act(async () => {
      render(<LocationAvailabilityScreen />);
    });

    await waitFor(() =>
      expect(screen.queryAllByText('Failed to load settings.').length).toBeGreaterThan(0),
    );

    // The absence idiom this screen already uses for its other half.
    expect(screen.getByText('Location Sharing')).toBeTruthy();
    expect(screen.getByText('Failed to load settings.')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();

    // None of the fabricated statements may be on screen.
    expect(screen.queryByText('City only')).toBeNull();
    expect(
      screen.queryByText(
        'Only your city is used. Great for discovery without sharing your neighborhood.',
      ),
    ).toBeNull();
    expect(screen.queryByText('Safe Return')).toBeNull();
    expect(screen.queryByText('Privacy blur near stays')).toBeNull();
    expect(screen.queryByText('Live share with trusted circle')).toBeNull();
  });

  it('still renders the real answer normally when the read succeeds', async () => {
    mockGetPrivacy.mockResolvedValue(prefsOff());

    await act(async () => {
      render(<LocationAvailabilityScreen />);
    });

    await waitFor(() => expect(screen.getByText('Location Mode')).toBeTruthy());

    // The server's actual answer, rendered as before the fix.
    expect(screen.getByText('Off')).toBeTruthy();
    expect(
      screen.getByText(
        'No location data shared. Discovery and Pulse show destination content only.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Safe Return')).toBeTruthy();
    expect(screen.getByText('Privacy blur near stays')).toBeTruthy();

    // And no absence state anywhere on the screen.
    expect(screen.queryByText('Failed to load settings.')).toBeNull();
  });

  it('recovers when Try again succeeds', async () => {
    mockGetPrivacy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(prefsOff());

    await act(async () => {
      render(<LocationAvailabilityScreen />);
    });

    await waitFor(() => expect(screen.getByText('Failed to load settings.')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });

    await waitFor(() => expect(screen.getByText('Location Mode')).toBeTruthy());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText('Failed to load settings.')).toBeNull();
  });
});
