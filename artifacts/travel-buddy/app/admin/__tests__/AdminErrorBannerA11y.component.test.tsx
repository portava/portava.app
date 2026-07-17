/**
 * Admin screens (gaming flags, trust reviews, trust settings) — error banner
 * screen-reader accessibility.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * When the initial data fetch fails, each screen shows an error banner.
 * These tests assert the banner container carries accessibilityRole="alert"
 * and accessibilityLiveRegion="assertive" so TalkBack/VoiceOver announce the
 * dynamically-appearing error instead of leaving it silent.
 */

import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../src/hooks/useRequireAdmin', () => ({
  ...jest.requireActual('../../../src/hooks/useRequireAdmin'),
  useRequireAdmin: jest.fn(),
}));

jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));

jest.mock('../../../src/services/trustAdmin', () => ({
  ...jest.requireActual('../../../src/services/trustAdmin'),
  fetchGamingFlags: jest.fn(),
  markGamingFlagReviewed: jest.fn(),
  fetchReviews: jest.fn(),
  fetchTrustSettings: jest.fn(),
  updateTrustSetting: jest.fn(),
}));

import {
  fetchGamingFlags,
  fetchReviews,
  fetchTrustSettings,
} from '../../../src/services/trustAdmin';
import GamingFlagsScreen from '../gaming-flags';
import TrustReviewsScreen from '../trust-reviews';
import TrustSettingsScreen from '../trust-settings';

const mockFetchFlags    = fetchGamingFlags as jest.Mock;
const mockFetchReviews  = fetchReviews as jest.Mock;
const mockFetchSettings = fetchTrustSettings as jest.Mock;

function expectAlertBanner(testID: string) {
  const banner = screen.getByTestId(testID);
  expect(banner.props.accessibilityRole).toBe('alert');
  expect(banner.props.accessibilityLiveRegion).toBe('assertive');
}

describe('admin error banners are announced to screen readers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('gaming flags: load-failure banner has alert role + assertive live region', async () => {
    mockFetchFlags.mockRejectedValue(new Error('boom'));
    render(<GamingFlagsScreen />);
    await waitFor(() => expect(screen.getByTestId('gaming-flags-error')).toBeTruthy());
    expectAlertBanner('gaming-flags-error');
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('trust reviews: load-failure banner has alert role + assertive live region', async () => {
    mockFetchReviews.mockRejectedValue(new Error('reviews down'));
    render(<TrustReviewsScreen />);
    await waitFor(() => expect(screen.getByTestId('trust-reviews-error')).toBeTruthy());
    expectAlertBanner('trust-reviews-error');
    expect(screen.getByText('reviews down')).toBeTruthy();
  });

  it('trust settings: load-failure banner has alert role + assertive live region', async () => {
    mockFetchSettings.mockRejectedValue(new Error('settings down'));
    render(<TrustSettingsScreen />);
    await waitFor(() => expect(screen.getByTestId('trust-settings-error')).toBeTruthy());
    expectAlertBanner('trust-settings-error');
    expect(screen.getByText('settings down')).toBeTruthy();
  });
});
