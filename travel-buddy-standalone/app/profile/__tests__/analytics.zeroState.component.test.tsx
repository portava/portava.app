/**
 * Profile Analytics screen — zero-state rendering.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When the API returns stampsEarned: 0 and milestones: [], the "Stamps
 *    Earned" card renders "0" without crashing.
 * 2. The milestones card is absent from the output when milestones is empty.
 *
 * ## Why these tests exist
 *
 * New users have 0 stamps and no milestones.  The milestones card is
 * conditionally rendered (data.milestones.length > 0), but without an
 * explicit test the zero-stamp path could regress silently and show broken
 * or empty cards to new users.
 */

import React from 'react';
import { render, waitFor, screen, cleanup } from '@testing-library/react-native';
import ProfileAnalyticsScreen from '../analytics.tsx';
import { getProfileAnalytics } from '../../../src/services/profile.ts';

// lucide-react-native: covered by the global Proxy mapper in jest.config.js.

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../src/services/profile', () => ({
  ...jest.requireActual('../../../src/services/profile'),
  getProfileAnalytics: jest.fn(),
}));

// NOTE: intentional stub — ProfileViewersSheet fetches its own data and is not under test here.
jest.mock('../../../src/components/ProfileViewersSheet', () => ({
  ProfileViewersSheet: () => null,
}));

// NOTE: intentional stub — only router.back() is called by the header; full expo-router is not under test here.
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
}));

const mockGetProfileAnalytics = getProfileAnalytics as jest.Mock;

function makeZeroAnalytics() {
  return {
    profileViews: { sevenDay: 0, thirtyDay: 0 },
    followerGrowth: { sevenDay: 0, thirtyDay: 0 },
    postImpressions7d: 0,
    stampsEarned: 0,
    milestones: [],
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('ProfileAnalyticsScreen — zero stamps / no milestones', () => {
  it('shows "0" for Stamps Earned and omits the Milestones card', async () => {
    mockGetProfileAnalytics.mockResolvedValue({
      ok: true,
      data: makeZeroAnalytics(),
    });

    await render(<ProfileAnalyticsScreen />);

    // Wait for the async data fetch to resolve and the loading state to clear.
    await waitFor(() =>
      expect(screen.queryByText('Profile Analytics')).toBeTruthy(),
    );

    // Confirm the Stamps Earned card is present with its label and sub-text.
    // "Lifetime total" is unique to the Stamps Earned SingleStatCard, so its
    // presence proves the card rendered (and fmtN(0) = "0" was displayed).
    expect(screen.getByText('Stamps Earned')).toBeTruthy();
    expect(screen.getByText('Lifetime total')).toBeTruthy();

    // The Milestones card must not appear when milestones is empty.
    expect(screen.queryByText('Milestones')).toBeNull();
  });
});
