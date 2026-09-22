/**
 * SafetyVerificationScreen — Trust Score sheet open/close tests.
 *
 * ## What's covered
 *
 * 1. Tapping the Trust row sets the sheet visible — "Trust Score" title appears.
 * 2. Tapping the X (close) button hides the sheet.
 * 3. Tapping the backdrop also hides the sheet.
 * 4. When trustScoreBreakdown is null the sheet still opens and shows the
 *    explanatory fallback instead of factor rows — and that fallback no longer
 *    asserts a second standing vocabulary.
 *
 *    The fallback used to be a `TierGuide` of five score bands ("80–100 Trusted
 *    Traveler", "60–79 Community Member", …). Those names contradicted the
 *    server's own words for the same scores (`presentationWord` in
 *    artifacts/api-server/src/services/passport/PassportProjectionService.ts:
 *    >=80 Excellent, >=65 Strong, >=50 Established, >=35 Building, else New), so
 *    a 72 was "Strong" to the server and "Community Member" to the guide that
 *    existed to explain it. The band table is gone; the fallback now shows the
 *    basis explanation the app already ships (BASIS_NOTE in
 *    src/features/passport/useTrustProjection.ts). This case asserts the
 *    fallback still renders AND that the contradicting names are absent.
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
    // The SERVER owns the standing word, and for a 72 it returns "Strong"
    // (`presentationWord`, >=65). The fixture used to say "Community Member" —
    // a name from the client-side band table this screen no longer ships.
    trustLabel: 'Strong',
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

  it('shows the explanatory fallback, with no competing band vocabulary, when trustScoreBreakdown is null', async () => {
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

    // Sheet opens on the fallback branch, not the factor-breakdown branch.
    await waitFor(() => expect(screen.getByText('Trust Score')).toBeTruthy());
    expect(screen.queryByText('HOW YOUR SCORE IS CALCULATED')).toBeNull();

    // The fallback still EXPLAINS the score — what it is, and what a standing
    // rests on when it is not a direct measurement.
    expect(screen.getByText('HOW IT WORKS')).toBeTruthy();
    expect(
      screen.getByText(/ID verification, passport stamps, account age/),
    ).toBeTruthy();
    expect(screen.getByText('WHAT A STANDING RESTS ON')).toBeTruthy();
    expect(
      screen.getByText('Not yet measured — shown at the neutral starting point.'),
    ).toBeTruthy();

    // The server's word for this profile is what the person reads (it appears
    // both on the Trust row behind the sheet and in the sheet's score pill)...
    expect(screen.getAllByText(/Strong/).length).toBeGreaterThan(0);

    // ...and nothing on the sheet offers a competing name. The removed band
    // table would have printed "Community Member" for this same 72.
    for (const band of [
      'Trusted Traveler',
      'Community Member',
      'Growing Traveler',
      'New Explorer',
      'Getting Started',
    ]) {
      expect(screen.queryByText(band)).toBeNull();
    }
    for (const range of ['80–100', '60–79', '40–59', '20–39', '0–19']) {
      expect(screen.queryByText(range)).toBeNull();
    }
  });
});
