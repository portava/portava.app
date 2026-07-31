/**
 * SafetyVerificationScreen — Trust Score sheet open/close tests.
 *
 * ## What's covered
 *
 * 1. Tapping the Trust row sets the sheet visible — "Trust Score" title appears.
 * 2. Tapping the X (close) button hides the sheet.
 * 3. Tapping the backdrop also hides the sheet.
 * 4. When trustScoreBreakdown is null the sheet still opens and shows the
 *    tier-guide fallback ("80–100" range row) instead of factor rows.
 *
 * ## Why these tests exist
 *
 * TrustScoreInfoSheet is rendered conditionally (only when profile is loaded).
 * A regression could leave `visible` permanently true (ghost modal) or prevent
 * the sheet from ever opening. These cases confirm both directions.
 *
 * ## Modal strategy
 * TrustScoreInfoSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap — see
 * .agents/memory/modal-proxy-mock.md.
 *
 * Must be declared before any imports that touch react-native.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({
    children,
    visible,
  }: {
    children: React.ReactNode;
    visible: boolean;
  }) => (visible ? R.createElement(actual.View, null, children) : null);
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import {
  render,
  act,
  waitFor,
  fireEvent,
  cleanup,
  screen,
} from '@testing-library/react-native';
import SafetyVerificationScreen from '../safety.tsx';
import { getMyProfile } from '../../../../src/services/profile.ts';

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
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
}));

const mockGetMyProfile = getMyProfile as jest.Mock;

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

// NOTE: intentionally exhaustive — useBottomInset imports native inset hooks
// that are not available in the jest-expo JSDOM environment; only PlainBottomFiller
// is referenced by SettingsUI and its stub is safe to hard-code here.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    handle: 'testuser',
    name: 'Test User',
    displayName: 'Test User',
    username: 'testuser',
    bio: null,
    avatarUrl: null,
    homeCity: null,
    homeCountry: null,
    currentCity: null,
    travelStyle: null,
    travelStyles: [],
    interests: [],
    verified: false,
    verificationStatus: 'unverified' as const,
    verifiedAt: null,
    openToMeet: false,
    isPrivate: false,
    trustScore: 72,
    trustLabel: 'Community Member',
    trustScoreBreakdown: {
      factors: [
        {
          key: 'profile_complete',
          label: 'Profile complete',
          points: 20,
          maxPoints: 20,
          maxed: true,
          hint: null,
        },
        {
          key: 'id_verified',
          label: 'ID verified',
          points: 0,
          maxPoints: 25,
          maxed: false,
          hint: 'Verify your ID to earn more points',
        },
      ],
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SafetyVerificationScreen — Trust Score sheet', () => {
  it('opens the sheet when the Trust row is tapped', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: makeProfile(),
    });

    await act(async () => {
      render(<SafetyVerificationScreen />);
    });

    // Wait for the profile to load and the Trust row to appear.
    await waitFor(() => expect(screen.getByText('Trust')).toBeTruthy());

    // Sheet must not be visible yet.
    expect(screen.queryByText('Trust Score')).toBeNull();

    // Tap the Trust row.
    await act(async () => {
      fireEvent.press(screen.getByText('Trust'));
    });

    // Sheet header should now be visible.
    await waitFor(() => expect(screen.getByText('Trust Score')).toBeTruthy());
  });

  it('closes the sheet when the X button is pressed', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: makeProfile(),
    });

    await act(async () => {
      render(<SafetyVerificationScreen />);
    });

    await waitFor(() => expect(screen.getByText('Trust')).toBeTruthy());

    // Open the sheet.
    await act(async () => {
      fireEvent.press(screen.getByText('Trust'));
    });
    await waitFor(() => expect(screen.getByText('Trust Score')).toBeTruthy());

    // Press the close (X) button.
    await act(async () => {
      fireEvent.press(screen.getByTestId('trust-sheet-close'));
    });

    // Sheet must be gone — no ghost modal.
    await waitFor(() => expect(screen.queryByText('Trust Score')).toBeNull());
  });

  it('closes the sheet when the backdrop is pressed', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: makeProfile(),
    });

    await act(async () => {
      render(<SafetyVerificationScreen />);
    });

    await waitFor(() => expect(screen.getByText('Trust')).toBeTruthy());

    // Open the sheet.
    await act(async () => {
      fireEvent.press(screen.getByText('Trust'));
    });
    await waitFor(() => expect(screen.getByText('Trust Score')).toBeTruthy());

    // Press the backdrop.
    await act(async () => {
      fireEvent.press(screen.getByTestId('trust-sheet-backdrop'));
    });

    // Sheet must be gone — no ghost modal.
    await waitFor(() => expect(screen.queryByText('Trust Score')).toBeNull());
  });

  it('shows the tier-guide fallback when trustScoreBreakdown is null', async () => {
    mockGetMyProfile.mockResolvedValue({
      ok: true,
      data: makeProfile({ trustScoreBreakdown: null }),
    });

    await act(async () => {
      render(<SafetyVerificationScreen />);
    });

    await waitFor(() => expect(screen.getByText('Trust')).toBeTruthy());

    // Open the sheet.
    await act(async () => {
      fireEvent.press(screen.getByText('Trust'));
    });

    // Sheet opens and shows the tier-guide rows.
    await waitFor(() => expect(screen.getByText('Trust Score')).toBeTruthy());
    expect(screen.getByText('80–100')).toBeTruthy();
    expect(screen.getByText('Trusted Traveler')).toBeTruthy();
  });
});
