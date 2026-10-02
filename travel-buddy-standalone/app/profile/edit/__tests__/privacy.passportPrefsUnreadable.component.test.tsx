/**
 * Privacy & Visibility — "we could not read your Passport preferences" tests.
 *
 * ## The defect
 *
 * `loadPassport` seeded stampVis/'public', memoryVis/'private', cityMap/true,
 * planStamps/true and passportPublic/true, then overwrote them ONLY if the
 * profile read and the visibility-preferences fetch both succeeded. Every
 * failure path — `!res.ok`, no token, a throw, a failed getMyProfile — left
 * those permissive defaults on screen as if they were the user's settings.
 *
 * That is worse than a wrong display, because the five values are saved as ONE
 * batch. A user who had hidden their city map, tapping the unrelated "Public
 * Passport" switch during a blip, PATCHed `showCityMap: true` back to the
 * server — the failed read became a write, and the real preference was gone.
 *
 * ## What's covered
 *
 * 1. Unreadable prefs -> the Passport block renders this screen's own absence
 *    idiom ("Failed to load settings." + a Try again row) and NONE of the five
 *    controls; the Save bar is not rendered, so nothing can be written back.
 * 2. Unreadable profile -> same, since Public Passport is part of the batch.
 * 3. Readable prefs -> the real values (city map OFF) still render normally and
 *    no absence state appears. This is the half that catches a fix which blanks
 *    a working feature.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import {
  render, act, waitFor, cleanup, screen,
} from '@testing-library/react-native';
import PrivacyVisibilityScreen from '../privacy.tsx';
import { getPrivacySettings, getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';

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

// ── profile service ───────────────────────────────────────────────────────────

jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getPrivacySettings: jest.fn(),
  updatePrivacySettings: jest.fn(),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
}));

// ── session ───────────────────────────────────────────────────────────────────

jest.mock('../../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, configured: true, userId: 'user-1' }),
}));

// ── auth token — the screen uses the shared refresh-first helper ─────────────

jest.mock('../../../../src/services/apiToken', () => ({
  ...jest.requireActual('../../../../src/services/apiToken'),
  freshToken: jest.fn(async () => 'test-token'),
}));

// ── media contributor toggle — flag-gated, not under test ────────────────────

// NOTE: intentionally exhaustive — requireActual would pull in
// FeatureFlagsContext and the view-request service; the module has exactly one
// component export and the screen renders it as a leaf, so a null stub is safe.
jest.mock('../../../../src/features/media/components/ContributorViewOptInToggle', () => ({
  ContributorViewOptInToggle: () => null,
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

const mockGetPrivacySettings = getPrivacySettings as jest.Mock;
const mockGetMyProfile = getMyProfile as jest.Mock;
const mockUpdateMyProfile = updateMyProfile as jest.Mock;

const realFetch = globalThis.fetch;

function privacySettings() {
  return {
    ok: true,
    data: {
      profile_visibility: 'public',
      show_profile_picture_publicly: true,
      show_current_city: true,
      show_home_country: true,
      show_visited_places: true,
      show_upcoming_trips: true,
      show_past_trips: true,
      show_posts: true,
      show_stamps: true,
      show_friends: true,
      show_followers: true,
      show_real_name: true,
      allow_messages_from: 'everyone',
      allow_friend_requests: true,
      allow_follow: true,
      allow_tagging: true,
      allow_profile_discovery: true,
      delayed_posting_default: false,
      precise_location_visible: false,
    },
  };
}

/** Stubs the visibility-preferences fetch. */
function stubPrefsFetch(outcome: { status: number; body?: unknown } | 'throw') {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    if (outcome === 'throw') throw new Error('network down');
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      json: async () => outcome.body ?? {},
    };
  };
}

beforeEach(() => {
  mockGetPrivacySettings.mockResolvedValue(privacySettings());
  mockGetMyProfile.mockResolvedValue({ ok: true, data: { passportVisibility: 'public' } });
});

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  cleanup();
  jest.clearAllMocks();
});

describe('Privacy & Visibility — unreadable Passport preferences', () => {
  it('renders an absence instead of five fabricated switch positions', async () => {
    stubPrefsFetch({ status: 500, body: { error: 'boom' } });

    await act(async () => {
      render(<PrivacyVisibilityScreen />);
    });

    await waitFor(() =>
      expect(screen.queryAllByText('Failed to load settings.').length).toBeGreaterThan(0),
    );

    // The screen's own absence idiom, reused for the Passport block.
    expect(screen.getByText('Passport')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();

    // None of the five batched controls may be shown...
    expect(screen.queryByText('Public Passport')).toBeNull();
    expect(screen.queryByText('Show City Map')).toBeNull();
    expect(screen.queryByText('Show Plan Stamps')).toBeNull();
    expect(screen.queryByText('Default stamp visibility')).toBeNull();
    expect(screen.queryByText('Default memory visibility')).toBeNull();

    // ...and with no Save bar there is no way to write the guesses back.
    expect(screen.queryByText('Save passport settings')).toBeNull();
    expect(mockUpdateMyProfile).not.toHaveBeenCalled();
  });

  it('renders an absence when the profile read fails too (Public Passport is in the same batch)', async () => {
    mockGetMyProfile.mockResolvedValue({ ok: false, data: null });
    stubPrefsFetch({ status: 200, body: { showCityMap: false } });

    await act(async () => {
      render(<PrivacyVisibilityScreen />);
    });

    await waitFor(() =>
      expect(screen.queryAllByText('Failed to load settings.').length).toBeGreaterThan(0),
    );

    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.queryByText('Public Passport')).toBeNull();
    expect(screen.queryByText('Save passport settings')).toBeNull();
  });

  it('still renders the real preferences when the read succeeds', async () => {
    stubPrefsFetch({
      status: 200,
      body: {
        defaultStampVisibility: 'private',
        defaultMemoryVisibility: 'private',
        showCityMap: false,
        showPlanStamps: false,
      },
    });

    await act(async () => {
      render(<PrivacyVisibilityScreen />);
    });

    await waitFor(() => expect(screen.getByText('Public Passport')).toBeTruthy());

    // Every control is back, driven by the server's real answer.
    expect(screen.getByText('Show City Map')).toBeTruthy();
    expect(screen.getByText('Show Plan Stamps')).toBeTruthy();
    expect(screen.getByText('Default stamp visibility')).toBeTruthy();
    expect(screen.getByText('Default memory visibility')).toBeTruthy();
    expect(screen.getByText('Save passport settings')).toBeTruthy();

    // And no absence state anywhere.
    expect(screen.queryByText('Failed to load settings.')).toBeNull();
  });
});
