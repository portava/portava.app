/**
 * Profile Analytics screen — error and success rendering.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When getProfileAnalytics rejects (network throw), the error text and
 *    "Try again" button render — not a blank screen.
 * 2. When getProfileAnalytics returns { ok: false }, the error message and
 *    retry button also render.
 * 3. When getProfileAnalytics returns { ok: true }, at least one stat value
 *    renders.
 *
 * ## Why these tests exist
 *
 * The error branch was not previously covered; a silent regression would leave
 * users staring at a blank screen instead of seeing a recoverable error state.
 */

import React from 'react';
import { render, waitFor, screen, cleanup } from '@testing-library/react-native';
import ProfileAnalyticsScreen from '../analytics.tsx';
import { getProfileAnalytics } from '../../../src/services/profile.ts';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { back: jest.fn() },
}));

jest.mock('../../../src/services/profile', () => ({
  ...jest.requireActual('../../../src/services/profile'),
  getProfileAnalytics: jest.fn(),
}));

// NOTE: ProfileViewersSheet pulls in fetchProfileViewers + its own insets;
// stub it out to keep the analytics tests self-contained.
jest.mock('../../../src/components/ProfileViewersSheet', () => ({
  ProfileViewersSheet: () => null,
}));

const mockGetProfileAnalytics = getProfileAnalytics as jest.Mock;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('ProfileAnalyticsScreen — error state', () => {
  it('shows error text and retry button when the API call rejects', async () => {
    mockGetProfileAnalytics.mockRejectedValue(new Error('Network unavailable'));

    await render(<ProfileAnalyticsScreen />);

    await waitFor(() =>
      expect(screen.getByText('Could not load analytics')).toBeTruthy(),
    );
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('shows error text and retry button when the API returns ok: false', async () => {
    mockGetProfileAnalytics.mockResolvedValue({
      ok: false,
      data: null,
      message: 'Analytics unavailable',
    });

    await render(<ProfileAnalyticsScreen />);

    await waitFor(() =>
      expect(screen.getByText('Analytics unavailable')).toBeTruthy(),
    );
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});

describe('ProfileAnalyticsScreen — success state', () => {
  it('renders stat values when the API call succeeds', async () => {
    mockGetProfileAnalytics.mockResolvedValue({
      ok: true,
      data: {
        profileViews: { sevenDay: 42, thirtyDay: 180 },
        followerGrowth: { sevenDay: 5, thirtyDay: 23 },
        postImpressions7d: 1500,
        stampsEarned: 8,
        milestones: [],
      },
    });

    await render(<ProfileAnalyticsScreen />);

    // At least one numeric value from the payload should appear.
    await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
    expect(screen.getByText('1.5K')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
  });
});
