/**
 * Profile Analytics screen — Profile Views card opens / closes ProfileViewersSheet.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. Tapping the Profile Views card (accessibilityLabel "Open profile viewers
 *    list") sets viewersSheetVisible to true, making the sheet content visible.
 * 2. Tapping the close button inside the sheet calls onClose, which sets
 *    viewersSheetVisible back to false and hides the sheet.
 *
 * ## Why these tests exist
 *
 * The Pressable-wrapping-StatCard pattern is the sole trigger for the sheet.
 * A regression (removed Pressable, broken state toggle, wrong prop drilling)
 * would leave the sheet permanently inaccessible with no visible error.
 *
 * ## Modal mock note
 * ProfileViewersSheet renders a react-native <Modal>. Modal's animation
 * lifecycle leaves a floating async act() scope that collides with subsequent
 * explicit act() calls (overlapping act() → actScopeDepth corrupted → state
 * never flushes). We mock Modal as a synchronous View and ActivityIndicator as
 * null to keep the tree deterministic. See memory: modal-proxy-mock.md.
 *
 * ## Two-file rule
 * Only ONE Modal-backed sheet test lives in this file (both open and close are
 * asserted inside a single `it` block). A second independent test would need
 * its own file to avoid RNTL screen-global corruption between renders.
 */

import React from 'react';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/react-native';
import ProfileAnalyticsScreen from '../analytics.tsx';
import { getProfileAnalytics } from '../../../src/services/profile.ts';
import { fetchProfileViewers } from '../../../src/services/postViewers.ts';

// ── Modal Proxy mock ──────────────────────────────────────────────────────────
// NOTE: intentional stub — replaces Modal with a synchronous View so RNTL does
// not leave a floating async act() scope that corrupts subsequent state flushes.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — only router.back() is exercised by the header back button;
// spreading requireActual pulls in the full Expo Router runtime which is not needed here.
jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
}));

jest.mock('../../../src/services/profile', () => ({
  ...jest.requireActual('../../../src/services/profile'),
  getProfileAnalytics: jest.fn(),
}));

jest.mock('../../../src/services/postViewers', () => ({
  ...jest.requireActual('../../../src/services/postViewers'),
  fetchProfileViewers: jest.fn(),
}));

const mockGetProfileAnalytics = getProfileAnalytics as jest.Mock;
const mockFetchProfileViewers = fetchProfileViewers as jest.Mock;

function makeAnalyticsData() {
  return {
    profileViews: { sevenDay: 14, thirtyDay: 60 },
    followerGrowth: { sevenDay: 3, thirtyDay: 18 },
    postImpressions7d: 500,
    stampsEarned: 4,
    milestones: [],
  };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('ProfileAnalyticsScreen — viewers sheet open / close', () => {
  it('opens the sheet when the Profile Views card is tapped and closes it on X', async () => {
    mockGetProfileAnalytics.mockResolvedValue({ ok: true, data: makeAnalyticsData() });
    // Resolve immediately with an empty viewers list so the sheet body is stable.
    mockFetchProfileViewers.mockResolvedValue({ ok: true, data: [] });

    const view = await render(<ProfileAnalyticsScreen />);

    // Wait for the analytics data to load and the screen to render its content.
    await waitFor(() =>
      expect(view.getByText('Profile Views')).toBeTruthy(),
    );

    // The sheet should not be visible yet.
    expect(view.queryByText('Profile viewers · 7 days')).toBeNull();

    // ── Open: tap the Profile Views card ─────────────────────────────────────
    fireEvent.press(view.getByLabelText('Open profile viewers list'));

    // The sheet title is the unique signal that it became visible.
    await waitFor(() =>
      expect(view.getByText('Profile viewers · 7 days')).toBeTruthy(),
    );

    // ── Close: tap the X button inside the sheet ──────────────────────────────
    fireEvent.press(view.getByLabelText('Close profile viewers'));

    // The sheet title must be gone once viewersSheetVisible is false.
    await waitFor(() =>
      expect(view.queryByText('Profile viewers · 7 days')).toBeNull(),
    );
  });
});
